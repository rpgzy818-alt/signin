"""CTA 配置中心接口（P5-a）：活动级按钮配置 + 渠道密钥。

**合规闸门在这一层落地**：所有写接口先过 cta.validate()，
违规配置（required/blocking 字段、诱导分享、钓鱼外链、浮层越界）根本存不进库。
前端拿到的一定是合规配置——不是靠运营自觉，也不是靠界面提示。

**越权口径**：与活动管理一致——平台超管全平台，机构负责人/管理员本机构全部活动，
普通成员只能改被显式授权的活动。`activity_id` 从路径来，但先过 accessible_activity_ids。

**密钥**：回显永远只给末 4 位（cta.mask_secret），明文既不落日志也不下发前端。
"""
from __future__ import annotations

import json
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from deps import get_conn, transaction, insert_row, now_iso, require_admin, write_admin_log
import activity as actx
import cta as cta_def
import db
import perm as _perm
import riskword

router = APIRouter()


class CtaIn(BaseModel):
    # 合规硬约束：额外字段（尤其 required/blocking）直接拒绝，
    # 不静默丢弃——运营必须看到「这个属性平台不允许」，而不是配了没生效。
    model_config = ConfigDict(extra="forbid")
    cta_key: str
    kind: str
    title: str
    target: str = ""
    position: str = "success"
    sort: int = 0
    enabled: int = 1
    note: str = ""


class CtaPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Optional[str] = None
    target: Optional[str] = None
    position: Optional[str] = None
    sort: Optional[int] = None
    enabled: Optional[int] = None
    note: Optional[str] = None


class ChannelIn(BaseModel):
    appid: str = ""
    secret: str = ""            # 明文传入，入库即加密；留空 = 不改
    mini_appid: str = ""
    mini_path: str = ""


def _assert_can_manage(acc, aid: int):
    """活动写权限：超管全部，机构档位本机构，普通成员仅显式授权。"""
    ids = _perm.accessible_activity_ids(acc)
    if ids is not None and aid not in ids:
        raise HTTPException(403, "没有该活动的管理权限")


def _get_activity(aid: int):
    row = get_conn().execute("SELECT * FROM activity WHERE id=?", (aid,)).fetchone()
    if not row:
        raise HTTPException(404, "活动不存在")
    return row


def _cta_dict(r) -> dict:
    return {
        "id": r["id"], "activity_id": r["activity_id"], "cta_key": r["cta_key"],
        "kind": r["kind"], "title": r["title"], "target": r["target"],
        "position": r["position"], "sort": r["sort"], "enabled": r["enabled"],
        "note": r["note"],
    }


# ---------------- 后台：CTA 增删改查 ----------------

@router.get("/api/admin/activity/cta")
def admin_cta_list(aid: int, token: str = ""):
    acc = require_admin(token)
    _get_activity(aid)
    _assert_can_manage(acc, aid)
    rows = get_conn().execute(
        "SELECT * FROM activity_cta WHERE activity_id=? ORDER BY position, sort, id", (aid,)
    ).fetchall()
    return {"ok": True, "rows": [_cta_dict(r) for r in rows],
            "kinds": cta_def.kind_labels(), "positions": cta_def.positions()}


@router.post("/api/admin/activity/cta")
def admin_cta_create(aid: int, body: CtaIn, token: str = ""):
    acc = require_admin(token)
    _get_activity(aid)
    _assert_can_manage(acc, aid)
    key = (body.cta_key or "").strip().lower()
    if not key or not _re_key(key):
        raise HTTPException(400, "CTA 标识只能是小写字母数字与 - _")
    # 合规校验：违规字段（required/blocking）在这里就进不来。
    # cta_key 是标识不是 CTA 属性，剥掉再校验。
    try:
        payload = body.dict()
        payload.pop("cta_key", None)
        clean = cta_def.validate(payload)
    except cta_def.ValidationError as e:
        raise HTTPException(400, str(e))
    # 风控：CTA 的按钮文案直接长在参与者页面的主按钮上，是全页最容易被人
    # 拿来放违规引导的位置（「立即领钱」「加我领福利」都在这一类）。
    riskword.guard({"按钮文案": [clean.get("title"), clean.get("note")]},
                   where="cta_create", acc=acc)
    conn = get_conn()
    exists = conn.execute(
        "SELECT 1 FROM activity_cta WHERE activity_id=? AND cta_key=?", (aid, key)
    ).fetchone()
    if exists:
        raise HTTPException(400, "该 CTA 标识已存在")
    with transaction() as c:
        insert_row(c, "activity_cta", {
            "activity_id": aid, "cta_key": key, **clean,
            "created_at": now_iso(), "updated_at": now_iso(),
        })
    write_admin_log("cta_create", "活动 #%d 新增 CTA「%s」(%s)" % (aid, clean["title"], clean["kind"]),
                    acc["username"])
    actx.invalidate()
    return {"ok": True, "cta_key": key}


@router.put("/api/admin/activity/cta/{key}")
def admin_cta_update(aid: int, key: str, body: CtaPatch, token: str = ""):
    acc = require_admin(token)
    _get_activity(aid)
    _assert_can_manage(acc, aid)
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM activity_cta WHERE activity_id=? AND cta_key=?", (aid, key)
    ).fetchone()
    if not row:
        raise HTTPException(404, "CTA 不存在")
    merged = _cta_dict(row)
    merged.update({k: v for k, v in body.dict().items() if v is not None})
    for internal in ("id", "activity_id", "cta_key"):
        merged.pop(internal, None)
    try:
        clean = cta_def.validate(merged)
    except cta_def.ValidationError as e:
        raise HTTPException(400, str(e))
    riskword.guard({"按钮文案": [clean.get("title"), clean.get("note")]},
                   where="cta_update", acc=acc)
    with transaction() as c:
        c.execute(
            "UPDATE activity_cta SET kind=?, title=?, target=?, position=?, sort=?,"
            " enabled=?, note=?, updated_at=? WHERE activity_id=? AND cta_key=?",
            (clean["kind"], clean["title"], clean["target"], clean["position"],
             clean["sort"], clean["enabled"], clean["note"], now_iso(), aid, key),
        )
    write_admin_log("cta_update", "活动 #%d 修改 CTA「%s」" % (aid, key), acc["username"])
    actx.invalidate()
    return {"ok": True}


@router.delete("/api/admin/activity/cta/{key}")
def admin_cta_delete(aid: int, key: str, token: str = ""):
    acc = require_admin(token)
    _get_activity(aid)
    _assert_can_manage(acc, aid)
    with transaction() as c:
        c.execute("DELETE FROM activity_cta WHERE activity_id=? AND cta_key=?", (aid, key))
    write_admin_log("cta_delete", "活动 #%d 删除 CTA「%s」" % (aid, key), acc["username"])
    actx.invalidate()
    return {"ok": True}


# ---------------- 后台：渠道密钥（不回显明文）----------------

@router.get("/api/admin/activity/channel")
def admin_channel_get(aid: int, token: str = "", channel: str = "wechat"):
    acc = require_admin(token)
    _get_activity(aid)
    _assert_can_manage(acc, aid)
    row = get_conn().execute(
        "SELECT config FROM activity_channel WHERE activity_id=? AND channel=?", (aid, channel)
    ).fetchone()
    cfg = json.loads(row["config"]) if row else {}
    return {"ok": True, "channel": channel, "configured": bool(cfg.get("appid")),
            "appid": cfg.get("appid", ""), "mini_appid": cfg.get("mini_appid", ""),
            "mini_path": cfg.get("mini_path", ""),
            "secret_masked": cta_def.mask_secret(cfg.get("secret", ""))}


@router.post("/api/admin/activity/channel")
def admin_channel_save(aid: int, body: ChannelIn, token: str = "", channel: str = "wechat"):
    acc = require_admin(token)
    _get_activity(aid)
    _assert_can_manage(acc, aid)
    if channel not in ("wechat", "weapp"):
        raise HTTPException(400, "未知渠道")
    conn = get_conn()
    row = conn.execute(
        "SELECT config FROM activity_channel WHERE activity_id=? AND channel=?", (aid, channel)
    ).fetchone()
    cfg = json.loads(row["config"]) if row else {}
    cfg["appid"] = body.appid.strip()
    cfg["mini_appid"] = body.mini_appid.strip()
    cfg["mini_path"] = body.mini_path.strip()
    if body.secret:   # 留空 = 不改，避免掩码串被当成新密钥写回去
        try:
            cfg["secret"] = cta_def.encrypt_secret(body.secret.strip())
        except cta_def.ValidationError as e:
            raise HTTPException(400, str(e))
    if not cfg.get("appid"):
        raise HTTPException(400, "appid 不能为空")
    with transaction() as c:
        if row:
            c.execute("UPDATE activity_channel SET config=?, updated_at=?"
                      " WHERE activity_id=? AND channel=?",
                      (json.dumps(cfg, ensure_ascii=False), now_iso(), aid, channel))
        else:
            insert_row(c, "activity_channel", {
                "activity_id": aid, "channel": channel,
                "config": json.dumps(cfg, ensure_ascii=False),
                "created_at": now_iso(), "updated_at": now_iso(),
            })
    write_admin_log("channel_save", "活动 #%d 保存 %s 渠道配置" % (aid, channel), acc["username"])
    actx.invalidate()
    return {"ok": True}


# ---------------- 公开：前台渲染用（配置已由后端校验合规）----------------

def public_ctas(aid: int) -> list:
    rows = get_conn().execute(
        "SELECT cta_key, kind, title, target, position, sort FROM activity_cta"
        " WHERE activity_id=? AND enabled=1 ORDER BY sort, id", (aid,)
    ).fetchall()
    # 只下发前台渲染需要的字段，note/密钥等内部字段不下发
    return [{k: r[k] for k in ("cta_key", "kind", "title", "target", "position", "sort")}
            for r in rows]


def _re_key(s: str) -> bool:
    import re
    return bool(re.match(r"^[a-z0-9][a-z0-9_-]{0,31}$", s))
