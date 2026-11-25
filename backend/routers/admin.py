"""管理端接口：名单、流水、导出、闸门、物料、账号。

由 scripts/split_backend.py 从原 main.py 自动生成。
路径与处理逻辑与原实现完全一致，仅装饰器由 app 改为 router。
"""
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, timedelta, timezone
import os
import re
import hmac
import hashlib
import secrets
import sqlite3
import json

from deps import *  # noqa: F401,F403
# deps.py 没有 __all__，`import *` 会跳过下划线开头的名字，_row_get 必须显式导入。
# 漏了它的后果是 admin_gate_set 一调用就 NameError → 三个开关、报名截止时间、
# 活动结束时间全部保存失败（POST /admin/gate 500），而 GET 正常，很容易误判成前端问题。
from deps import _row_get  # noqa: F401
from deps import _bgm_remove_file  # noqa: F401  同上：背景音乐上传/重置会用到
from gate import norm_iso  # 写入闸门时间前规范化，避免无时区串毒化 gate_state()
# 闸门配置「每活动一行」，读取统一走 db.gate_config_get，避免三处各写一遍过滤条件
from db import gate_config_get
import activity as actx
import checkin_core
import theme as theme_def
import intro as intro_def
import form
import form_store
import textguard

import domain as domx
import limit
import logx
import orgstate
import orgctx
import riskword

router = APIRouter()




@router.get("/api/admin/staff")
def admin_staff_list(token: str = ""):
    """现场核销人员列表（所有后台角色可管）。

    停用后可删除，但删除是软删除：行留着（deleted_at 标记），历史核销流水
    里记的操作人名字才查得到——真删了，签到流水与导出的「操作人」列就空了。
    """
    require_login(token)
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, username, token, openid, enabled, account_id FROM staff "
        "WHERE deleted_at IS NULL ORDER BY id"
    ).fetchall()
    return {"ok": True, "rows": [{
        "id": r["id"], "username": r["username"], "token": r["token"],
        "openid": r["openid"], "enabled": bool(r["enabled"]),
        "account_id": r["account_id"],
    } for r in rows]}




@router.post("/api/admin/staff")
def admin_staff_create(body: StaffCreateIn):
    """后台新增可辅助签到人员：填账号名即自动生成专属核销凭证。

    所有后台角色可建（现场谁负责核销，值班的人自己就能建，不必等管理员）。
    """
    acc = require_login(body.token)
    username = (body.username or "").strip()
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "账号需为 3—20 位字母、数字或 _ . -")
    # 核销人员账号名会出现在核销流水、导出「操作人」列与签到台界面
    riskword.guard({"工作人员账号": username}, where="staff_create", acc=acc)
    conn = get_conn()
    old = conn.execute("SELECT id, deleted_at FROM staff WHERE username=?", (username,)).fetchone()
    if old and not old["deleted_at"]:
        raise HTTPException(400, "该工作人员已存在")
    tok = secrets.token_hex(16)
    # staff 不是业务流水表，没有 env 列，不能走会自动补 env 的 insert_row
    with transaction() as c:
        if old:
            # 同名且是之前删掉的：直接「复活」——重置凭证、解绑、启用、清删除标记
            c.execute(
                "UPDATE staff SET token=?, enabled=1, openid=NULL, deleted_at=NULL, "
                "account_id=?, created_at=? WHERE id=?",
                (tok, body.account_id, now_iso(), old["id"]),
            )
            sid = old["id"]
        else:
            c.execute(
                "INSERT INTO staff (activity_id, username, token, enabled, openid, account_id, created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (actx.current_id(), username, tok, 1, None, body.account_id, now_iso()),
            )
            row = conn.execute("SELECT id FROM staff WHERE username=?", (username,)).fetchone()
            sid = row["id"]
    write_admin_log("staff_create", "新增现场工作人员 %s" % username, acc["username"])
    # 必须回传 id：后台「生成绑定码」要用它换取一次性绑定码
    return {"ok": True, "id": sid, "token": tok}




@router.post("/api/admin/staff/ticket")
def admin_staff_ticket(body: StaffTicketIn):
    """生成一次性绑定码：工作人员微信扫码后把 openid 绑到该账号（30 分钟有效）。"""
    acc = require_login(body.token)
    conn = get_conn()
    row = conn.execute(
        "SELECT username FROM staff WHERE id=? AND deleted_at IS NULL", (body.id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "工作人员不存在")
    nonce = secrets.token_urlsafe(24)
    exp = (datetime.now(TZ) + timedelta(minutes=30)).isoformat(timespec="seconds")
    with transaction() as c:
        c.execute(
            "INSERT INTO staff_bind_ticket (nonce, staff_id, expires_at, used, created_at) "
            "VALUES (?,?,?,?,?)", (nonce, body.id, exp, 0, now_iso()),
        )
    write_admin_log("staff_ticket", "为 %s 生成微信绑定码" % row["username"], acc["username"])
    return {"ok": True, "ticket": nonce, "expires_at": exp}




@router.post("/api/admin/staff/update")
def admin_staff_update(body: StaffUpdateIn):
    """启停 / 重置凭证 / 解绑微信。停用后该微信立刻不再能进核销界面。"""
    acc = require_login(body.token)
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM staff WHERE id=? AND deleted_at IS NULL", (body.id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "工作人员不存在")
    sets, params, changes = [], [], []
    if body.enabled is not None:
        sets.append("enabled=?"); params.append(1 if body.enabled else 0)
        changes.append("启用" if body.enabled else "停用")
    if body.reset_token:
        sets.append("token=?"); params.append(secrets.token_hex(16))
        changes.append("重置核销凭证")
    if body.unbind:
        sets.append("openid=NULL"); changes.append("解绑微信")
    if sets:
        params.append(body.id)
        with transaction() as c:
            c.execute("UPDATE staff SET %s WHERE id=?" % ",".join(sets), params)
        write_admin_log("staff_update", "%s：%s" % (row["username"], "、".join(changes)),
                        acc["username"])
    new = conn.execute("SELECT token FROM staff WHERE id=?", (body.id,)).fetchone()
    return {"ok": True, "token": new["token"] if new else None}




@router.post("/api/admin/staff/delete")
def admin_staff_delete(body: StaffDeleteIn):
    """删除现场核销人员：必须先停用，删除后凭证立刻失效。

    软删除（deleted_at 标记）而不是真删：历史核销流水记的是 staff_id，
    真删了那些流水的「操作人」列就变成空白，事后追责/对账没了依据。
    同时清掉未用的绑定码，并把核销凭证随机化——旧凭证不能再用。
    """
    acc = require_login(body.token)
    conn = get_conn()
    row = conn.execute("SELECT * FROM staff WHERE id=?", (body.id,)).fetchone()
    if not row:
        raise HTTPException(404, "工作人员不存在")
    if row["deleted_at"]:
        raise HTTPException(400, "该工作人员已删除")
    if row["enabled"]:
        raise HTTPException(400, "只能删除已停用的工作人员，请先停用再删")
    name = row["username"]
    with transaction() as c:
        c.execute(
            "UPDATE staff SET deleted_at=?, enabled=0, openid=NULL, token=? WHERE id=?",
            (now_iso(), secrets.token_hex(16), body.id),
        )
        c.execute("DELETE FROM staff_bind_ticket WHERE staff_id=?", (body.id,))
    write_admin_log("staff_delete", "删除现场工作人员 %s" % name, acc["username"])
    return {"ok": True, "deleted": name}




def _export_layout(activity_id: int) -> list:
    """按活动当前 schema 生成导出列：`(表头, 取值类型, 取值键)`。

    取值类型：id / name / phone / cc / col / field / method / status
    不再硬编码列，是为了让「活动加一个字段，导出自动多一列」成立——
    导出恰好是最容易被忘记同步的地方，硬编码就等于每加字段都要再改一次代码。
    """
    spec = form_store.export_spec(activity_id)
    layout = [("序号", "id", None)]
    for f in spec:
        key, core, ftype = f["key"], f.get("core"), f["type"]
        if ftype == "phone":
            layout.append(("国际区号", "cc", "phone_code"))
            layout.append(("手机号", "phone", None))
        elif core == "name":
            layout.append((f["label"], "name", None))
        elif core:
            # 通用固定列（gender）直接取列；行业字段已不再有 core，会走下面的 field 分支
            layout.append((f["label"], "col", core))
        else:
            layout.append((f["label"], "field", key))
    layout += [
        ("来源渠道", "col", "channel"),
        ("报名时间", "col", "created_at"),
        ("签到方式", "method", "method"),
        ("签到时间", "col", "checked_at"),
        ("状态", "status", None),
    ]
    # G8：活动开了伴手礼才多这一列，没开的机构导出表头保持不变
    import feature as _feature
    if _feature.enabled("gift", activity_id):
        layout.append(("伴手礼", "gift", None))
    return layout


def _export_cell(col, row, answers: dict, full: bool):
    kind, key = col[1], col[2]
    if kind == "id":
        return row["id"]
    if kind == "name":
        return show_name(row["name"], full)
    if kind == "phone":
        return show_phone(row["phone"], full)
    if kind == "cc":
        return "+" + (row["phone_code"] or "86")
    if kind == "method":
        # 这一列是「有没有签到」的状态语义，空着容易被读成数据缺失
        return row["method"] or "未签到"
    if kind == "field":
        return answers.get(key) or ""
    if kind == "status":
        return "已关闭" if (row["status"] or "active") == "closed" else "正常"
    if kind == "gift":
        return row["gift_state"] or "未领"
    return row[key]


@router.get("/api/export")
def export(token: str = ""):
    # 导出按账号权限：现场核销人员（staff token）本身不带后台账号，不具备导出能力
    acc = require_perm(token, "can_export")
    # 有导出权但无「完整信息」权：导出的姓名与手机号一律脱敏，防止靠导出绕过界面限制
    exp_full = bool(acc["can_full_phone"])
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT r.id, r.name, r.phone_code, r.phone, r.gender,
               r.channel, r.created_at, r.status, r.answers,
               (SELECT c.method FROM checkin c
                 WHERE c.registration_id=r.id AND c.checked_at IS NOT NULL
                 ORDER BY c.id DESC LIMIT 1) AS method,
               (SELECT MAX(c.checked_at) FROM checkin c
                 WHERE c.registration_id=r.id AND c.checked_at IS NOT NULL) AS checked_at
        FROM registration r
        WHERE r.is_smoke IS NOT 1
          -- 发布闸门：草稿期的测试数据不进导出。导出的表是直接交给甲方的东西，
          -- 混进测试数据比统计里多几个人严重得多。closed 照旧导出（那是真实关闭记录）。
          AND COALESCE(r.status, 'active') <> 'draft'
          AND COALESCE(r.status, 'active') <> 'draft'
        ORDER BY r.id
        """
    ).fetchall()

    # 列由活动 schema 生成：同一套后端，换一份 schema 就是另一套导出表头
    aid = actx.current_id()
    layout = _export_layout(aid)
    lines = [",".join(c[0] for c in layout)]
    gift_map = None
    if any(c[1] == "gift" for c in layout):
        gift_map = {}
        for c0 in conn.execute(
            "SELECT registration_id, status, issued_at FROM gift_claim WHERE activity_id=?",
            (aid,),
        ).fetchall():
            label = ("已领 " + str(c0["issued_at"])[:16]) if c0["status"] == "issued" \
                    else "未领（已撤销）"
            if c0["registration_id"] not in gift_map or c0["status"] == "issued":
                gift_map[c0["registration_id"]] = label

    # CSV 简单转义
    def esc(v):
        s = "" if v is None else str(v)
        if "," in s or '"' in s or "\n" in s:
            s = '"' + s.replace('"', '""') + '"'
        return s

    for raw in rows:
        r = dict(raw)
        if gift_map is not None:
            r["gift_state"] = gift_map.get(r["id"], "未领")
        try:
            answers = json.loads(r["answers"]) if r["answers"] else {}
        except (TypeError, ValueError):
            answers = {}
        lines.append(",".join(esc(_export_cell(c, r, answers, exp_full)) for c in layout))
    csv_text = "\n".join(lines) + "\n"
    with transaction() as c:
        insert_row(c, "export_log", {
            "operator": acc["username"],
            "row_count": len(rows),
            "created_at": now_iso(),
        })
    write_admin_log("export", "导出报名明细 %d 行" % len(rows), acc["username"])
    return PlainTextResponse(
        csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=meeting_registration.csv"},
    )




@router.get("/api/stats")
def stats(token: str = ""):
    """签到统计（管理后台用，需登录）。"""
    require_login(token)
    conn = get_conn()
    total = conn.execute(
        "SELECT COUNT(*) FROM registration WHERE is_smoke IS NOT 1 AND status='active'"
    ).fetchone()[0]
    checked = conn.execute(
        "SELECT COUNT(DISTINCT c.registration_id) FROM checkin c "
        "JOIN registration r ON r.id = c.registration_id "
        "WHERE c.checked_at IS NOT NULL AND c.is_smoke IS NOT 1 AND r.status='active'"
    ).fetchone()[0]
    by_method = {}
    for m in CHECKIN_METHODS:
        n = conn.execute(
            "SELECT COUNT(*) FROM checkin c JOIN registration r ON r.id = c.registration_id "
            "WHERE c.method=? AND c.checked_at IS NOT NULL AND c.is_smoke IS NOT 1 AND r.status='active'",
            (m,),
        ).fetchone()[0]
        by_method[m] = n
    return {
        "ok": True,
        "registered": total,
        "checked_in": checked,
        "rate": round(checked / total, 4) if total else 0,
        "by_method": by_method,
    }




@router.get("/api/admin/profile")
def admin_profile(token: str = ""):
    """后台报名画像：性别分布 + 来源渠道分布，不含姓名/手机号/openid。

    2026-11-21 起不再输出学历/院校/意向岗位——那是招聘专场口径。
    通用活动关心的是「报名的人从哪来、男女比例」，从 answers 里按
    当前 schema 的 label 找同名字段即可，任何活动都适用。
    """
    require_login(token)
    conn = get_conn()
    rows = conn.execute(
        "SELECT gender, channel, answers FROM registration "
        "WHERE status='active' AND is_smoke IS NOT 1"
    ).fetchall()
    total = len(rows)

    gender_count = {}
    channel_count = {}
    for r in rows:
        g = r["gender"] or "未填"
        gender_count[g] = gender_count.get(g, 0) + 1
        ch = r["channel"] or "未标注"
        channel_count[ch] = channel_count.get(ch, 0) + 1

    def _top(d, n=5):
        return [{"k": k, "n": v} for k, v in sorted(d.items(), key=lambda x: -x[1])[:n]]

    return {
        "ok": True,
        "total": total,
        "gender": _top(gender_count),
        "channels": _top(channel_count),
    }




@router.get("/api/admin/list")
def admin_list(token: str = "", full: int = 0, page: int = 1, size: int = 20, q: str = ""):
    """后台名单：报名明细 + 签到状态，支持分页与搜索。

    - 分页：page/size，size 仅接受 20/50/100，默认 20
    - 搜索：q 匹配姓名／手机号／院校／专业／凭证码（模糊），空则不过滤
    - 分项统计（渠道／时段／应届构成）始终按**全量**算，不随搜索变化，避免筛完误以为总盘子变小
    - 手机号接口层默认脱敏；确需完整号码时传 full=1，此动作本身留痕
    """
    # 完整名单与导出同属后台专有：staff（现场核销）token 只用于核销，不给名单
    acc = require_login(token)
    show_full = bool(full)
    if show_full and not acc["can_full_phone"]:
        raise HTTPException(403, "当前账号无查看完整手机号权限")
    page, size = page_params(page, size)
    keyword = (q or "").strip()[:40]
    conn = get_conn()

    # 全量聚合：统计口径与筛选无关
    all_rows = conn.execute(
        """SELECT r.channel, r.gender,
                  (SELECT MAX(c.checked_at) FROM checkin c
                    WHERE c.registration_id=r.id AND c.checked_at IS NOT NULL) AS checked_at
           FROM registration r WHERE r.is_smoke IS NOT 1 AND r.status='active'"""
    ).fetchall()
    by_channel, by_hour = {}, {}
    gender_mix = {"男": 0, "女": 0, "未填": 0}
    checked_all = 0
    for r in all_rows:
        gender_mix[r["gender"] or "未填"] = gender_mix.get(r["gender"] or "未填", 0) + 1
        by_channel[r["channel"]] = by_channel.get(r["channel"], 0) + 1
        ch = r["checked_at"]
        if ch:
            checked_all += 1
            hh = str(ch)[11:13]      # ISO 串的“小时”位
            by_hour[hh] = by_hour.get(hh, 0) + 1
    total_all = len(all_rows)

    where = "r.is_smoke IS NOT 1"
    params = []
    if keyword:
        # 转义 LIKE 通配符，避免用户输入 % 或 _ 时把整库捞出来
        kw = keyword.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = "%" + kw + "%"
        # answers 是 JSON 文本，自定义字段（单位/职务/邮箱…）的值在里面，
        # 直接对整段做 LIKE 就能搜到——不解析、不建索引，名单量级够用。
        where += (" AND (r.name LIKE ? ESCAPE '\\' OR r.phone LIKE ? ESCAPE '\\'"
                  " OR IFNULL(r.answers,'') LIKE ? ESCAPE '\\'"
                  " OR IFNULL(r.credential_code,'') LIKE ? ESCAPE '\\')")
        params = [like] * 4

    matched = conn.execute(
        "SELECT COUNT(*) FROM registration r WHERE " + where, params
    ).fetchone()[0]

    rows = conn.execute(
        """SELECT r.id, r.name, r.phone_code, r.phone, r.gender,
                  r.channel, r.credential_code, r.created_at,
                  r.status, r.closed_at, r.closed_by, r.answers,
                  (SELECT c.method FROM checkin c
                    WHERE c.registration_id=r.id AND c.checked_at IS NOT NULL
                    ORDER BY c.id DESC LIMIT 1) AS method,
                  (SELECT MAX(c.checked_at) FROM checkin c
                    WHERE c.registration_id=r.id AND c.checked_at IS NOT NULL) AS checked_at
           FROM registration r
           WHERE """ + where + """
           ORDER BY r.id DESC LIMIT ? OFFSET ?""",
        params + [size, (page - 1) * size],
    ).fetchall()

    def mask(p):
        p = "" if p is None else str(p)
        return (p[:3] + "****" + p[-4:]) if len(p) >= 7 else p

    # G8：活动开了伴手礼才给名单多一列，没开的机构表头与历史完全一致
    import feature as _feature
    gift_on = _feature.enabled("gift", actx.current_id())
    gift_map = {}
    if gift_on:
        for gc in conn.execute(
            "SELECT registration_id, status, issued_at FROM gift_claim WHERE activity_id=?",
            (actx.current_id(),),
        ).fetchall():
            label = ("已领 " + str(gc["issued_at"])[:16]) if gc["status"] == "issued" \
                    else "未领（已撤销）"
            if gc["registration_id"] not in gift_map or gc["status"] == "issued":
                gift_map[gc["registration_id"]] = label

    items = []
    for r in rows:
        ch = r["checked_at"]
        item = {
            "id": r["id"],
            "name": show_name(r["name"], show_full),
            "phone_code": r["phone_code"] or "86",
            "phone": r["phone"] if show_full else mask(r["phone"]),
            "gender": r["gender"] or "",
            "channel": r["channel"],
            "code": r["credential_code"] or "",
            "checked": bool(ch),
            "method": r["method"] or "",
            "checked_at": ch or "",
            "created_at": r["created_at"],
            "status": r["status"] or "active",
            "closed_at": r["closed_at"] or "",
            "closed_by": r["closed_by"] or "",
            "gift_state": (gift_map.get(r["id"], "未领") if gift_on else None),
        }
        # answers 展开到顶层：行业字段（单位/职务/邮箱…）由活动 schema 决定，
        # 前端按 schema 的 key 取列。不覆盖通用字段，避免历史脏 JSON 盖掉姓名。
        try:
            data = json.loads(r["answers"] or "{}")
            if isinstance(data, dict):
                item.update({k: v for k, v in data.items() if k not in item})
        except (TypeError, ValueError):
            pass
        items.append(item)
    if show_full:
        write_admin_log("view_full_phone", "查看完整信息（名单）%d 行" % len(items), acc["username"])
    closed_total = conn.execute(
        "SELECT COUNT(*) FROM registration WHERE is_smoke IS NOT 1 AND status='closed'"
    ).fetchone()[0]
    return {
        "ok": True,
        "total": total_all,                 # 有效报名数（统计用，不含已关闭）
        "closed_total": closed_total,       # 已关闭条数（列表里仍可见）
        "matched": matched,                 # 当前搜索命中数（含已关闭，分页用）
        "page": page,
        "size": size,
        "q": keyword,
        "checked": checked_all,
        "rate": round(checked_all / total_all, 4) if total_all else 0,
        "by_channel": by_channel,
        "by_hour": by_hour,
        "gender_mix": gender_mix,
        "rows": items,
    }




@router.get("/api/admin/registration")
def admin_reg_get(id: int, token: str = ""):
    """取单条报名完整信息，供编辑弹层预填（列表里是脱敏值，不能直接用）。仅管理员。

    通用字段（name/phone/gender）走列，其余字段从 answers 展开到顶层，
    前端按活动 schema 的 key 取——不再有学历/岗位这类固定列。
    """
    require_admin(token)
    conn = get_conn()
    r = conn.execute(
        "SELECT id, name, phone_code, phone, gender, channel, credential_code, "
        "status, created_at, answers FROM registration WHERE id=?", (id,)
    ).fetchone()
    if not r:
        raise HTTPException(404, "未找到该报名记录")
    out = dict(r)
    try:
        data = json.loads(r["answers"] or "{}")
        if isinstance(data, dict):
            out.update({k: v for k, v in data.items() if k not in out})
    except (TypeError, ValueError):
        pass
    return {"ok": True, "row": out}




@router.post("/api/admin/registration/update")
def admin_reg_update(body: RegUpdateIn):
    """管理员修改报名信息。

    只改业务字段，凭证码不动（可能已印在物料上）；每次改动写操作日志，
    detail 里存「字段→旧值/新值」，事后能追溯谁在什么时候改了什么。
    """
    acc = require_admin(body.token)

    conn = get_conn()
    old = conn.execute(
        "SELECT name, phone_code, phone, gender, answers "
        "FROM registration WHERE id=?", (body.id,)
    ).fetchone()
    if not old:
        raise HTTPException(404, "未找到该报名记录")

    name = (body.name or "").strip()
    if not (2 <= len(name) <= 20):
        raise HTTPException(400, "姓名需为 2—20 字")

    # 区号与号码：未传区号沿用原值；号码只留数字（海外号码常带空格/连字符）
    phone_code = norm_phone_code(body.phone_code if body.phone_code is not None
                                 else (old["phone_code"] or "86"))
    phone = re.sub(r"\D", "", body.phone or "")
    if phone_code == "86":
        if not PHONE_RE.match(phone):
            raise HTTPException(400, "手机号格式不正确，请填写 11 位大陆手机号")
    else:
        if not (4 <= len(phone) <= 15):
            raise HTTPException(400, "请填写有效号码")
    gender = body.gender if body.gender in GENDER_OPTIONS else None

    # answers 合并：只更新本次提交的字段，不清空其它字段（编辑弹层可能只改一项）
    old_answers = {}
    try:
        old_answers = json.loads(old["answers"] or "{}") or {}
    except (TypeError, ValueError):
        pass
    new_answers = dict(old_answers)
    if body.answers:
        new_answers.update({k: v for k, v in body.answers.items() if v is not None})
    answers_json = json.dumps(new_answers, ensure_ascii=False) if new_answers else None

    # 风控：后台改报名是唯一能把任意文本写进 answers 的口子，而 C 端「修改信息」
    # 会原样回填展示（public.py 的 profile 展开）。报名入口那道词表，
    # 不能因为换了个后台入口就绕过去。
    riskword.guard({"报名信息": [name, answers_json]},
                   where="registration_update", acc=acc)

    new = {"name": name, "phone_code": phone_code, "phone": phone, "gender": gender}
    diff = {k: {"old": old[k] or "", "new": v or ""} for k, v in new.items() if (old[k] or "") != (v or "")}
    if (old["answers"] or "") != (answers_json or ""):
        diff["answers"] = {"old": old["answers"] or "", "new": answers_json or ""}
    if not diff:
        return {"ok": True, "status": "unchanged", "changes": 0}
    try:
        with transaction() as c:
            c.execute(
                "UPDATE registration SET name=?, phone_code=?, phone=?, gender=?, answers=? "
                "WHERE id=?",
                (name, phone_code, phone, gender, answers_json, body.id),
            )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "该手机号已被其他报名占用，请核对后重填")
    write_admin_log("registration_update", json.dumps(diff, ensure_ascii=False), acc["username"])
    return {"ok": True, "status": "updated", "changes": len(diff)}




@router.post("/api/admin/registration/close")
def admin_reg_close(body: RegStateIn):
    """关闭一条报名（软删除）。

    关闭后的效果：
    - 前端按 openid 查不到这条，用户重新打开链接就是新用户，可以直接重新报名；
    - 后台记录原样保留，名单里显示「已关闭」，导出带状态列，可随时恢复；
    - 重新报名会新增一条记录，两条各自留痕，不做覆盖。

    与「真删除」的区别要说清：数据仍在库里，只是对用户不可见。若用户依法要求删除
    个人信息，仅关闭不满足删除义务，需要另行匿名化处理。
    """
    acc = require_admin(body.token)
    conn = get_conn()
    row = conn.execute(
        "SELECT id, openid, name, phone, status FROM registration WHERE id=?", (body.id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "报名记录不存在")
    if (row["status"] or "active") == "closed":
        return {"ok": True, "status": "closed", "already": True}
    with transaction() as c:
        c.execute(
            "UPDATE registration SET status='closed', closed_at=?, closed_by=? WHERE id=?",
            (now_iso(), acc["username"], row["id"]),
        )
    reason = (body.reason or "").strip()[:60]
    write_admin_log(
        "registration_close",
        "关闭报名 #%d %s %s%s" % (row["id"], row["name"], row["phone"],
                                 ("；原因：" + reason) if reason else ""),
        acc["username"],
    )
    return {"ok": True, "status": "closed", "id": row["id"]}




@router.post("/api/admin/registration/reopen")
def admin_reg_reopen(body: RegStateIn):
    """恢复一条被关闭的报名。

    两种记录走这里：
    ① status='closed'——运营手动关掉的报名；
    ② status='draft'——发布时被归档的测试数据，**归档错了要能捞回来**。
       now_iso 只精确到秒，真实报名撞在切草稿那一秒里会被一起标掉，
       没有这条路就只能改库。

    若这个人在关闭之后已经重新报名，就不能恢复旧记录——否则同一个 openid / 手机号
    会出现两条有效报名，统计和发放都会乱。这种情况直接拒绝，让操作人知道现状。
    """
    acc = require_admin(body.token)
    conn = get_conn()
    row = conn.execute(
        "SELECT id, openid, name, phone, status FROM registration WHERE id=?", (body.id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "报名记录不存在")
    cur = row["status"] or "active"
    if cur == "active":
        return {"ok": True, "status": "active", "already": True}
    if cur not in ("closed", "draft"):
        raise HTTPException(409, "这条报名的状态是 %s，不能恢复" % cur)
    clash = conn.execute(
        "SELECT id FROM registration WHERE status='active' AND id<>? "
        "AND (phone=? OR (openid IS NOT NULL AND openid<>'' AND openid=?)) LIMIT 1",
        (row["id"], row["phone"], row["openid"] or ""),
    ).fetchone()
    if clash:
        raise HTTPException(409, "该用户关闭后已重新报名（记录 #%d），不能恢复旧记录" % clash["id"])
    with transaction() as c:
        c.execute(
            "UPDATE registration SET status='active', closed_at=NULL, closed_by=NULL WHERE id=?",
            (row["id"],),
        )
    write_admin_log(
        "registration_reopen", "恢复报名 #%d %s %s" % (row["id"], row["name"], row["phone"]),
        acc["username"],
    )
    return {"ok": True, "status": "active", "id": row["id"]}




class MaterialIn(BaseModel):
    name: str
    kind: Optional[str] = "signup"     # signup 报名 / checkin 现场核销
    scene: Optional[str] = None        # 推文 / 海报 / 朋友圈 / 桌牌 / 易拉宝
    note: Optional[str] = None
    code: Optional[str] = None         # 留空自动生成


class MaterialUpdateIn(BaseModel):
    id: int
    name: Optional[str] = None
    scene: Optional[str] = None
    note: Optional[str] = None
    enabled: Optional[int] = None


class MaterialIdIn(BaseModel):
    token: str = ""
    id: int


MATERIAL_KINDS = ("signup", "checkin")


@router.get("/api/admin/materials")
def admin_materials(token: str = ""):
    """投放物料码列表 + 归因。

    扫码人数按设备（did）去重，与 UV 同口径：一个人翻十页只算一人。
    报名数取 registration.source_code=该码且 status='active'——关闭过的报名不算转化。
    """
    require_login(token)
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM material_code WHERE env=? ORDER BY id DESC", (DB_ENV,)
    ).fetchall()
    scans = {
        r["code"]: (r["n"], r["p"])
        for r in conn.execute(
            """SELECT code, COUNT(DISTINCT did) n, COUNT(*) p FROM events
               WHERE env=? AND code IS NOT NULL AND did IS NOT NULL GROUP BY code""",
            (DB_ENV,),
        ).fetchall()
    }
    regs = {
        r["source_code"]: r["n"]
        for r in conn.execute(
            """SELECT source_code, COUNT(*) n FROM registration
               WHERE env=? AND source_code IS NOT NULL AND status='active'
               GROUP BY source_code""",
            (DB_ENV,),
        ).fetchall()
    }
    out = []
    for r in rows:
        d = dict(r)
        s, pv = scans.get(r["code"], (0, 0))
        n_reg = regs.get(r["code"], 0)
        d["scans"] = s
        d["pv"] = pv
        d["regs"] = n_reg
        # 没人扫码时不给百分比：0% 会让人以为「码坏了」，其实是还没投放
        d["rate"] = round(n_reg * 100.0 / s, 1) if s else None
        out.append(d)
    import feature as _feature
    return {"ok": True, "rows": out, "total": len(out),
            "features": {"checkin_multi": _feature.enabled("checkin_multi")}}


@router.post("/api/admin/materials")
def admin_material_create(body: MaterialIn, token: str = ""):
    """新建投放码（所有后台角色可建；核销码另受专业版能力位约束）。

    报名入口短码是基线能力，各版本都能建；**分场核销码是多通道核销**，
    只有专业版能新建——没权限的版本继续用固定的默认兜底核销码。
    已建的核销码在降级后仍可用（物料已经印出去，禁用等于现场事故）。

    短码一旦有过投放记录就不许复用：归因按短码字符串聚合，
    同码重建会把两次投放的扫码数混在一起，历史数据就废了。
    """
    acc = require_login(token)
    name = (body.name or "").strip()
    if not (2 <= len(name) <= 40):
        raise HTTPException(400, "物料名称需为 2—40 字")
    # 风控：投放码名称与场景会出现在后台列表与复盘「来源 Top」，也会被运营
    # 截图给客户看；二维码本身没法审，能审的就是这段命名。
    riskword.guard({"物料名称": [name, body.scene, body.note]},
                   where="material_create", acc=acc)
    kind = body.kind if body.kind in MATERIAL_KINDS else "signup"
    if kind == "checkin":
        import feature as _feature
        if not _feature.enabled("checkin_multi"):
            raise HTTPException(403, "当前版本未开放多通道核销，仅能使用默认兜底核销码；"
                                     "升级专业版后可创建分场核销码")
    conn = get_conn()
    want = (body.code or "").strip().lower()
    if want:
        if not re.match(r"^[a-z0-9]{4,16}$", want):
            raise HTTPException(400, "短码只能用 4—16 位小写字母或数字")
        if conn.execute("SELECT 1 FROM material_code WHERE code=?", (want,)).fetchone():
            raise HTTPException(409, "该短码已被使用，换一个")
        if _code_used_before(conn, want):
            raise HTTPException(409, "该短码历史上有投放记录，不能重复使用，请换一个")
        code = want
    else:
        code = None
        for _ in range(8):
            cand = gen_material_code(6)
            if not conn.execute("SELECT 1 FROM material_code WHERE code=?", (cand,)).fetchone():
                code = cand
                break
        if not code:
            raise HTTPException(500, "短码生成失败，请重试")
    with transaction() as c:
        mid = insert_row(c, "material_code", {
            "code": code,
            "name": name,
            "kind": kind,
            "scene": (body.scene or "").strip() or None,
            "note": (body.note or "").strip() or None,
            "enabled": 1,
            "created_by": acc["username"],
            "created_at": now_iso(),
        })
    write_admin_log("material_create", "新建投放码 %s（%s）" % (code, name), acc["username"])
    return {"ok": True, "id": mid, "code": code}


def _code_used_before(conn, code):
    """这个短码历史上有没有被投放过（事件或报名里出现过）。"""
    a = conn.execute("SELECT 1 FROM events WHERE code=? LIMIT 1", (code,)).fetchone()
    if a:
        return True
    b = conn.execute(
        "SELECT 1 FROM registration WHERE source_code=? LIMIT 1", (code,)
    ).fetchone()
    return bool(b)


@router.post("/api/admin/materials/update")
def admin_material_update(body: MaterialUpdateIn, token: str = ""):
    """改名称/场景/备注，或停用。码本身不可改——已经印出去了，改码等于换一套物料。"""
    acc = require_login(token)
    conn = get_conn()
    cur = conn.execute("SELECT * FROM material_code WHERE id=?", (body.id,)).fetchone()
    if not cur:
        raise HTTPException(404, "物料不存在")
    name = cur["name"] if body.name is None else (body.name or "").strip()
    if not (2 <= len(name) <= 40):
        raise HTTPException(400, "物料名称需为 2—40 字")
    scene = cur["scene"] if body.scene is None else ((body.scene or "").strip() or None)
    note = cur["note"] if body.note is None else ((body.note or "").strip() or None)
    riskword.guard({"物料名称": [name, scene, note]},
                   where="material_update", acc=acc)
    enabled = cur["enabled"] if body.enabled is None else (1 if body.enabled else 0)
    with transaction() as c:
        c.execute(
            "UPDATE material_code SET name=?, scene=?, note=?, enabled=? WHERE id=?",
            (name, scene, note, enabled, body.id),
        )
    write_admin_log(
        "material_update",
        "修改投放码 %s（%s）" % (cur["code"], "停用" if not enabled else "启用"),
        acc["username"],
    )
    return {"ok": True}


@router.post("/api/admin/materials/delete")
def admin_material_delete(body: MaterialIdIn, token: str = ""):
    """删除投放码：必须先停用。

    删的是「渠道码」这条记录，不是历史数据：报名的 source_code 与埋点的 code
    都还留着短码字符串，历史归因不丢；但渠道名从此不再显示，所以前端删除前
    会把「已扫码 N 次 / 已报名 M 人」摆出来让人确认。
    """
    acc = require_login(token)
    conn = get_conn()
    cur = conn.execute("SELECT * FROM material_code WHERE id=?", (body.id,)).fetchone()
    if not cur:
        raise HTTPException(404, "物料不存在")
    if cur["enabled"]:
        raise HTTPException(400, "只能删除已停用的投放码，请先停用再删")
    scans = conn.execute(
        "SELECT COUNT(DISTINCT did) FROM events WHERE code=?", (cur["code"],)
    ).fetchone()[0]
    regs = conn.execute(
        "SELECT COUNT(*) FROM registration WHERE source_code=? AND status='active'",
        (cur["code"],),
    ).fetchone()[0]
    with transaction() as c:
        c.execute("DELETE FROM material_code WHERE id=?", (body.id,))
    write_admin_log("material_delete", "删除投放码 %s（%s）" % (cur["code"], cur["name"]),
                    acc["username"])
    return {"ok": True, "deleted": cur["code"], "scans": scans, "regs": regs}


@router.get("/api/admin/workbench")
def admin_workbench(token: str = ""):
    """运营工作台：今日三数 + 异常体检 + 最近动态，一次返回。

    原来总览只给累计数，运营还得自己拼「今天多少、有没有事要处理」。
    今日口径按自然日 00:00 起算（东八区），与「数据统计」的区间筛选互不影响。
    """
    require_login(token)
    conn = get_conn()
    now = datetime.now(TZ)
    t0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
    y0 = t0 - timedelta(days=1)
    t_iso, y_iso = t0.isoformat(timespec="seconds"), y0.isoformat(timespec="seconds")

    def one(sql, args=()):
        r = conn.execute(sql, args).fetchone()
        return r[0] if r else 0

    # 领卡按人去重：同一个人点两次开卡不算两张卡
    aid = actx.current_id()
    # 草稿期的测试签到也要排除。checkin 没有 status 列，有效性跟着报名走。
    # 用 NOT IN 子查询而不是 join：hi_sql 里写的是不带别名的 created_at，
    # 加别名会打架；registration_id 为空的（人工核销那条）必须留住。
    not_draft = (" AND (registration_id IS NULL OR registration_id NOT IN"
                 " (SELECT id FROM registration WHERE status='draft' AND activity_id=?))")

    def day_of(lo, hi=None):
        hi_sql, hi_args = (" AND created_at < ?", (hi,)) if hi else ("", ())
        return {
            "reg": one("SELECT COUNT(*) FROM registration WHERE env=? AND status='active' "
                       "AND created_at>=?" + hi_sql, (DB_ENV, lo) + hi_args),
            "checkin": one("SELECT COUNT(*) FROM checkin WHERE env=? AND checked_at>=?" + hi_sql + not_draft,
                           (DB_ENV, lo) + hi_args + (aid,)),
            "card": one("SELECT COUNT(DISTINCT COALESCE(phone, openid)) FROM card_action "
                        "WHERE env=? AND action='card_click' AND created_at>=?" + hi_sql,
                        (DB_ENV, lo) + hi_args),
        }

    today = day_of(t_iso)
    yest = day_of(y_iso, t_iso)
    total = {
        "reg": one("SELECT COUNT(*) FROM registration WHERE env=? AND status='active'", (DB_ENV,)),
        "checkin": one("SELECT COUNT(*) FROM checkin WHERE env=?" + not_draft, (DB_ENV, aid)),
        "card": one("SELECT COUNT(DISTINCT COALESCE(phone, openid)) FROM card_action "
                    "WHERE env=? AND action='card_click'", (DB_ENV,)),
    }

    # ---- 异常体检 ----
    # 每条都是「今天真实踩过的坑」的提前预警，宁可多提示一句，也不要现场才发现。
    g = gate_state()
    ov = gate_config_get(conn)
    pv_1h = one("SELECT COUNT(*) FROM events WHERE env=? AND event='pv' AND ts>=?", (
        DB_ENV, (now - timedelta(hours=1)).isoformat(timespec="seconds")))
    alerts = []

    def bad(code, text, level="warn"):
        alerts.append({"code": code, "text": text, "level": level})

    if g.get("window_invalid"):
        bad("window_invalid",
            "签到窗口时间格式异常，已退回默认窗口。请到「现场开关」重新保存一次时效")
    elif g.get("checkin_switch") and not g.get("in_window"):
        try:
            start = datetime.fromisoformat(g["window"]["start"])
            gap = (start - now).total_seconds() / 3600.0
            if 0 < gap <= 2:
                bad("gate_pending",
                    "签到开关已打开，但距开放还有 %.1f 小时，到点自动放行" % gap, "info")
        except Exception:
            pass

    reg_end = ov["registration_end"] if ov else None
    if reg_end and reg_end <= now.isoformat(timespec="seconds") and pv_1h > 0:
        bad("reg_closed_traffic",
            "报名已截止，但近 1 小时仍有 %d 次访问，投放该停了" % pv_1h)

    event_end = ov["event_end"] if ov else None
    in_event = (not event_end) or event_end > now.isoformat(timespec="seconds")
    if in_event and pv_1h == 0 and not (ov and ov["event_ended"]):
        bad("no_traffic", "近 1 小时零访问，检查链接是否可打开、服务是否正常", "info")

    if today["reg"] > 0 and today["checkin"] == 0 and g.get("in_window"):
        bad("no_checkin", "今天已有 %d 人报名但还没有人签到，确认现场码是否到位" % today["reg"])

    ev_total = one("SELECT COUNT(*) FROM events WHERE env=?", (DB_ENV,))
    if ev_total > 500000:
        bad("storage", "访问事件累计 %d 条，超过 50 万，建议归档" % ev_total, "info")

    recent = conn.execute(
        "SELECT action, detail, operator, created_at FROM admin_log "
        "ORDER BY id DESC LIMIT 5").fetchall()

    return {
        "ok": True,
        "server_time": now.isoformat(timespec="seconds"),
        "today": today,
        "yesterday": yest,
        "total": total,
        "alerts": alerts,
        "recent": [dict(r) for r in recent],
    }


def _csv_cell(v):
    """CSV 单元格转义：含逗号/引号/换行才加引号。

    审计详情里常带中文顿号和引号（「导出报名明细 12 行」），
    不转义的话 Excel 打开会错列。
    """
    s = "" if v is None else str(v)
    if "," in s or '"' in s or "\n" in s:
        s = '"' + s.replace('"', '""') + '"'
    return s


# 敏感动作：能看全号、能导出、能改闸门、能改密码——真正需要事后追责的就这几类
SENSITIVE_ACTIONS = ("view_full_phone", "export", "gate", "password_change")


def hidden_log_operators(viewer):
    """审计日志里当前查看者「不允许向上查看」的操作者名单。

    当前 P0 两级体系：超管是唯一上一级，非超管 admin 看不到超管的操作日志；
    平级 admin 与下级 staff 的日志都可见。查看者是 staff 时进不了本页，无需处理。

    ★ P1 扩展点：身份从两级变成多级（平台超管/机构管理员/机构运营）后，
    只改本函数——返回所有「级别高于 viewer」的 operator 即可，三个调用处不用动。
    """
    if viewer == SUPER_ADMIN_USERNAME:
        return []
    return [SUPER_ADMIN_USERNAME]


def _logs_where(action, operator, start, end, sensitive, hidden_ops=()):
    """拼筛选条件。全部留空时返回空条件，与升级前行为完全一致。"""
    where, args = [], []
    if action:
        where.append("action = ?")
        args.append(action)
    if operator:
        where.append("operator = ?")
        args.append(operator)
    # created_at 统一是 ISO 带偏移的字符串，同格式可直接比较
    if start:
        where.append("created_at >= ?")
        args.append(start)
    if end:
        where.append("created_at <= ?")
        args.append(end)
    if sensitive:
        where.append("action IN (%s)" % ",".join("?" * len(SENSITIVE_ACTIONS)))
        args.extend(SENSITIVE_ACTIONS)
    # 身份级别：向上不看。operator 为 NULL 的是系统动作，保留。
    if hidden_ops:
        where.append("(operator IS NULL OR operator NOT IN (%s))"
                     % ",".join("?" * len(hidden_ops)))
        args.extend(hidden_ops)
    return ((" WHERE " + " AND ".join(where)) if where else ""), args


@router.get("/api/admin/logs")
def admin_logs(token: str = "", page: int = 1, size: int = 20,
               action: str = "", operator: str = "", start: str = "", end: str = "",
               sensitive: int = 0):
    """管理操作日志（单独一页）。支持按动作/操作人/时间筛选，sensitive=1 只看敏感操作。

    facets 里的动作与操作人始终是全量集合（不受当前筛选影响），
    否则筛完一类之后下拉框就只剩那一个选项，没法切回去。
    """
    acc = require_admin(token)
    page, size = page_params(page, size)
    hidden_ops = hidden_log_operators(acc["username"])
    conn = get_conn()
    where, args = _logs_where(action, operator, start, end, sensitive, hidden_ops)
    total = conn.execute("SELECT COUNT(*) FROM admin_log" + where, args).fetchone()[0]
    rows = conn.execute(
        "SELECT action, detail, operator, created_at FROM admin_log" + where +
        " ORDER BY id DESC LIMIT ? OFFSET ?", args + [size, (page - 1) * size]
    ).fetchall()
    # 操作人下拉也必须按身份过滤：否则即使日志行藏了超管记录，
    # facets 仍会把超管用户名列出来，等于绕行泄露。
    op_cond = "operator IS NOT NULL AND operator<>''"
    op_args = []
    if hidden_ops:
        op_cond += " AND operator NOT IN (%s)" % ",".join("?" * len(hidden_ops))
        op_args.extend(hidden_ops)
    facets = {
        "actions": [
            {"action": r["action"], "count": r["n"]}
            for r in conn.execute(
                "SELECT action, COUNT(*) n FROM admin_log GROUP BY action ORDER BY n DESC")
        ],
        "operators": [
            {"operator": r["operator"], "count": r["n"]}
            for r in conn.execute(
                "SELECT operator, COUNT(*) n FROM admin_log WHERE " + op_cond +
                " GROUP BY operator ORDER BY n DESC", op_args)
        ],
    }
    return {
        "ok": True,
        "total": total,
        "page": page,
        "size": size,
        "rows": [dict(l) for l in rows],
        "facets": facets,
    }


@router.get("/api/admin/logs/export")
def admin_logs_export(token: str = "", action: str = "", operator: str = "",
                      start: str = "", end: str = "", sensitive: int = 0):
    """按当前筛选导出审计记录。导出动作本身也记一条，审计才闭环。

    走 can_export 而不是只判管理员：日志 detail 里可能带着补录时填的手机号与姓名，
    导出这份等于绕过「不可导出全号」——演示账号就是能登录后台的那种常客。
    """
    acc = require_perm(token, "can_export")
    conn = get_conn()
    # 与列表页同一套身份过滤：不能出现「页面看不到、导出能全导」的绕过。
    where, args = _logs_where(action, operator, start, end, sensitive,
                              hidden_log_operators(acc["username"]))
    rows = conn.execute(
        "SELECT created_at, action, detail, operator FROM admin_log" + where +
        " ORDER BY id DESC", args
    ).fetchall()
    ACTION_CN = {
        "export": "导出明细", "verify_confirm": "人工核销", "walkin": "现场补录",
        "gate": "闸门与时效", "view_full_phone": "查看完整信息", "login": "登录后台",
        "password_change": "修改密码", "account_create": "新增账号",
        "account_update": "修改账号", "account_delete": "删除账号",
        "staff_create": "新增工作人员", "staff_ticket": "重置核销凭据",
        "registration_update": "修改报名", "material_create": "新建投放码",
        "material_update": "修改投放码", "registration_close": "关闭报名记录",
        "staff_update": "修改工作人员", "staff_delete": "删除工作人员",
        "material_delete": "删除投放码", "bgm": "背景音乐开关",
        "bgm_upload": "上传背景音乐", "bgm_reset": "重置背景音乐",
        "purge_test_data": "清除测试数据",
    }
    lines = ["时间,动作,动作码,详情,操作人"]
    for r in rows:
        lines.append(",".join([
            _csv_cell(r["created_at"]), _csv_cell(ACTION_CN.get(r["action"], r["action"])),
            _csv_cell(r["action"]), _csv_cell(r["detail"]), _csv_cell(r["operator"]),
        ]))
    csv_text = "\n".join(lines) + "\n"
    with transaction() as c:
        insert_row(c, "export_log", {
            "operator": acc["username"], "row_count": len(rows), "created_at": now_iso(),
        })
    write_admin_log("export", "导出审计记录 %d 行" % len(rows), acc["username"])
    return PlainTextResponse(
        "\ufeff" + csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="audit-log.csv"'},
    )




@router.get("/api/admin/checkins")
def admin_checkins(token: str = "", page: int = 1, size: int = 20, full: int = 0):
    """签到流水（单独一页）：分页返回，默认 20 条/页。仅 admin。

    手机号与名单同一口径：默认脱敏，full=1 才给全号且留痕。
    """
    acc = require_login(token)
    page, size = page_params(page, size)
    show_full = bool(full)
    if show_full and not acc["can_full_phone"]:
        raise HTTPException(403, "当前账号无查看完整手机号权限")
    conn = get_conn()
    total = conn.execute(
        "SELECT COUNT(*) FROM checkin WHERE checked_at IS NOT NULL AND is_smoke IS NOT 1"
        " AND (registration_id IS NULL OR registration_id NOT IN"
        " (SELECT id FROM registration WHERE status='draft' AND activity_id=?))",
        (actx.current_id(),),
    ).fetchone()[0]
    rows = conn.execute(
        """SELECT c.checked_at, c.method,
                  COALESCE(c.name, r.name) AS name,
                  COALESCE(c.phone, r.phone) AS phone,
                  c.channel,
                  r.credential_code, s.username AS staff_name
           FROM checkin c
           LEFT JOIN registration r ON r.id = c.registration_id
           LEFT JOIN staff s ON s.id = c.staff_id
           WHERE c.checked_at IS NOT NULL AND c.is_smoke IS NOT 1
             AND COALESCE(r.status, 'active') <> 'draft'
           ORDER BY c.id DESC LIMIT ? OFFSET ?""", (size, (page - 1) * size)
    ).fetchall()
    items = []
    for c in rows:
        d = dict(c)
        d["name"] = show_name(d["name"], show_full)
        d["phone"] = (d["phone"] or "") if show_full else mask_phone(d["phone"] or "")
        items.append(d)
    if show_full:
        write_admin_log("view_full_phone", "查看完整信息（签到流水）%d 行" % len(items), acc["username"])
    return {
        "ok": True,
        "total": total,
        "page": page,
        "size": size,
        "rows": items,
    }




@router.post("/api/admin/manual-checkin")
def admin_manual_checkin(body: ManualCheckinIn, token: str = ""):
    """现场兜底：H5 不可用或签到未开闸时也能登记，故不检查 gate_state()。"""
    acc = require_login(token)
    phone = (body.phone or "").strip()
    conn = get_conn()
    reg = conn.execute(
        "SELECT id, openid, name, phone, channel FROM registration "
        "WHERE phone=? AND status='active'",
        (phone,),
    ).fetchone()
    if not reg:
        raise HTTPException(404, "未找到该手机号的报名记录")
    exist = checkin_core.find_existing(reg["id"])
    if exist:
        return {"ok": True, "status": "already", "name": reg["name"]}
    try:
        checkin_core.record(
            reg["id"], openid=reg["openid"], method="manual",
            channel=reg["channel"], name=reg["name"], phone=reg["phone"])
    except checkin_core.AlreadyChecked:
        return {"ok": True, "status": "already", "name": reg["name"]}
    write_admin_log(
        "manual_checkin",
        "后台手工登记签到 #%d %s %s" % (reg["id"], reg["name"], reg["phone"]),
        acc["username"],
    )
    return {"ok": True, "status": "checked", "name": reg["name"]}




# ---------------- 签到闸门：运行时可调（后台开关，不必重启服务）----------------

@router.get("/api/admin/gate")
def admin_gate_get(token: str = ""):
    """读取当前签到闸门状态与是否被后台覆盖。需登录。"""
    require_login(token)
    conn = get_conn()
    row = gate_config_get(conn)
    return {
        "ok": True,
        "gate": gate_state(),
        "override": dict(row) if row else None,
    }




@router.post("/api/admin/gate")
def admin_gate_set(body: GateIn, token: str = ""):
    """开关签到 / 调整签到窗口 / 报名开关 / 活动结束态。传了的字段才更新，未传保持原值。"""
    acc = require_admin(token)
    conn = get_conn()
    cur = gate_config_get(conn)
    switch = bool(body.switch) if body.switch is not None else (bool(cur["checkin_switch"]) if cur else False)
    ws = body.window_start or (cur["window_start"] if cur else None)
    we = body.window_end or (cur["window_end"] if cur else None)
    if not ws or not we:
        g0 = gate_state()
        ws = ws or g0["window"]["start"]
        we = we or g0["window"]["end"]
    # 落库前统一规范化成带时区的 ISO。前端正常会带 +08:00，但接口是开放的，
    # 一旦存进不带时区的串，gate_state() 比较就抛 TypeError，签到/补录全线 500 ——
    # 而且是"保存成功、之后才崩"，极难回溯。非法值直接 400，不写库。
    try:
        ws = norm_iso(ws, "签到开始时间") or ws
        we = norm_iso(we, "签到结束时间") or we
    except ValueError as e:
        raise HTTPException(400, str(e))
    # 两个运营开关：传了才改，不传沿用库里原值（无行时用列 DEFAULT）
    reg_sw = ((1 if body.registration_switch else 0) if body.registration_switch is not None
              else (cur["registration_switch"] if cur else 1))
    ev_end = ((1 if body.event_ended else 0) if body.event_ended is not None
              else (cur["event_ended"] if cur else 0))
    # 时效约束：传空串=清除限制；不传=沿用原值
    reg_end = ((body.registration_end or None) if body.registration_end is not None
               else _row_get(cur, "registration_end"))
    ev_end_time = ((body.event_end or None) if body.event_end is not None
                   else _row_get(cur, "event_end"))
    # 时效字段同样规范化：deps._as_dt 能兜住无时区，但库里统一成带偏移更利于排查
    try:
        reg_end = norm_iso(reg_end, "报名截止时间") if reg_end else None
        ev_end_time = norm_iso(ev_end_time, "活动结束时间") if ev_end_time else None
    except ValueError as e:
        raise HTTPException(400, str(e))
    # 每活动一行。不用 ON CONFLICT(activity_id)：SQLite 老库的 activity_id 只是
    # 普通列（没有唯一约束），那个冲突目标不存在会直接报错。
    # 「先 UPDATE，没命中再 INSERT」两种库、新旧结构都能跑。
    aid = actx.current_id()
    vals = (1 if switch else 0, ws, we, reg_sw, ev_end, reg_end, ev_end_time, "admin", now_iso())
    with transaction() as c:
        cur2 = c.execute(
            "UPDATE gate_config SET checkin_switch=?, window_start=?, window_end=?,"
            " registration_switch=?, event_ended=?, registration_end=?, event_end=?,"
            " updated_by=?, updated_at=? WHERE activity_id=?",
            vals + (aid,),
        )
        if cur2.rowcount == 0:
            c.execute(
                "INSERT INTO gate_config (activity_id, checkin_switch, window_start, window_end,"
                " registration_switch, event_ended, registration_end, event_end, updated_by, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (aid,) + vals,
            )
    write_admin_log(
        "gate",
        "签到开关=%s 报名开关=%s 活动结束=%s 窗口=%s ~ %s" % (
            "开" if switch else "关", "开" if reg_sw else "关", "是" if ev_end else "否", ws, we),
        acc["username"],
    )
    return {"ok": True, "gate": gate_state()}




@router.get("/api/admin/bgm")
def admin_bgm_get(token: str = ""):
    """后台读取背景音乐状态。顺带探测目录可写性，上传失败时能直接判断是不是权限问题。"""
    require_login(token)
    try:
        os.makedirs(AUDIO_DIR, exist_ok=True)
        writable = os.access(AUDIO_DIR, os.W_OK)
    except OSError:
        writable = False
    return {"ok": True, **bgm_config(), "dir": AUDIO_DIR, "writable": writable}




@router.post("/api/admin/bgm")
def admin_bgm_toggle(body: BgmToggleIn):
    """开关背景音乐。关闭后前端不再加载音频，也不占流量。"""
    acc = require_admin(body.token)
    site_config_set({"bgm_enabled": "1" if body.enabled else "0"}, acc["username"])
    write_admin_log("bgm", "背景音乐=%s" % ("开" if body.enabled else "关"), acc["username"])
    return {"ok": True, **bgm_config()}




@router.post("/api/admin/bgm/upload")
async def admin_bgm_upload(request: Request, token: str = "", filename: str = ""):
    """上传背景音乐。

    用原始二进制 body 而不是 multipart：后端只装了 fastapi + uvicorn，
    没装 python-multipart，走 raw body 不必为这一个功能加依赖。
    """
    acc = require_admin(token)
    data = await request.body()
    if not data:
        raise HTTPException(400, "没有收到文件内容")
    if len(data) > BGM_MAX_BYTES:
        raise HTTPException(413, "文件超过 %dMB，请先压缩后再传" % (BGM_MAX_BYTES // (1024 * 1024)))
    is_mp3 = data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0)
    if not is_mp3:
        raise HTTPException(400, "只支持 MP3 文件")
    try:
        os.makedirs(AUDIO_DIR, exist_ok=True)
        name = "bgm-upload-" + datetime.now(TZ).strftime("%Y%m%d-%H%M%S") + ".mp3"
        path = os.path.join(AUDIO_DIR, name)
        with open(path, "wb") as f:
            f.write(data)
        os.chmod(path, 0o644)      # 后端若以 root 跑，这里兜住 nginx 读不到的问题
    except OSError as e:
        raise HTTPException(500, "写入文件失败：%s" % e)
    old = (site_config_get().get("bgm_url") or "").strip()
    if old and os.path.basename(old) != name:
        _bgm_remove_file(old)
    site_config_set({
        "bgm_url": "audio/" + name,
        "bgm_name": (filename or name)[:80],
        "bgm_size": str(len(data)),
        "bgm_updated_at": now_iso(),
        "bgm_enabled": "1",
    }, acc["username"])
    write_admin_log("bgm_upload",
                    "%s（%d KB）" % ((filename or name)[:80], len(data) // 1024), acc["username"])
    return {"ok": True, **bgm_config()}




@router.post("/api/admin/bgm/reset")
def admin_bgm_reset(body: BgmTokenIn):
    """恢复内置默认曲目，并删掉上传的自定义文件。"""
    acc = require_admin(body.token)
    old = (site_config_get().get("bgm_url") or "").strip()
    if old:
        _bgm_remove_file(old)
    site_config_set({
        "bgm_url": "", "bgm_name": "", "bgm_size": "", "bgm_updated_at": "",
        "bgm_enabled": "1",
    }, acc["username"])
    write_admin_log("bgm_reset", "恢复内置默认曲目", acc["username"])
    return {"ok": True, **bgm_config()}




@router.post("/api/admin/login")
def admin_login(body: LoginIn, request: Request):
    """账号＋口令登录，签发 30 分钟滑动会话。"""
    username = (body.username or "").strip()
    conn = get_conn()
    row = conn.execute("SELECT * FROM account WHERE username=?", (username,)).fetchone()
    if not row or not row["enabled"] or not verify_password(body.password, row["pass_hash"]):
        # 失败原因只进日志不进响应：对外统一"账号或密码不正确"，避免探测账号是否存在
        logx.ev("login_fail", level="warning", user=username,
                ip=logx.client_ip(request),
                why="disabled" if (row and not row["enabled"]) else "credential")
        raise HTTPException(401, "账号或密码不正确")
    # 机构被平台停用 = 合同终止，比到期冻结更硬：停用后连登录都不给。
    # 到期是「只读冻结」（E 批），仍允许登录导出自己的数据——两种状态语义不同，
    # 别把停用也做成只读，否则客户欠费跑路后还能接着用后台。
    _org_state = conn.execute(
        "SELECT status FROM organization WHERE id=?",
        (int(_row_get(row, "org_id", 1) or 1),),
    ).fetchone()
    if _org_state and _org_state["status"] != "active":
        logx.ev("login_org_disabled", level="warning", user=username,
                ip=logx.client_ip(request))
        raise HTTPException(403, "该机构已停用，请联系平台客服")

    # 演示账号：登录时若数据已过期就先复原，保证每个访客看到的是干净状态。
    # 放在签发会话之前——复原失败就登录失败，不会让访客看到被改乱的旧数据。
    # 只有 username == 'demo' 且属于演示机构才触发，绝不碰真实机构。
    if username == "demo" and int(row["org_id"] or 0) == 9001:
        try:
            import seed_demo
            if seed_demo.reset_due(conn):
                seed_demo.seed(reset=True)
                logx.ev("demo_reset_on_login", user=username, ip=logx.client_ip(request))
        except Exception as e:
            # 复原失败不阻断登录，但留痕——演示环境坏掉要能发现
            logx.ev("demo_reset_failed", level="warning", user=username,
                    why=str(e)[:120], ip=logx.client_ip(request))

    token = create_session(row["id"])
    conn.execute("UPDATE account SET last_login_at=? WHERE id=?", (now_iso(), row["id"]))
    conn.commit()
    write_admin_log("login", "登录后台", username)
    logx.ev("login_ok", user=username, role=row["role"], ip=logx.client_ip(request))
    # 登录就把机构名与版本带上：底部「谁 · 哪个机构 · 什么档」要能一进来就写对，
    # 等前端再补一次 /admin/me 才显示机构名，会闪一下空白。
    account = account_public(row)
    _org = conn.execute(
        "SELECT name, code, plan, expires_at FROM organization WHERE id=?",
        (int(row["org_id"] or 1),),
    ).fetchone()
    if _org:
        account.update({
            "org_name": _org["name"], "org_code": _org["code"],
            "org_plan": _org["plan"], "org_expires_at": _org["expires_at"],
        })
    return {
        "ok": True,
        "token": token,
        "expires_in": SESSION_MINUTES * 60,
        "account": account,
    }




@router.get("/api/admin/me")
def admin_me(token: str = ""):
    """校验会话并返回当前账号（刷新页面时用它恢复登录态）。"""
    acc = require_login(token)
    # 机构档与机构名：界面靠这两个字段收口导航（C 批）。
    # 角色只从 orgctx 出，前端不自己认字面量——四档一改就前后端分叉。
    org_row = get_conn().execute(
        "SELECT id, code, name, plan, expires_at, activity_quota FROM organization WHERE id=?",
        (orgctx.org_id_of(acc),),
    ).fetchone()
    return {
        "ok": True,
        "expires_in": SESSION_MINUTES * 60,
        "account": {
            "id": acc["id"], "username": acc["username"], "role": acc["role"],
            "can_full_phone": bool(acc["can_full_phone"]),
            "can_export": bool(acc["can_export"]),
            "is_super": acc["username"] == SUPER_ADMIN_USERNAME,
            # 平台超管标识（与 login 返回同口径），界面据此显示「机构管理」tab
            "is_platform_admin": orgctx.is_platform_admin(acc),
            # 机构档：platform_admin / org_owner / org_admin / org_user
            "org_role": orgctx.org_role(acc),
            "org_id": orgctx.org_id_of(acc),
            "org_name": (org_row["name"] if org_row else ""),
            "org_code": (org_row["code"] if org_row else ""),
            "org_plan": (org_row["plan"] if org_row else ""),
            "org_expires_at": (org_row["expires_at"] if org_row else None),
            # 活动级权限可观测：后台展示「这个权限从哪来」，出问题时不用猜
            "activity_role": acc.get("activity_role"),
            "activity_role_source": acc.get("activity_role_source"),
            "activity_id": actx.current_id(),
        },
    }




@router.post("/api/admin/logout")
def admin_logout(body: dict):
    """退出登录：删除该会话。"""
    token = (body or {}).get("token") or ""
    if token and token != ADMIN_TOKEN:
        conn = get_conn()
        conn.execute("DELETE FROM account_session WHERE token_hash=?", (token_digest(token),))
        conn.commit()
    return {"ok": True}




@router.post("/api/admin/password")
def admin_change_password(body: PasswordIn):
    """任何人可改自己的登录密码；改完踢掉该账号其它会话，当前会话保留。"""
    acc = require_login(body.token)
    if acc.get("bootstrap"):
        raise HTTPException(400, "应急口令登录不支持改密，请用 admin 账号登录")
    # 公开演示账号禁止改密：demo/demo 是全平台通用口令，
    # 一旦被某个访客改掉，后续所有人都登不进来，演示就废了。
    if acc.get("username") == "demo":
        raise HTTPException(400, "演示账号不支持修改密码")
    new = body.new_password or ""
    if len(new) < PASSWORD_MIN:
        raise HTTPException(400, "新密码至少 %d 位" % PASSWORD_MIN)
    conn = get_conn()
    row = conn.execute("SELECT pass_hash FROM account WHERE id=?", (acc["id"],)).fetchone()
    if not row or not verify_password(body.old_password, row["pass_hash"]):
        raise HTTPException(400, "原密码不正确")
    with transaction() as c:
        c.execute("UPDATE account SET pass_hash=?, updated_at=? WHERE id=?",
                  (hash_password(new), now_iso(), acc["id"]))
        c.execute("DELETE FROM account_session WHERE account_id=? AND token_hash<>?",
                  (acc["id"], token_digest(body.token)))
    write_admin_log("password_change", "修改本人登录密码", acc["username"])
    return {"ok": True}




@router.get("/api/admin/accounts")
def admin_accounts(token: str = ""):
    """账号列表（机构负责人及以上）。

    可见范围两层收口：
    - 机构：平台超管看全部，其余只看**本机构**的账号。C 批之前这里是一张
      全表查询，机构 A 的负责人能看见机构 B 的账号——多机构一上线就是事故。
    - 层级：非平台超管看不到平台超管那一行，连用户名都不下发。
    """
    acc = require_org_owner(token)
    viewer_is_super = orgctx.is_platform_admin(acc)
    conn = get_conn()
    if viewer_is_super:
        rows = conn.execute(
            "SELECT * FROM account ORDER BY (role IN ('admin','platform_admin')) DESC, id"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM account WHERE org_id=?"
            " ORDER BY (role IN ('org_owner')) DESC, id",
            (orgctx.org_id_of(acc),),
        ).fetchall()
    # 超管行对非超管一律不下发：连用户名都不该让人看到，更别说改
    out = [account_public(r) for r in rows
           if viewer_is_super or r["username"] != SUPER_ADMIN_USERNAME]
    return {"ok": True, "rows": out, "viewer_is_super": viewer_is_super}




@router.post("/api/admin/accounts")
def admin_account_create(body: AccountIn):
    """新增后台账号（仅 admin）：设账号、初始密码、角色与两项权限。"""
    acc = require_admin(body.token)
    username = (body.username or "").strip()
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "账号需为 3—20 位字母、数字或 _ . -")
    if len(body.password or "") < PASSWORD_MIN:
        raise HTTPException(400, "初始密码至少 %d 位" % PASSWORD_MIN)
    # 目标机构：平台超管可指定（跨机构开户走这里），其余一律落到自己机构。
    # 不照 body 落库——机构管理员在请求体里填个 org_id 就能往别的机构塞账号。
    if orgctx.is_platform_admin(acc):
        org_id = int(body.org_id or orgctx.org_id_of(acc))
    else:
        org_id = orgctx.org_id_of(acc)
        if body.org_id and int(body.org_id) != org_id:
            raise HTTPException(403, "不能为其它机构建账号")
    # 角色只收四档。旧值兼容：admin 视作平台超管档、staff 视作普通用户档。
    role = orgctx.norm_role(body.role)
    if role in (orgctx.PLATFORM_ADMIN, orgctx.ORG_OWNER) and not orgctx.is_org_owner(acc):
        raise HTTPException(403, "该角色只能由机构负责人或平台超管设置")
    if role == orgctx.ORG_OWNER and not orgctx.is_platform_admin(acc):
        # 负责人是机构与平台的签约方，只能由平台开户或自助开通产生，
        # 否则机构内部自己就能换签的人。
        raise HTTPException(403, "机构负责人账号由平台开通，机构后台不能自行创建")
    # 账号名会出现在成员矩阵、核销流水「操作人」与导出列上
    riskword.guard({"账号名": username}, where="account_create", acc=acc)
    conn = get_conn()
    if conn.execute("SELECT id FROM account WHERE username=?", (username,)).fetchone():
        # 账号名全局唯一，但跨机构撞名不该告诉对方「这个名字存在」
        raise HTTPException(400, "该账号不可用，请换一个")
    with transaction() as c:
        insert_row(c, "account", {
            "username": username,
            "pass_hash": hash_password(body.password),
            "role": role,
            "org_id": org_id,
            "can_full_phone": 1 if body.can_full_phone else 0,
            "can_export": 1 if body.can_export else 0,
            "enabled": 1,
            "created_at": now_iso(),
        })
    write_admin_log("account_create", "新增账号 %s（%s）" % (username, role), acc["username"])
    return {"ok": True}




@router.post("/api/admin/accounts/update")
def admin_account_update(body: AccountUpdateIn):
    """改角色/权限/启停/重置密码（机构负责人及以上）。不允许对自己降权或停用。"""
    acc = require_org_owner(body.token)
    conn = get_conn()
    row = conn.execute("SELECT * FROM account WHERE id=?", (body.id,)).fetchone()
    if not row:
        raise HTTPException(404, "账号不存在")
    # 同机构才能改：否则机构负责人拿到别家账号 id 就能重置别人密码
    if not orgctx.is_platform_admin(acc) and int(row["org_id"] or 1) != orgctx.org_id_of(acc):
        raise HTTPException(404, "账号不存在")
    is_self = (row["id"] == acc["id"])
    # 超级管理员受保护：其他管理员不得改它的角色、权限、启停与密码
    if row["username"] == SUPER_ADMIN_USERNAME and not is_self:
        raise HTTPException(403, "超级管理员账号仅本人可修改，其他管理员无权变更")
    sets, params, changes = [], [], []

    if body.role is not None:
        new_role = orgctx.norm_role(body.role)
        if new_role in (orgctx.PLATFORM_ADMIN, orgctx.ORG_OWNER) and not orgctx.is_platform_admin(acc):
            # 机构后台升不出更高的档，也换不了签约主体
            raise HTTPException(403, "该角色只能由平台超管设置")
        if is_self and new_role != orgctx.org_role(acc):
            raise HTTPException(400, "不能修改自己的角色")
        # 本机构最后一个负责人不能被降级：那等于把机构锁在门外，
        # 后续所有账号管理都无人可做，只能平台手工捞。
        if orgctx.org_role(row) == orgctx.ORG_OWNER and new_role != orgctx.ORG_OWNER:
            n = conn.execute(
                "SELECT COUNT(*) FROM account WHERE org_id=? AND role='org_owner' AND enabled=1",
                (int(row["org_id"] or 1),),
            ).fetchone()[0]
            if n <= 1:
                raise HTTPException(400, "该机构至少要保留一个机构负责人")
        sets.append("role=?"); params.append(new_role)
        changes.append("角色=%s" % new_role)

    for field, label in (("can_full_phone", "看全号"), ("can_export", "导出")):
        v = getattr(body, field)
        if v is not None:
            sets.append("%s=?" % field); params.append(1 if v else 0)
            changes.append("%s=%s" % (label, "开" if v else "关"))

    if body.enabled is not None:
        if is_self and not body.enabled:
            raise HTTPException(400, "不能停用自己的账号")
        sets.append("enabled=?"); params.append(1 if body.enabled else 0)
        changes.append("启用" if body.enabled else "停用")
        if not body.enabled:
            conn.execute("DELETE FROM account_session WHERE account_id=?", (row["id"],))

    if body.password:
        if len(body.password) < PASSWORD_MIN:
            raise HTTPException(400, "密码至少 %d 位" % PASSWORD_MIN)
        sets.append("pass_hash=?"); params.append(hash_password(body.password))
        changes.append("重置密码")
        conn.execute("DELETE FROM account_session WHERE account_id=?", (row["id"],))

    if not sets:
        return {"ok": True, "changed": 0}
    sets.append("updated_at=?"); params.append(now_iso()); params.append(row["id"])
    with transaction() as c:
        c.execute("UPDATE account SET " + ", ".join(sets) + " WHERE id=?", params)
    write_admin_log("account_update", "修改账号 %s：%s" % (row["username"], "、".join(changes)), acc["username"])
    return {"ok": True, "changed": len(changes)}




@router.post("/api/admin/accounts/delete")
def admin_account_delete(body: AccountIdIn):
    """删除后台账号（仅 admin）。

    安全约束：
    - 只能删「已停用」的账号，运行中的账号必须先停用，避免误删后无法追溯；
    - 不能删自己；
    - 超级管理员账号不可删；
    - 删除时连带清掉该账号的登录会话与关联的现场核销凭证，防止离职人员仍能核销。
    """
    acc = require_org_owner(body.token)
    conn = get_conn()
    row = conn.execute("SELECT * FROM account WHERE id=?", (body.id,)).fetchone()
    if not row:
        raise HTTPException(404, "账号不存在")
    # 同机构才能删：跨机构删除连「不存在」都不该区分，统一 404 更少泄漏
    if not orgctx.is_platform_admin(acc) and int(row["org_id"] or 1) != orgctx.org_id_of(acc):
        raise HTTPException(404, "账号不存在")
    if row["id"] == acc["id"]:
        raise HTTPException(400, "不能删除自己的账号")
    if row["username"] == SUPER_ADMIN_USERNAME:
        raise HTTPException(403, "超级管理员账号不可删除")
    if row["enabled"]:
        raise HTTPException(400, "只能删除已停用的账号，请先停用再删")
    name = row["username"]
    with transaction() as c:
        c.execute("DELETE FROM account_session WHERE account_id=?", (row["id"],))
        # 关联的核销人员同样软删除：历史核销流水要靠 staff 行显示操作人，真删了就对不上账
        c.execute(
            "UPDATE staff SET deleted_at=?, enabled=0, openid=NULL, token=? "
            "WHERE account_id=? AND deleted_at IS NULL",
            (now_iso(), secrets.token_hex(16), row["id"]),
        )
        c.execute("DELETE FROM account WHERE id=?", (row["id"],))
    write_admin_log("account_delete", "删除账号 %s" % name, acc["username"])
    return {"ok": True}




@router.get("/api/admin/checkins/export")
def export_checkins(token: str = ""):
    """签到流水导出 CSV（需导出权限）。"""
    acc = require_perm(token, "can_export")
    # 有导出权但无「完整信息」权：导出的姓名与手机号一律脱敏，防止靠导出绕过界面限制
    exp_full = bool(acc["can_full_phone"])
    conn = get_conn()
    rows = conn.execute(
        """SELECT c.checked_at, c.method,
                  COALESCE(c.name, r.name) AS name,
                  COALESCE(c.phone, r.phone) AS phone,
                  c.channel, r.credential_code, s.username AS staff_name
           FROM checkin c
           LEFT JOIN registration r ON r.id = c.registration_id
           LEFT JOIN staff s ON s.id = c.staff_id
           WHERE c.checked_at IS NOT NULL AND c.is_smoke IS NOT 1
             AND COALESCE(r.status, 'active') <> 'draft'
           ORDER BY c.id"""
    ).fetchall()
    method_cn = {"self": "自助签到", "verify": "人工核销", "walkin": "现场补录",
                 "manual": "后台手工签到"}

    def esc(v):
        t = "" if v is None else str(v)
        if "," in t or '"' in t or "\n" in t:
            t = '"' + t.replace('"', '""') + '"'
        return t

    header = ["序号", "签到时间", "方式", "姓名", "手机号", "来源渠道", "凭证码", "操作人"]
    lines = [",".join(header)]
    for i, r in enumerate(rows, 1):
        lines.append(",".join([
            esc(i), esc(r["checked_at"]), esc(method_cn.get(r["method"], r["method"])),
            esc(show_name(r["name"], exp_full)), esc(show_phone(r["phone"], exp_full)), esc(r["channel"]),
            esc(r["credential_code"]), esc(r["staff_name"] or ""),
        ]))
    csv_text = "\n".join(lines) + "\n"
    with transaction() as c:
        insert_row(c, "export_log", {
            "operator": acc["username"], "row_count": len(rows), "created_at": now_iso(),
        })
    write_admin_log("export", "导出签到流水 %d 行" % len(rows), acc["username"])
    return PlainTextResponse(
        csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=meeting_checkins.csv"},
    )




@router.get("/api/admin/card-actions")
def admin_card_actions(token: str = "", page: int = 1, size: int = 20, full: int = 0):
    """领卡行为统计与明细：两类点击数、去重人数、来源分布，分页明细。需登录。"""
    acc = require_login(token)
    page, size = page_params(page, size)
    show_full = bool(full)
    if show_full and not acc["can_full_phone"]:
        raise HTTPException(403, "当前账号无查看完整手机号权限")
    conn = get_conn()
    total = conn.execute("SELECT COUNT(*) FROM card_action").fetchone()[0]
    stats = {}
    for act in CARD_ACTIONS:
        cnt = conn.execute(
            "SELECT COUNT(*) FROM card_action WHERE action=?", (act,)
        ).fetchone()[0]
        users = conn.execute(
            "SELECT COUNT(DISTINCT COALESCE(NULLIF(phone,''), NULLIF(openid,''), NULLIF(name,''))) "
            "FROM card_action WHERE action=?", (act,)
        ).fetchone()[0]
        stats[act] = {"count": cnt, "users": users}
    # 转化率的分母：与 /api/stats 完全同口径（排除冒烟数据、只算 active），
    # 两处数字必须能对上，否则运营会拿着两个不一样的「报名人数」来问。
    base_registered = conn.execute(
        "SELECT COUNT(*) FROM registration WHERE is_smoke IS NOT 1 AND status='active'"
    ).fetchone()[0]
    base_checked = conn.execute(
        "SELECT COUNT(DISTINCT c.registration_id) FROM checkin c "
        "JOIN registration r ON r.id = c.registration_id "
        "WHERE c.checked_at IS NOT NULL AND c.is_smoke IS NOT 1 AND r.status='active'"
    ).fetchone()[0]
    by_source = {}
    for r in conn.execute(
        "SELECT COALESCE(NULLIF(source,''),'未标注') AS s, COUNT(*) AS n "
        "FROM card_action GROUP BY s"
    ).fetchall():
        by_source[r["s"]] = r["n"]
    rows = conn.execute(
        """SELECT name, phone, openid, action, source, visit_id, created_at
           FROM card_action ORDER BY id DESC LIMIT ? OFFSET ?""",
        (size, (page - 1) * size),
    ).fetchall()
    items = []
    for r in rows:
        items.append({
            "name": show_name(r["name"], show_full),
            "phone": (r["phone"] or "") if show_full else mask_phone(r["phone"] or ""),
            "openid": r["openid"] or "",
            "action": r["action"],
            "source": r["source"] or "",
            "visit_id": r["visit_id"] or "",
            "created_at": r["created_at"],
        })
    if show_full:
        write_admin_log("view_full_phone", "查看完整信息（领卡行为）%d 行" % len(items), acc["username"])
    return {
        "ok": True,
        "total": total,
        "page": page,
        "size": size,
        "stats": stats,
        "base": {"registered": base_registered, "checked_in": base_checked},
        "by_source": by_source,
        "rows": items,
    }




@router.get("/api/admin/card-actions/export")
def export_card_actions(token: str = ""):
    """领卡行为导出：逐条点击记录 + 报名/签到时间，便于与名单比对。需导出权限。"""
    acc = require_perm(token, "can_export")
    # 有导出权但无「完整信息」权：导出的姓名与手机号一律脱敏，防止靠导出绕过界面限制
    exp_full = bool(acc["can_full_phone"])
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT a.created_at, a.name, a.phone, a.openid, a.action, a.source, a.visit_id,
               r.created_at AS reg_at, r.channel, r.credential_code,
               c.checked_at
        FROM card_action a
        LEFT JOIN registration r ON r.openid = a.openid
        LEFT JOIN checkin c ON c.registration_id = r.id AND c.checked_at IS NOT NULL
        ORDER BY a.id
        """
    ).fetchall()

    def esc(v):
        s = "" if v is None else str(v)
        if "," in s or '"' in s or "\n" in s:
            s = '"' + s.replace('"', '""') + '"'
        return s

    header = ["序号", "行为", "来源页", "行为时间", "姓名", "手机号", "openid", "访问ID",
              "报名时间", "来源渠道", "凭证码", "签到时间"]
    lines = [",".join(header)]
    for i, r in enumerate(rows, 1):
        lines.append(",".join([
            esc(i), esc(CARD_ACTION_CN.get(r["action"], r["action"])),
            esc(r["source"]), esc(r["created_at"]),
            esc(show_name(r["name"], exp_full)), esc(show_phone(r["phone"], exp_full)),
            esc(r["openid"]), esc(r["visit_id"]),
            esc(r["reg_at"]), esc(r["channel"]), esc(r["credential_code"]),
            esc(r["checked_at"] or "未签到"),
        ]))
    csv_text = "\n".join(lines) + "\n"
    with transaction() as c:
        insert_row(c, "export_log", {
            "operator": "admin",
            "row_count": len(rows),
            "created_at": now_iso(),
        })
    write_admin_log("export", "导出领卡行为记录 %d 行" % len(rows), acc["username"])
    return PlainTextResponse(
        csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=meeting_card_actions.csv"},
    )


# ---- 测试环境专用：一键清除前端测试数据 -------------------------------------
# 只清「前端动作产生的业务数据」，配置类与账号类一律不动：
#   清：registration / checkin / card_claim / card_action / events
#   留：account / account_session / staff / staff_bind_ticket / site_config / gate_config
#       admin_log（审计留痕）、export_log（导出记录）
# 三道闸门，任缺其一都拒绝：DB_ENV 不得为 prod、必须是管理员、必须带确认串。
PURGE_TEST_TABLES = ["card_action", "card_claim", "events", "checkin", "registration"]
PURGE_CONFIRM = "PURGE_TEST_DATA"


class PurgeTestDataIn(BaseModel):
    token: str = ""
    confirm: str = ""


@router.post("/api/admin/dev/purge-test-data")
def admin_purge_test_data(body: PurgeTestDataIn):
    """测试环境一键清除报名/签到/领卡/埋点数据（生产不可用）。

    安全边界按「环境变量在服务端判定」实现，不信任前端传参：
    生产部署 DB_ENV=prod，此处直接 403，代码层面无法误清生产库。
    """
    acc = require_admin(body.token)
    if DB_ENV == "prod":
        raise HTTPException(403, "生产环境禁止清除数据，本功能仅在测试环境开放")
    if (body.confirm or "") != PURGE_CONFIRM:
        raise HTTPException(400, "确认参数不正确，未执行任何操作")

    counts = {}
    with transaction() as c:
        for t in PURGE_TEST_TABLES:
            n = c.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
            c.execute("DELETE FROM %s" % t)
            counts[t] = n
        # 自增 id 归零：测试环境重来一遍时编号从 1 开始，便于对照日志
        for t in PURGE_TEST_TABLES:
            try:
                c.execute("DELETE FROM sqlite_sequence WHERE name=?", (t,))
            except sqlite3.OperationalError:
                break          # 无 AUTOINCREMENT 表时该表不存在，跳过即可
    total = sum(counts.values())
    write_admin_log(
        "purge_test_data",
        "清除测试数据 %d 条：%s" % (total, json.dumps(counts, ensure_ascii=False)),
        acc["username"],
    )
    # 计数一并归零：清完数据重测时不该被上一轮的频率限制挡着
    limit.reset()
    logx.ev("purge_ok", user=acc["username"], total=total, env=DB_ENV)
    return {"ok": True, "env": DB_ENV, "total": total, "counts": counts}




# ============================================================
# 数据统计（v130）：访问 UV/PV、渠道归因、设备分布、转化漏斗
#
# 平台化演进说明：
#   一期（当前）直接读 events 的 payload JSON，在 Python 侧聚合。
#   项目规模小（生产数百行，峰值也就几万行），无需新建表。
#   二期量上来后，把 _stats_rows() 换成读 daily_stats 日汇总表
#   （dt / channel / os / uv / pv 预聚合），上层聚合逻辑保持不变即可。
# ============================================================

def _ds_cell(v):
    s = "" if v is None else str(v)
    if "," in s or '"' in s or "\n" in s:
        s = '"' + s.replace('"', '""') + '"'
    return s


def _ds_date(date_str):
    if not date_str:
        return None
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
        raise HTTPException(400, "日期格式应为 YYYY-MM-DD")
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "日期不存在：%s" % date_str)
    return date_str


def _ds_payload(row):
    try:
        return json.loads(row["payload"] or "{}")
    except (ValueError, TypeError):
        return {}


def _ds_rows(conn, start, end, channel, os_name, attribution):
    """取窗口内事件并按渠道/设备筛选。

    兼容老数据：老事件没有 did / os / first_src，分别用 openid / 其他 / from 兜底，
    这样 v130 之前的埋点也能进统计，不用回灌。
    """
    sql = "SELECT openid,event,page,ts,payload FROM events WHERE env=?"
    args = [DB_ENV]
    if start:
        sql += " AND substr(ts,1,10)>=?"
        args.append(start)
    if end:
        sql += " AND substr(ts,1,10)<=?"
        args.append(end)
    out = []
    for r in conn.execute(sql, args).fetchall():
        p = _ds_payload(r)
        ch = p.get("from") or "direct"
        first = p.get("first_src") or ch
        use = first if attribution == "first" else ch
        osv = p.get("os") or "其他"
        if channel and use != channel:
            continue
        if os_name and osv != os_name:
            continue
        out.append({
            "date": (r["ts"] or "")[:10],
            "event": r["event"] or "",
            "page": r["page"] or "",
            "openid": r["openid"] or "",
            "did": p.get("did") or r["openid"] or "",
            "sid": p.get("sid") or p.get("visit_id") or "",
            "identified": bool(p.get("identified")),
            "channel": ch, "first_channel": first, "os": osv,
            "model": p.get("model") or "",
            "screen": p.get("screen") or "",
            "iid": p.get("iid") or "",
        })
    return out


def _ds_aggregate(rows):
    """纯函数：事件列表 → 全部统计指标。二期换数据源时只改上游，这里不动。"""
    def mk():
        return {"uv": set(), "pv": 0, "sessions": set(), "identified": set(), "iids": set()}

    total = mk()
    daily = {}
    by_ch, by_first = {}, {}
    by_os, by_model, by_screen = {}, {}, {}
    funnel = {}

    for e in rows:
        d = e["did"]
        # 按 iid 去重：网络重试 / replaceState 重复渲染可能产生同 iid 的事件
        dedup = e["iid"] and e["iid"] in total["iids"]
        for bucket in (total, daily.setdefault(e["date"], mk()),
                       by_ch.setdefault(e["channel"], mk()),
                       by_first.setdefault(e["first_channel"], mk()),
                       by_os.setdefault(e["os"], mk()),
                       by_model.setdefault(e["model"] or "未知", mk()),
                       by_screen.setdefault(e["screen"] or "未知", mk())):
            if not dedup:
                if d:
                    bucket["uv"].add(d)
                if e["event"] == "pv":
                    bucket["pv"] += 1
                if e["sid"]:
                    bucket["sessions"].add(e["sid"])
                if e["identified"] and e["openid"]:
                    bucket["identified"].add(e["openid"])
            if e["iid"]:
                bucket["iids"].add(e["iid"])
        # 漏斗：每层按 did 去重，层与层之间的 did 集合可交叉
        for name, hit in (
            ("visit", True),
            ("event", e["page"] == "event"),
            ("signup", e["event"] == "signup_submit"),
            ("card", e["event"] in ("weapp_launch", "card_click")),
        ):
            if hit and d:
                funnel.setdefault(name, set()).add(d)

    def one(b):
        return {"uv": len(b["uv"]), "pv": b["pv"],
                "sessions": len(b["sessions"]), "users": len(b["identified"])}

    def ranked(src, key_name="name"):
        out = []
        for k, b in src.items():
            v = one(b)
            v[key_name] = k
            out.append(v)
        return sorted(out, key=lambda x: (-x["uv"], -x["pv"], x[key_name]))

    kpi = one(total)
    kpi["page_per_uv"] = round(kpi["pv"] / kpi["uv"], 2) if kpi["uv"] else 0
    visit_n = len(funnel.get("visit", set()))
    funnel_out = []
    for key, label in (("visit", "到访"), ("event", "浏览活动"),
                       ("signup", "提交报名"), ("card", "领卡")):
        n = len(funnel.get(key, set()))
        funnel_out.append({"key": key, "label": label, "uv": n,
                           "rate": round(n / visit_n, 4) if visit_n and key != "visit" else (1 if key == "visit" else 0)})
    kpi["signup_rate"] = round(len(funnel.get("signup", set())) / kpi["uv"], 4) if kpi["uv"] else 0

    return {
        "kpi": kpi,
        "trend": [dict(one(b), date=d) for d, b in sorted(daily.items())],
        "channels": ranked(by_ch),
        "first_channels": ranked(by_first),
        "devices": ranked(by_os),
        "models": ranked(by_model),
        "screens": ranked(by_screen),
        "funnel": funnel_out,
    }


def _ds_shift(date_str, days):
    d = datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=days)
    return d.strftime("%Y-%m-%d")


def _ds_delta(cur, prev):
    if prev is None:
        return None
    # 上期为 0、本期有数：记成 +100%（新增），而不是 null——null 只用于没有对比窗口
    if prev == 0:
        return 1 if cur else 0
    return round((cur - prev) / prev, 4)


@router.get("/api/admin/stats/overview")
def admin_stats_overview(token: str = "", start: str = "", end: str = "",
                         channel: str = "", os: str = "", attribution: str = "last"):
    """数据统计总览：日期/渠道/设备三维筛选，UV/PV/渠道/设备/漏斗一并返回。

    attribution=last 按本次来源（默认，与报名渠道口径一致），first 按首次触点看拉新。
    只认登录态；导出另走带 can_export 权限的接口。
    """
    require_login(token)
    start, end = _ds_date(start), _ds_date(end)
    if start and end and start > end:
        raise HTTPException(400, "开始日期不能晚于结束日期")
    if attribution not in ("last", "first"):
        attribution = "last"
    conn = get_conn()
    rows = _ds_rows(conn, start, end, channel, os, attribution)
    data = _ds_aggregate(rows)

    # 环比：仅在明确给了完整起止日期时算，取紧邻的等长窗口
    delta = None
    if start and end:
        span = (datetime.strptime(end, "%Y-%m-%d") - datetime.strptime(start, "%Y-%m-%d")).days + 1
        ps, pe = _ds_shift(start, -span), _ds_shift(start, -1)
        prev = _ds_aggregate(_ds_rows(conn, ps, pe, channel, os, attribution))["kpi"]
        delta = {"uv": _ds_delta(data["kpi"]["uv"], prev["uv"]),
                 "pv": _ds_delta(data["kpi"]["pv"], prev["pv"]),
                 "sessions": _ds_delta(data["kpi"]["sessions"], prev["sessions"])}

    today = now_iso()[:10]
    today_row = next((x for x in data["trend"] if x["date"] == today), None)
    return {"ok": True, "window": {"start": start, "end": end,
                                   "channel": channel, "os": os, "attribution": attribution},
            "generated_at": now_iso(),
            "kpi": data["kpi"], "trend": data["trend"],
            "channels": data["channels"], "first_channels": data["first_channels"],
            "devices": data["devices"], "models": data["models"], "screens": data["screens"],
            "funnel": data["funnel"],
            "today": {"uv": today_row["uv"] if today_row else 0,
                      "pv": today_row["pv"] if today_row else 0},
            "delta": delta}


@router.get("/api/admin/stats/export")
def admin_stats_export(token: str = "", start: str = "", end: str = "",
                       channel: str = "", os: str = "", attribution: str = "last",
                       kind: str = "summary"):
    """导出统计数据表。summary=汇总（趋势/渠道/设备/漏斗），events=事件明细。
    明细里的 openid 按账号权限脱敏；did/sid 保留供运营做渠道对账。
    """
    acc = require_perm(token, "can_export")
    exp_full = bool(acc["can_full_phone"])
    start, end = _ds_date(start), _ds_date(end)
    if start and end and start > end:
        raise HTTPException(400, "开始日期不能晚于结束日期")
    if attribution not in ("last", "first"):
        attribution = "last"
    conn = get_conn()
    rows = _ds_rows(conn, start, end, channel, os, attribution)
    data = _ds_aggregate(rows)

    lines = []
    if kind == "events":
        lines.append(",".join(["时间", "事件", "页面", "openid", "设备号", "会话号",
                               "本次来源", "首次来源", "系统", "机型", "屏幕"]))
        for e in sorted(rows, key=lambda x: x["date"]):
            lines.append(",".join([
                _ds_cell(e["date"]), _ds_cell(e["event"]), _ds_cell(e["page"]),
                _ds_cell(e["openid"] if exp_full else logx.mask_openid(e["openid"])),
                _ds_cell(e["did"]), _ds_cell(e["sid"]),
                _ds_cell(e["channel"]), _ds_cell(e["first_channel"]),
                _ds_cell(e["os"]), _ds_cell(e["model"]), _ds_cell(e["screen"]),
            ]))
        fname = "meeting_stats_events.csv"
    else:
        k = data["kpi"]
        lines.append("指标,数值")
        for label, key in (("访客UV", "uv"), ("页面PV", "pv"), ("会话数", "sessions"),
                           ("识别用户数", "users"), ("人均浏览页数", "page_per_uv"),
                           ("访客报名转化率", "signup_rate")):
            lines.append("%s,%s" % (label, _ds_cell(k[key])))
        lines.append("")
        lines.append("日期,访客UV,页面PV,会话数,识别用户数")
        for t in data["trend"]:
            lines.append(",".join([_ds_cell(t["date"]), str(t["uv"]), str(t["pv"]),
                                   str(t["sessions"]), str(t["users"])]))
        lines.append("")
        for title, key, name in (("本次来源", "channels", "来源"),
                                 ("首次来源", "first_channels", "首次来源"),
                                 ("设备大类", "devices", "系统"),
                                 ("机型", "models", "机型")):
            lines.append("%s,访客UV,页面PV" % title)
            for x in data[key]:
                lines.append(",".join([_ds_cell(x["name"]), str(x["uv"]), str(x["pv"])]))
            lines.append("")
        lines.append("转化环节,访客UV,上层转化率")
        for f in data["funnel"]:
            lines.append(",".join([_ds_cell(f["label"]), str(f["uv"]),
                                   str(round(f["rate"] * 100, 1))]))
        lines.append("")
        lines.append("归因口径,%s" % ("首次触点" if attribution == "first" else "末次触点"))
        lines.append("筛选渠道,%s" % _ds_cell(channel or "全部"))
        lines.append("筛选系统,%s" % _ds_cell(os or "全部"))
        fname = "meeting_stats_summary.csv"

    csv_text = "\n".join(lines) + "\n"
    with transaction() as c:
        insert_row(c, "export_log", {
            "operator": acc["username"], "row_count": len(rows), "created_at": now_iso(),
        })
    write_admin_log("export", "导出数据统计%s %d 行" % (kind, len(rows)), acc["username"])
    return PlainTextResponse(
        "\ufeff" + csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=" + fname},
    )


# ============ 平台层：活动管理（P1 最小版）============
# 这几个接口是**平台级**的，不按活动上下文过滤：管理员要能看到、能管全部活动。
# activity 表本身也刻意没有启用行级安全，同一个理由。

class ActivityIn(BaseModel):
    # 留空＝由系统生成一个未被占用的短码。运营想用可读的名字（如 summit2026）
    # 就自己填，填了按规则校验、按唯一性查重。允许留空是为了让新建活动这一步
    # 不卡在一个「想不出短码」的输入框上——短码是内部标识，不是给客户看的东西。
    code: str = ""
    name: str
    org_id: int = 1
    domain: Optional[str] = None
    theme: Optional[str] = None
    start_at: Optional[str] = None
    end_at: Optional[str] = None


class ActivityPatch(BaseModel):
    name: Optional[str] = None
    domain: Optional[str] = None
    theme: Optional[str] = None
    intro: Optional[str] = None
    status: Optional[str] = None
    start_at: Optional[str] = None
    end_at: Optional[str] = None


# 活动短码进 URL 路径，只允许小写字母数字与 - _；首字符必须是字母或数字。
# 限制得严一点，是为了避免出现 /e/../ 这类能穿目录的名字。
#
# 最短 5 位（总长 5—32）：机构子域下短码直接是一级路径段
# （`demo.example.com/summit2026`），太短容易与静态目录、后台入口这类
# 保留段混淆，也更容易被顺手猜中。**只约束新建与改码**，历史短码不回溯校验
# ——`demo` 这类 4 位老码仍在线上跑，链接不能因为它变短就失效。
_ACT_CODE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{4,31}$")   # 首字符 + 至少 4 = 5 位起
ACT_CODE_MIN = 5
ACT_CODE_MAX = 32


def _gen_act_code(conn, tries: int = 12) -> str:
    """生成一个未被占用的活动短码。复用物料码字符集：剔除 0/1/l/i/o。

    为什么不用纯数字或时间戳：短码会被念出来（电话里报给客户）、写进工单，
    易混字符是真实成本。6 位 32 字符集有 10 亿种，撞了重试即可。
    """
    import db as _db
    for _ in range(tries):
        code = _db.gen_material_code(6)
        if not conn.execute("SELECT 1 FROM activity WHERE code=?", (code,)).fetchone():
            return code
    raise HTTPException(500, "短码生成失败，请重试或手动填写")


def _act_dict(r):
    return {
        "id": r["id"], "org_id": r["org_id"], "code": r["code"], "name": r["name"],
        "status": r["status"], "domain": r["domain"], "theme": r["theme"],
        "intro": intro_def.parse(r["intro"]) if "intro" in r.keys() else None,
        "start_at": r["start_at"], "end_at": r["end_at"], "created_at": r["created_at"],
    }


@router.get("/api/admin/activities")
def admin_activity_list(token: str = ""):
    """活动列表（本机构；平台超管为全平台）。

    额外给两个数，都是运营在下手前必须先看见的：
    - `reg_count`：该活动现有的正式报名数（草稿态的不算，口径与全站一致）
    - `pending_draft`：草稿态活动里「这一轮测试数据」的条数，即发布时会归档多少条。
      没有它，发布按钮的确认框只能写「将归档测试数据」这种说不清后果的话。

    C 批收口：机构负责人/管理员看本机构全部活动，普通用户看被授权的活动，
    平台超管看全部。收口在活动列表这一处，切换器与活动管理页同时生效——
    两个地方各写一遍过滤，迟早有一处忘改。
    """
    acc = require_login(token)
    import perm as _perm
    ids = _perm.accessible_activity_ids(acc)
    conn = get_conn()
    if ids is None:
        rows = conn.execute(
            "SELECT id, org_id, code, name, status, domain, theme, intro, start_at, end_at, created_at"
            " FROM activity ORDER BY id"
        ).fetchall()
    else:
        if not ids:
            return {"ok": True, "rows": []}
        ph = ",".join("?" for _ in ids)
        rows = conn.execute(
            "SELECT id, org_id, code, name, status, domain, theme, intro, start_at, end_at, created_at"
            " FROM activity WHERE id IN (" + ph + ") ORDER BY id", ids
        ).fetchall()
    # 一条 SQL 取两个数：正式报名数按 status='active'；待归档数在此基础上再按 draft_at 划界
    stat = {}
    for r in conn.execute(
        "SELECT a.id AS aid,"
        " SUM(CASE WHEN r.status='active' THEN 1 ELSE 0 END) AS reg,"
        " SUM(CASE WHEN r.status='active' AND a.status='draft'"
        "      AND (a.draft_at IS NULL OR r.created_at >= a.draft_at) THEN 1 ELSE 0 END) AS pend"
        " FROM activity a LEFT JOIN registration r ON r.activity_id=a.id"
        " GROUP BY a.id"
    ).fetchall():
        stat[r["aid"]] = (r["reg"] or 0, r["pend"] or 0)
    out = []
    for r in rows:
        d = _act_dict(r)
        reg, pend = stat.get(r["id"], (0, 0))
        d["reg_count"], d["pending_draft"] = reg, pend
        out.append(d)
    return {"ok": True, "rows": out}


@router.post("/api/admin/activities")
def admin_activity_create(body: ActivityIn, token: str = ""):
    """新建活动。"""
    acc = require_admin(token)
    code = (body.code or "").strip().lower()
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "活动名称不能为空")
    if code and not _ACT_CODE_RE.match(code):
        raise HTTPException(
            400, "活动短码需为 %d—%d 位小写字母/数字/-/_，且以字母或数字开头"
                 % (ACT_CODE_MIN, ACT_CODE_MAX))
    if code == actx.DEFAULT_CODE:
        raise HTTPException(400, "短码 default 为系统保留，请换一个")
    # 机构只从会话来（A 批铁律）。body.org_id 只对平台超管有效——机构管理员
    # 在请求体里填别家 org_id 就能往别人名下建活动，这是最省事的一条越权路。
    if orgctx.is_platform_admin(acc):
        org_id = int(body.org_id or orgctx.org_id_of(acc))
    else:
        org_id = orgctx.org_id_of(acc)
    # 冻结期不能新建活动（方案「只读冻结」口径）。这里拦比界面置灰可靠：
    # 界面只是提示，接口才是边界。
    try:
        orgstate.assert_writable(org_id, "新建活动")
    except orgstate.OrgFrozen as e:
        raise HTTPException(403, e.message)

    # 风控（2026-11-25 扩面）：活动名进页面标题、分享卡片与机构门户列表，
    # 是访客看到的第一句话。
    riskword.guard({"活动名称": body.name}, where="activity_create", acc=acc)

    conn = get_conn()

    # 活动数配额。口径「未停用活动数」= status<>archived，归档即释放。
    # 默认机构豁免：它是平台自用的兜底租户（org_id=1），不该被商业配额卡住
    # ——否则本地一建测试活动就报「配额已满」。
    _org = conn.execute(
        "SELECT code, activity_quota FROM organization WHERE id=?", (org_id,)
    ).fetchone()
    if _org and _org["code"] != "default":
        used = conn.execute(
            "SELECT COUNT(*) FROM activity WHERE org_id=? AND status<>'archived'",
            (org_id,)
        ).fetchone()[0]
        if _org["activity_quota"] and used >= _org["activity_quota"]:
            raise HTTPException(
                403, "已达活动数配额（%d 场）。请先停用（归档）不需要的活动，"
                     "或联系平台扩容。" % _org["activity_quota"])

    if not code:
        code = _gen_act_code(conn)
    elif conn.execute("SELECT 1 FROM activity WHERE code=?", (code,)).fetchone():
        raise HTTPException(400, "该短码已被占用，请换一个")

    domain = domx.norm(body.domain) or None
    _check_activity_domain(conn, 0, domain, org_id)

    try:
        start_at = norm_iso(body.start_at, "开始时间") if body.start_at else None
        end_at = norm_iso(body.end_at, "结束时间") if body.end_at else None
    except ValueError as e:
        raise HTTPException(400, str(e))

    now = now_iso()
    with transaction() as c:
        c.execute(
            "INSERT INTO activity (org_id, code, name, status, domain, theme, start_at, end_at, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (org_id, code, name, "active", domain, body.theme, start_at, end_at, now),
        )
        row = c.execute("SELECT id FROM activity WHERE code=?", (code,)).fetchone()
        aid = row["id"]
    actx.invalidate(code)
    write_admin_log("activity_create", "新建活动 %s（%s）id=%s" % (name, code, aid), acc["username"])
    return {"ok": True, "id": aid, "code": code}


def _check_activity_domain(conn, aid: int, dom, org_id: int) -> None:
    """活动域名统一校验：能力位 / 保留域 / 跨层占用。

    创建与修改都走这一处。分开写两份的下场是：改的那头加了门禁、建的那头没加，
    于是「先建活动时带上域名」就能绕过去。
    aid=0 表示新建（还没有 id），此时按机构授权判，因为机构有专业版就等于
    它能建的活动也有——活动级覆盖在建之前还不存在。
    """
    if not dom:
        return
    ok = domx.activity_has_feature(aid) if aid else domx.org_has_plan(conn, org_id)
    if not ok:
        raise HTTPException(403, "自定义域名是专业版功能，当前版本未开通")
    if domx.is_reserved(dom):
        raise HTTPException(400, "这个域名不能绑定，请用你们自己的域名")
    busy = domx.conflict(conn, "activity", aid or 0, dom)
    if busy:
        raise HTTPException(400, busy)


@router.patch("/api/admin/activities/{aid}")
def admin_activity_update(aid: int, body: ActivityPatch, token: str = ""):
    """改活动信息。短码不可改——它已经进 URL，一改旧链接全断。"""
    acc = require_admin(token)
    # 风控：名称与介绍都直接渲染在参与者首页与分享卡片上，介绍正文最长
    # 12 段 × 120 字，是最容易被当成「宣传位」塞违规内容的地方。
    # intro 可能是 JSON 串也可能是 dict，guard 内部统一转字符串后按子串匹配。
    riskword.guard({"活动名称": body.name, "活动介绍": body.intro},
                   where="activity_update", acc=acc)
    conn = get_conn()
    cur_row = conn.execute("SELECT * FROM activity WHERE id=?", (aid,)).fetchone()
    if not cur_row:
        raise HTTPException(404, "活动不存在")

    sets, params = [], []
    if body.name is not None:
        nm = body.name.strip()
        if not nm:
            raise HTTPException(400, "活动名称不能为空")
        sets.append("name=?"); params.append(nm)
    if body.status is not None:
        if body.status not in ("draft", "active", "archived"):
            raise HTTPException(400, "status 只能是 draft / active / archived")
        sets.append("status=?"); params.append(body.status)
    if body.theme is not None:
        # 未知主题拒绝写入：theme.public_theme 会静默回落默认，
        # 若这里放行，运营选了个拼错的 key 会「保存成功但视觉没变」，
        # 界面上完全看不出哪里错了。宁可当场报错。
        if body.theme not in theme_def.THEMES:
            raise HTTPException(400, "未知主题：%s" % body.theme)
        sets.append("theme=?"); params.append(body.theme)
    if body.intro is not None:
        # 归一化：只留白名单字段、去空值、超长截断。前端传 JSON 串，
        # 空串表示「清空覆盖、恢复默认文案」（normalize 返回 None 落 NULL）。
        sets.append("intro=?"); params.append(intro_def.normalize(body.intro))
    if body.domain is not None:
        dom = domx.norm(body.domain) or None
        _check_activity_domain(conn, aid, dom, orgctx.org_id_of(acc))
        sets.append("domain=?"); params.append(dom)
        # 换域名即新对象：旧验证结果不能带过来
        sets.append("domain_verified=0")
        sets.append("domain_verified_at=NULL")
    for field, label in (("start_at", "开始时间"), ("end_at", "结束时间")):
        v = getattr(body, field)
        if v is not None:
            try:
                sets.append("%s=?" % field)
                params.append(norm_iso(v, label) if v else None)
            except ValueError as e:
                raise HTTPException(400, str(e))

    if not sets:
        raise HTTPException(400, "没有要修改的字段")
    sets.append("updated_at=?")
    params.append(now_iso())
    params.append(aid)
    with transaction() as c:
        c.execute("UPDATE activity SET %s WHERE id=?" % ", ".join(sets), tuple(params))
        if body.status == "archived":
            # 活动归档 = 外部协作者权限自动失效（方案 4.3 第三条）。
            # 不这样做，换场之后合作方的人还挂着这个活动的后台权限。
            # 必须和状态变更同一个事务：要么都生效，要么都不生效。
            import perm as _perm
            n = _perm.disable_all_for_activity(c, aid)
            write_admin_log("activity_archive",
                            "活动 %s 归档，失效 %d 条成员授权" % (aid, n), acc["username"])
    actx.invalidate()

    write_admin_log("activity_update", "修改活动 id=%s：%s" % (aid, ", ".join(s.split("=")[0] for s in sets)), acc["username"])
    return {"ok": True, "id": aid}


@router.post("/api/admin/activities/{aid}/publish")
def admin_activity_publish(aid: int, token: str = ""):
    """发布：把这一轮测试数据归档，活动对外开放。

    **为什么是标记而不是删掉**：删了之后运营想回看「刚才那批人填成什么样」就没了，
    出事也无法复盘。改成把 registration.status 置 'draft'——所有统计、导出、查重、
    已报名判断本来就在过滤 status='active'，这批数据自动从正式口径消失，
    需要时仍然查得到。发布之后立刻再查一遍数字，应该回到发布前的值。

    **划界靠 draft_at**：只标记「进入草稿之后」产生的数据，更早的真实报名一条不碰。
    没有 draft_at（比如老数据、或活动从没切回过草稿）就按「全部 active」处理。
    边界用 `>=` 而不是 `>`：now_iso 只精确到秒，落库时刻与 draft_at 同秒时，
    宁可把这一条也归档（后台查得到、可手工改回），也不要把测试数据留在正式口径里。

    签到不单独标记：checkin 没有 status 列，它的有效性跟着 registration 走，
    统计处补 join 即可（见 checkin 相关查询里的 not_draft 条件）。
    """
    acc = require_admin(token)
    conn = get_conn()
    row = conn.execute(
        "SELECT id, code, name, status, draft_at FROM activity WHERE id=?", (aid,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "活动不存在")
    # archived 不在状态机里往回走：没有这一条，调用发布会把归档活动悄悄复活成 active
    if row["status"] == "archived":
        raise HTTPException(409, "活动已归档，不能再发布")
    if row["status"] == "active":
        return {"ok": True, "status": "active", "marked": 0, "note": "活动已是发布状态"}

    now = now_iso()
    draft_at = row["draft_at"]
    cond = "activity_id=? AND status='active'"
    args = [aid]
    if draft_at:
        cond += " AND created_at >= ?"
        args.append(draft_at)
    with transaction() as c:
        # 先数再改：rowcount 在 pgcompat 的游标上不可靠，不能拿来当返回值
        marked = c.execute(
            "SELECT COUNT(*) FROM registration WHERE " + cond, tuple(args)
        ).fetchone()[0]
        c.execute(
            "UPDATE registration SET status='draft', closed_at=?, closed_by='publish'"
            " WHERE " + cond,
            [now] + args,
        )
        c.execute(
            "UPDATE activity SET status='active', draft_at=NULL, updated_at=? WHERE id=?",
            (now, aid),
        )
    actx.invalidate(row["code"])
    write_admin_log(
        "activity_publish",
        "发布活动 %s（%s）：归档测试报名 %d 条" % (row["name"], row["code"], marked),
        acc["username"],
    )
    return {"ok": True, "status": "active", "marked": marked}


@router.post("/api/admin/activities/{aid}/unpublish")
def admin_activity_unpublish(aid: int, token: str = ""):
    """切回草稿：活动进入「编辑 / 测试」态，并记下切换时刻。

    草稿态**对外仍然能打开**，只是顶部挂一条「预览模式」提示——运营要在发布前
    把报名、签到、导出都测一遍，拦成 404 就没法验。所以这个开关拦的不是访问，
    而是**数据口径**：切换之后产生的报名都是测试数据，下次发布时整体归档。

    draft_at 是归档的划界点，别清它、别改它，否则发布时会把真实报名一起标掉。
    """
    acc = require_admin(token)
    conn = get_conn()
    row = conn.execute(
        "SELECT id, code, name, status FROM activity WHERE id=?", (aid,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "活动不存在")
    if row["status"] == "archived":
        raise HTTPException(409, "活动已归档，不能再切回草稿")

    now = now_iso()
    with transaction() as c:
        c.execute(
            "UPDATE activity SET status='draft', draft_at=?, updated_at=? WHERE id=?",
            (now, now, aid),
        )
    actx.invalidate(row["code"])
    write_admin_log(
        "activity_unpublish",
        "活动 %s（%s）切回草稿，对外下线" % (row["name"], row["code"]),
        acc["username"],
    )
    return {"ok": True, "status": "draft", "draft_at": now}


# ============ 平台层：能力开关（P1 地基，后续各期共用）============

class FeatureSetIn(BaseModel):
    features: dict  # {"seat": true, "dashboard": false}


@router.get("/api/admin/features")
def admin_features_get(token: str = ""):
    """读本活动的能力开关：key / 名称 / 档位 / 说明 / 是否开启。

    名称与说明取自 `feature` 表（由 `db.FEATURES` 播种），不在这里另写一份文案——
    界面上看到的和大纲里的必须是同一句话，否则改了一处另一处就开始骗人。
    """
    from feature import enabled_map, KEYS
    require_login(token)
    m = enabled_map()
    conn = get_conn()
    meta = {}
    for r in conn.execute("SELECT key, name, tier, description FROM feature").fetchall():
        meta[r["key"]] = r
    rows = []
    for k in KEYS:
        info = meta.get(k)
        rows.append({
            "key": k,
            "name": (info["name"] if info else k),
            "tier": (info["tier"] if info else "basic"),
            "description": (info["description"] if info else ""),
            "enabled": bool(m.get(k, False)),
        })
    return {"ok": True, "rows": rows}


@router.put("/api/admin/features")
def admin_features_set(body: FeatureSetIn, token: str = ""):
    """设本活动的能力开关：只写传了的 key，并清掉本活动的缓存。

    活动开关是「在机构已买范围内往下关」，不是「自己开通没买的能力」。
    要开一个没授权的能力必须走机构级接口 `/platform/orgs/{oid}/features`
    由平台超管操作——否则基础版机构管理员能把 plus 专属能力自己勾出来。

    校验与写入分两段：全部 key 验过再落库，避免非法 key 让前面几条先写进去，
    留下「勾了一半」的状态。关闭（on=0）永远允许——关自己的能力不算越权。
    """
    from feature import enabled_map, invalidate, KEYS
    acc = require_admin(token)
    aid = actx.current_id()
    conn = get_conn()

    # 本活动所属机构已授权（enabled=1）的能力集合
    row = conn.execute("SELECT org_id FROM activity WHERE id=?", (aid,)).fetchone()
    org_id = row["org_id"] if row else None
    entitled = set()
    if org_id is not None:
        for r in conn.execute(
            "SELECT feature_key FROM org_entitlement WHERE org_id=? AND enabled=1",
            (org_id,),
        ).fetchall():
            entitled.add(r["feature_key"])

    # 第一段：全量校验，不写库
    import plan as _plan
    labels = _plan.feature_labels()
    wanted = []
    for key, val in (body.features or {}).items():
        if key not in KEYS:
            raise HTTPException(400, "未知能力 key: %s" % key)
        on = 1 if bool(val) else 0
        if on and key not in entitled:
            raise HTTPException(403, "本机构未开通「%s」，请联系平台开通" % labels.get(key, key))
        wanted.append((key, on))

    # 第二段：校验全过才写
    now = now_iso()
    changed = []
    for key, on in wanted:
        cur = conn.execute(
            "UPDATE activity_feature SET enabled=?, created_at=? WHERE activity_id=? AND feature_key=?",
            (on, now, aid, key),
        )
        if cur.rowcount == 0:
            conn.execute(
                "INSERT INTO activity_feature (activity_id, feature_key, enabled, created_at)"
                " VALUES (?,?,?,?)",
                (aid, key, on, now),
            )
        changed.append("%s=%s" % (key, "开" if on else "关"))
    conn.commit()
    invalidate(aid)
    write_admin_log("feature_set", "活动 %s 能力开关: %s" % (aid, ", ".join(changed)), acc["username"])
    return {"ok": True, "features": enabled_map(aid)}


# ============ 平台层：活动表单字段配置（P4-b3）============
# 表单结构是整个活动里唯一「改完还得让历史数据解释得通」的配置：字段名换了、
# 选项删了，老报名里存的值就成了孤儿。所以这一组接口只做读写与元信息，
# **冻结规则一律由 form_store.save_fields 判**，不在这里另判一遍——
# 两处各写一遍，早晚会有一处忘了跟上。

class FormSaveIn(BaseModel):
    fields: list
    note: Optional[str] = None


def _cap_flag(acc, cap: str) -> bool:
    """不抛异常地问「有没有这个能力」。

    界面要据此决定显示保存按钮还是只读提示：403 应该发生在点保存时，
    而不是连编辑页都打不开——运营看不到现状就没法判断自己缺什么。
    """
    import perm as _perm
    try:
        return bool(_perm.effective(acc)["caps"].get(cap, False))
    except _perm.PermissionDenied:
        return False


@router.get("/api/admin/form")
def admin_form_get(token: str = ""):
    """当前生效的表单定义 + 编辑界面要用的全部元信息。

    一次给全（fields / types / 冻结状态 / 是否可编辑），因为编辑页一打开就要
    同时显示这些。只回 fields 的话，前端还得再发三个请求才知道「能不能保存」。
    """
    acc = require_login(token)
    aid = actx.current_id()
    eff = form_store.get_effective(aid)
    cnt = form_store.registration_count(aid)
    return {
        "ok": True,
        "version": eff["version"],
        # self_healed=True：活动还没配过，返回的是内存里的默认结构（没写库）。
        # 界面要据此提示「这是模板，保存后才会成为本活动的配置」。
        "self_healed": eff["self_healed"],
        "fields": eff["fields"],
        "registration_count": cnt,
        "frozen": cnt > 0,
        # 类型库下发，而不是让前端抄一份：抄了就会漏掉后端新增的类型，
        # 表现是「接口支持但界面选不到」。
        "types": [{"key": k, "label": v["label"], "attrs": list(v["attrs"])}
                  for k, v in form.FIELD_TYPES.items()],
        "core_keys": list(form.CORE_KEYS.keys()),
        # 「不许删」的 core 也由后端说了算，界面只负责把它变灰
        "required_core": dict(form.REQUIRED_CORE),
        # RD-22：配置页提示与保存报错共用 textguard 一句文案，
        # 界面只渲染，不在前端抄一份（抄了必然漂移）。
        "pii_notice": textguard.PII_NOTICE,
        "can_edit": _cap_flag(acc, "can_manage_config"),
    }


@router.get("/api/admin/form/default")
def admin_form_default(token: str = ""):
    """默认模板（只读，不写库）。

    给「恢复默认」用：把模板灌进编辑器，运营自己看一遍再决定存不存。
    直接写库的「重置」按钮太危险——手一滑，配了半天的字段就没了，
    而这个动作没有任何撤销路径（旧版本还在，但没人会想到去翻）。
    """
    require_login(token)
    return {"ok": True, "fields": form.validate_fields_def(form.default_schema())}


@router.get("/api/admin/form/versions")
def admin_form_versions(token: str = ""):
    """版本历史，新的在前（不含字段明细，省带宽）。"""
    require_login(token)
    return {"ok": True, "rows": form_store.list_versions(actx.current_id())}


@router.get("/api/admin/form/versions/{version}")
def admin_form_version(version: int, token: str = ""):
    """取某一版的字段明细。

    用途是「照着老版本改回去」：前端把这份 fields 灌进编辑器再保存，
    而不是单独做一个「回滚」接口——回滚本身也是保存，同样受冻结规则约束，
    多一条路径就多一处要记住冻结。
    """
    require_login(token)
    got = form_store.get_version(actx.current_id(), version)
    if not got:
        raise HTTPException(404, "该版本不存在")
    return {"ok": True, **got}


@router.post("/api/admin/form")
def admin_form_save(body: FormSaveIn, token: str = ""):
    """保存字段定义。原地改还是升版本，交给 form_store 按「有没有报名」判。

    返回 frozen / bumped 让前端说得清后果：「已就地更新」和「已发布 v3，
    已收的 N 条报名仍按 v2 解释」是两件完全不同的事，文案不能混。
    """
    import perm as _perm
    acc = require_login(token)
    _perm_or_403(_perm.require_cap, acc, "can_manage_config")
    # 风控（2026-11-25 扩面）：字段名、说明、提示、选项都会渲染在报名页上，
    # 选项还会进 CSV 导出与复盘。整包序列化后过一遍词库，逐字段拆太碎，
    # 报错文案反而说不清是哪一项。
    # 平台超管豁免（guard 内部判），他要给客户造演示数据。
    riskword.guard({"表单字段": [str(body.fields), str(body.note or "")]},
                   where="form_save", acc=acc)
    aid = actx.current_id()
    try:
        res = form_store.save_fields(
            aid, body.fields, note=(body.note or "").strip()[:120],
            created_by=acc.get("id"),
        )
    except form.SchemaInvalid as e:
        # 配置错误必须是 400 带原因，不能 500：运营看到「保存失败」会反复重试，
        # 看到「字段 xxx 必须提供选项」才知道要改哪里。
        raise HTTPException(400, str(e))
    write_admin_log(
        "form_save",
        "活动 %s 表单字段 v%s（%d 个字段）%s"
        % (aid, res["version"], len(res["fields"]),
           "，因已有报名升版本" if res.get("bumped") else "，原地更新"),
        acc["username"],
    )
    return {"ok": True, **res,
            "registration_count": form_store.registration_count(aid)}


# ============ 平台层：活动成员与授权（P2）============
# 权限判断统一收在 perm.py；这里只做「谁能看、谁能改」的 HTTP 边界。
# 现场核销人员走 staff 表，与本模块无关，零回归。

class MemberGrantIn(BaseModel):
    account_id: int
    role: str = "member"        # activity_admin / member
    caps: Optional[dict] = None  # 不传则按角色取默认快照
    note: Optional[str] = None


def _perm_or_403(fn, *a, **kw):
    """把 perm.PermissionDenied 统一转成 403，避免每个接口各写一遍。"""
    import perm as _perm
    try:
        return fn(*a, **kw)
    except _perm.PermissionDenied as e:
        raise HTTPException(403, str(e))


@router.get("/api/admin/my-activities")
def admin_my_activities(token: str = ""):
    """活动切换器数据：当前账号能进哪些活动。

    平台超管返回全部活动；其他账号只返回被显式授权的活动。
    这样前端切换器不会出现「点进去 403」的死入口。
    """
    import perm as _perm
    acc = require_login(token)
    conn = get_conn()
    ids = _perm.accessible_activity_ids(acc)
    if ids is None:
        rows = conn.execute(
            "SELECT id, code, name, status FROM activity ORDER BY id"
        ).fetchall()
    elif not ids:
        rows = []
    else:
        ph = ",".join("?" * len(ids))
        rows = conn.execute(
            "SELECT id, code, name, status FROM activity"
            " WHERE id IN (%s) ORDER BY id" % ph, tuple(ids)
        ).fetchall()
    return {
        "ok": True,
        "rows": [{"id": r["id"], "code": r["code"], "name": r["name"],
                  "status": r["status"]} for r in rows],
        "is_system_admin": ids is None,
    }


@router.get("/api/admin/members")
def admin_members(token: str = ""):
    """本活动的成员授权列表。需要 can_manage_members 能力。"""
    import perm as _perm
    acc = require_login(token)
    _perm_or_403(_perm.require_cap, acc, "can_manage_members")
    conn = get_conn()
    rows = conn.execute(
        "SELECT m.id, m.account_id, a.username, m.role, m.caps, m.status,"
        " m.granted_at, m.note, m.granted_by"
        " FROM activity_member m LEFT JOIN account a ON a.id=m.account_id"
        " WHERE m.activity_id=? ORDER BY m.id",
        (actx.current_id(),),
    ).fetchall()
    return {
        "ok": True,
        "rows": [{
            "id": r["id"], "account_id": r["account_id"],
            "username": r["username"], "role": r["role"],
            "caps": r["caps"], "status": r["status"],
            "granted_at": r["granted_at"], "note": r["note"],
        } for r in rows],
        "capabilities": _perm.CAPS,
    }


@router.get("/api/admin/members/candidates")
def admin_member_candidates(token: str = ""):
    """活动成员授权的候选账号：只出本机构的 id 与用户名，不出权限位。

    为什么单开一个接口而不复用 /admin/accounts：账号列表按产品口径是「机构负责人」
    才看得到的全量视图（含权限位与平台超管那一行）；活动成员授权只需要「本机构有
    哪些账号」这一件事。而「活动能力与成员」页是按 can_manage_members 开门的——
    机构管理员能改能力开关，却在授权下拉里看到空白，等于这块功能对他是假的。
    """
    import perm as _perm
    acc = require_login(token)
    _perm_or_403(_perm.require_cap, acc, "can_manage_members")
    conn = get_conn()
    cur_act = actx.current()
    org_id = (cur_act.org_id if cur_act else None) or orgctx.org_id_of(acc)
    aid = actx.current_id()
    granted = {r["account_id"] for r in conn.execute(
        "SELECT account_id FROM activity_member WHERE activity_id=? AND status='active'",
        (aid,)).fetchall()}
    rows = conn.execute(
        "SELECT id, username, role FROM account"
        " WHERE role != 'admin' AND enabled=1 AND org_id=? ORDER BY username",
        (org_id,)).fetchall()
    return {"ok": True, "rows": [{
        "id": r["id"], "username": r["username"], "role": r["role"],
        "granted": r["id"] in granted,
    } for r in rows]}


@router.post("/api/admin/members")
def admin_member_grant(body: MemberGrantIn, token: str = ""):
    """授权/改授本活动成员。权限快照在授权这一刻写死，不随全局账号变化。"""
    import perm as _perm
    acc = require_login(token)
    _perm_or_403(_perm.require_cap, acc, "can_manage_members")
    if body.role not in (_perm.ACT_ADMIN, _perm.MEMBER):
        raise HTTPException(400, "role 只能是 activity_admin / member")
    conn = get_conn()
    target = conn.execute(
        "SELECT id, username, enabled FROM account WHERE id=?", (body.account_id,)
    ).fetchone()
    if not target or not target["enabled"]:
        raise HTTPException(400, "账号不存在或已停用")
    aid = actx.current_id()
    riskword.guard({"授权备注": body.note}, where="member_grant", acc=acc)
    _perm.grant(conn, aid, body.account_id, body.role, body.caps,
                acc["id"], body.note or "")
    conn.commit()
    write_admin_log("member_grant",
                    "授权 %s 为活动 %s 的 %s" % (target["username"], aid, body.role),
                    acc["username"])
    return {"ok": True, "activity_id": aid, "account_id": body.account_id}


@router.post("/api/admin/members/revoke")
def admin_member_revoke(body: MemberGrantIn, token: str = ""):
    """撤销本活动授权（软置 disabled，保留历史）。"""
    import perm as _perm
    acc = require_login(token)
    _perm_or_403(_perm.require_cap, acc, "can_manage_members")
    conn = get_conn()
    ok = _perm.revoke(conn, actx.current_id(), body.account_id)
    conn.commit()
    write_admin_log("member_revoke",
                    "撤销活动 %s 账号 %s 的授权" % (actx.current_id(), body.account_id),
                    acc["username"])
    return {"ok": True, "revoked": ok}
