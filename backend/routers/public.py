"""用户端接口：报名、签到、查询、埋点、领卡。

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
import activity as actx
import checkin_core
import theme as theme_def
import intro as intro_def
from routers import cta as cta_def
from feature import enabled_map
import form
import form_store
import riskword
import orgstate
import portal as portal_def
from routers import material as material_def

import limit
import logx

router = APIRouter()




def _parse_phone(raw_code, raw_phone):
    """区号 + 号码的归一与校验。报名提交与现场补录必须走同一套规则。

    86 严格按 11 位大陆手机号校验；其他区号只要求 4—15 位数字——
    各国号码位数不一，硬套长度只会把正常号码挡在门外。
    返回 (区号, 纯数字号码)。
    """
    code = norm_phone_code(raw_code)
    digits = re.sub(r"\D", "", raw_phone or "")
    if code == "86":
        # 大陆号码按老规则严格校验，不能放松
        if not PHONE_RE.match(digits):
            raise HTTPException(400, "手机号格式不正确，请填写 11 位大陆手机号")
    elif not (4 <= len(digits) <= 15):
        raise HTTPException(400, "请填写有效号码")
    return code, digits




# ---------------- 路由 ----------------
@router.get("/api/health")
def health():
    g = gate_state()
    return JSONResponse(content={"ok": True, **g, "env": DB_ENV})




@router.get("/api/public/numbers")
def public_numbers():
    """公开只读：前端展示「第 N 位报名 / 今天已有 N 位到场」，只回数字，不含个人信息。"""
    conn = get_conn()
    registered = conn.execute(
        "SELECT COUNT(*) FROM registration WHERE is_smoke IS NOT 1 AND status='active'"
    ).fetchone()[0]
    today = now_iso()[:10]      # 服务器本地（Asia/Shanghai）日期，与 now_iso() 写入的 checked_at 同格式
    today_checkin = conn.execute(
        "SELECT COUNT(DISTINCT c.registration_id) FROM checkin c "
        "JOIN registration r ON r.id = c.registration_id "
        "WHERE c.checked_at IS NOT NULL AND substr(c.checked_at,1,10)=? "
        "AND c.is_smoke IS NOT 1 AND r.is_smoke IS NOT 1 AND r.status='active'",
        (today,),
    ).fetchone()[0]
    return {"ok": True, "registered": registered, "today_checkin": today_checkin}




def _public_org_name(act) -> str:
    """主办方名称：当前活动所属机构的名字；取不到一律回落「活动主办方」。

    这是协议页要显示的名字，不能默认成任何具体机构——平台将来服务很多机构，
    写死一家就是在替别家乱署名。缺机构、缺活动、空名字都算「没有」。
    """
    conn = get_conn()
    oid = int(getattr(act, "org_id", 0) or 0)
    if not oid:
        return "活动主办方"
    row = conn.execute("SELECT name FROM organization WHERE id=?", (oid,)).fetchone()
    name = str(row["name"]).strip() if row and row["name"] else ""
    return name or "活动主办方"


def _tech_badge(act) -> bool:
    """报名/签到成功页底部是否带平台标识（原广告位）。

    只有体验版带：基础版及以上买的就是「去掉这一行」，给付费客户再贴回去
    等于把人买断的位置又占走。取不到机构一律按「不带」处理——少显示一行
    是小事，给付费客户误贴是违约。
    """
    oid = int(getattr(act, "org_id", 0) or 0)
    if not oid:
        return False
    try:
        row = get_conn().execute(
            "SELECT plan FROM organization WHERE id=?", (oid,)).fetchone()
    except Exception:
        return False
    return bool(row) and str(row["plan"] or "") == "trial"


def _public_field_labels(aid: int) -> list[str]:
    """当前活动已发布表单的字段中文名，供协议「收集范围」逐项展示。

    只回 label，不回 key/选项/答案。取不到 schema 时回空列表，前端据此
    用一句通用兜底，而不是继续显示写死的招聘字段。
    """
    import form_store as fs

    conn = get_conn()
    try:
        schema = fs.get_effective(aid, conn)
    except Exception:
        schema = None
    fields = (schema or {}).get("fields") or []
    out = []
    for f in fields:
        if isinstance(f, dict):
            label = str(f.get("label") or "").strip()
            if label and label not in out:
                out.append(label)
    return out


def _public_agenda(aid: int) -> dict:
    """日程/议程分组下发，与 `/agenda` 接口共用同一份字段白名单。

    白名单定义在 agenda.PUBLIC_FIELDS，函数内延迟 import 避免路由模块
    互相依赖（main 装配顺序变化时不会循环导入）。
    """
    from routers import agenda as _agenda
    out = {"schedule": [], "agenda": []}
    try:
        rows = get_conn().execute(
            "SELECT * FROM activity_agenda WHERE activity_id=? AND enabled=1"
            " ORDER BY sort_order ASC, id ASC", (aid,)
        ).fetchall()
    except sqlite3.OperationalError:
        return out          # 老库还没建表：回落空，前端保留静态兜底
    for r in rows:
        item = _agenda.public_row(r)
        if item["kind"] in out:
            out[item["kind"]].append(item)
    return out


@router.get("/api/config")
def public_config(request: Request):
    """公开只读：前端据此决定报名入口 / 活动结束态 / 背景音乐，并取闸门状态。

    真正的组装在 `config_payload`：闸门直调那一层，不依赖 HTTP 签名——
    接口加一个 Request 参数就撞掉三个闸门，那种失败跟业务无关，纯噪音。
    """
    return config_payload(request.headers.get("host", ""),
                          request.headers.get("x-activity-code", "") or "")


def config_payload(host: str = "", act_code: str = "") -> dict:
    """`/config` 的响应体。host/act_code 从请求头传进来，便于闸门与复用。

    `activity.status` 必须回：草稿态（draft）**不拦访问**，只让前端挂一条
    「预览模式」提示条——运营要在发布前把报名、签到、导出都测一遍，
    一律 404 就测不了。真正被拦的只有 archived。
    这个字段不含任何业务数据。

    **机构域名优先判机构首页（RD-13）**：Host 是某机构的已验证域名、且没带
    活动短码时，这个请求属于「机构门面」而不是某场活动。必须在读任何活动级
    配置之前返回——否则机构 A 的访客会看到默认活动的日程、CTA 与主题，
    那是实打实的跨租户串数据。带 `?a=`（分享链接、物料码）时照旧进活动流。
    """
    if not (act_code or "").strip():
        conn = get_conn()
        org_row = portal_def.find_org(conn, host=host or "")
        if org_row is not None:
            return {"ok": True, "env": DB_ENV, "mode": "org_home",
                    **portal_def.payload(conn, org_row)}

    b = bgm_config()
    act = actx.current()
    # env 由后端声明，前端据此显示测试环境专用工具（不靠 URL 猜测，避免按 IP/端口直连时判错）
    return {"ok": True, "env": DB_ENV, **read_switches(), "gate": gate_state(),
            "bgm": {"enabled": b["enabled"], "url": b["url"]},
            "activity": {
                "id": actx.current_id(),
                "code": actx.current_code(),
                "name": act.name if act else "",
                "status": act.status if act else "active",
                # 主办方名称：取当前活动的机构名，缺省回落「活动主办方」。
                # 协议弹层据此渲染，不再硬编码任何机构/品牌名。
                "org_name": _public_org_name(act),
            },
            # 协议里要列字段名，取自当前活动已发布的表单配置；只有中文 label，
            # 不含选项与答案，前端拿到直接拼进「收集范围」。
            "field_labels": _public_field_labels(actx.current_id()),
            # 主题按活动走（activity.theme）。只下发变量值，前端逐条注入 :root；
            # 未配置或拼错都在 theme.public_theme 里回落默认。
            "theme": theme_def.public_theme(act.theme if act else None),
            # 主题下拉选项：名称取自 theme.py，后台不另抄一份。
            "theme_options": [{"key": k, "name": theme_def.THEMES[k]["name"]}
                              for k in theme_def.theme_keys()],
            # 介绍页文案覆盖：后端解析成安全对象，前端拿到即用；
            # 未配置时 null，前端保持默认文案。
            "intro": intro_def.parse(act.intro if act else None),
            # 日程/议程随 config 一起下发：前端本来就要拉 config，
            # 不让它为十几条数据再发一次请求、多一个失败点。
            # 空的 return [] —— 前端据此保留静态兜底时间线。
            "agenda": _public_agenda(actx.current_id()),
            # CTA 配置：已由后端合规闸门校验，前台只渲染不判断
            "ctas": cta_def.public_ctas(actx.current_id()),
            # 活动资料下载（专业版）：未开通 / 没配都回 null，前台据此不渲染入口。
            "material": material_def.public_material(actx.current_id()),
            "features": enabled_map(),
            # 底部标识（原广告位）：只有体验版为真。前端不认版本号，
            # 只认这一个开关——判定口径留在后端，改档位规则不必改前端。
            "tech_badge": _tech_badge(act)}




@router.get("/api/org/portal")
def public_org_portal(request: Request, org: str = ""):
    """机构入口页数据（RD-13）：机构域名或 `?org=<机构短码>` 均可定位。

    公开只读，只出机构名与已上线活动。机构短码不算秘密——它出现在机构自己
    对外发的链接里；即便被猜到，看到的也只是这家机构公开的活动列表，
    与直接打开它的活动页是同一份信息。

    两种定位都失败就 404，**不回落默认活动**：那会把访客当成别家的客人。
    """
    conn = get_conn()
    row = portal_def.find_org(conn, code=org, host=request.headers.get("host", ""))
    if row is None:
        raise HTTPException(404, "未找到机构")
    return {"ok": True, "mode": "org_home", **portal_def.payload(conn, row)}


@router.get("/api/form")
def public_form():
    """当前活动的表单结构，供参与者端渲染。

    只下发**渲染所需**的定义，不含任何报名数据。前端拿到后按 step 分组画页面，
    提交时把值原样回传——但校验一律在服务端按同一份 schema 再走一遍，
    前端这份只是为了让用户少犯错，不是信任来源。
    """
    return {"ok": True, **form_store.render(actx.current_id())}


def _guard_org_accepting() -> None:
    """机构到期冻结后不再收报名。判定走 orgstate 一处，别在这里另写日期比较。"""
    act = actx.current()
    if act is None:
        return
    try:
        orgstate.assert_accepting(int(getattr(act, "org_id", 0) or 1))
    except orgstate.OrgFrozen as e:
        logx.ev("register_rejected", level="warning", reason="org_frozen")
        raise HTTPException(409, e.message)


@router.post("/api/register")
def register(body: RegisterIn):
    # 报名开关：后台可在现场关闭报名入口，与公开 config 接口同源。
    # 活动结束同样要关：否则绕过前端直接调接口仍能继续报名，状态机不成立。
    switches = read_switches()
    if not switches["registration_open"]:
        logx.ev("register_rejected", level="warning", reason="switch_off",
                openid=logx.mask_openid(body.openid))
        raise HTTPException(409, "报名已截止，感谢关注，本次活动报名通道已关闭")
    if switches["event_ended"]:
        logx.ev("register_rejected", level="warning", reason="event_ended",
                openid=logx.mask_openid(body.openid))
        raise HTTPException(409, "本场活动已结束，线上报名已关闭")
    _guard_org_accepting()
    # 同一个人 1 分钟内最多提交 3 次：够改错，不够刷
    limit.guard("reg", body.openid, 3, 60)
    # ---- 按活动当前生效的 schema 校验 ----
    # 前端拿到的 schema 只用于渲染；这里以库里 published 版本为准。
    # 运营改完字段后，即使有人还开着旧页面，写入的也一定是新规则。
    #
    # **只校验 step=1 的字段**：报名是两步流程（第一步落库即成功、第二步补职业信息），
    # 用整份 schema 校验会把第二步的必填项也压到第一步，用户连提交都点不了。
    # step 不只是展示分组，它同时决定「这个字段在哪一批提交」。
    sch = form_store.get_effective(actx.current_id())
    fields = [f for f in sch["fields"] if int(f.get("step") or 1) == 1]

    payload = {
        "name": body.name, "gender": body.gender,
        "phone": body.phone, "phone_code": body.phone_code,
    }
    if body.answers:
        payload.update({k: v for k, v in body.answers.items() if v is not None})
    # 性别只收 男/女，其它一律按未填——脏值会污染统计
    if isinstance(payload.get("gender"), str) and payload["gender"] not in GENDER_OPTIONS:
        payload["gender"] = ""

    values, errs = form.validate_submission(fields, payload)
    if errs:
        logx.ev("register_invalid", level="warning", field=errs[0]["key"],
                openid=logx.mask_openid(body.openid))
        raise HTTPException(400, errs[0]["msg"])

    # core 映射成「列名 → 值」：调用方不必知道 phone 要拆成两列、多选要合成顿号串
    core = form.core_values(fields, values)
    name = core.get("name") or ""
    phone = core.get("phone") or ""
    phone_code = core.get("phone_code") or "86"
    answers_json = form.dumps_answers(fields, values)

    if not body.privacy:
        raise HTTPException(400, "请先勾选同意《个人信息处理说明》")
    # 前端按 from 参数带上来（物料扫码 / 分享链接 / 活动链接），现场补录由 walkin 写入。
    # 兜底用「活动链接」——裸链接进来的人不该被记成物料；老版本缓存没带 channel 也归到这里
    channel = body.channel if body.channel in CHANNEL_OPTIONS else "活动链接"

    conn = get_conn()
    # 投放归因：短码只在库里存在且启用时才记。填错/伪造的 m 一律按「无」处理，
    # 不能因为一个脏参数把整个报名挡下来（物料上是印给人扫的，扫错很正常）。
    source_code = (body.source_code or "").strip().lower() or None
    if source_code:
        hit = conn.execute(
            "SELECT code FROM material_code WHERE code=? AND enabled=1 AND env=?",
            (source_code, DB_ENV),
        ).fetchone()
        if not hit:
            source_code = None
    # 排重：同一个 openid 再次提交，按「修改信息」处理——保留原凭证码，只更新内容。
    # Brief 要求「重复提交提示已报名，并允许修改信息」，这条 UPDATE 就是那个修改通道。
    if body.openid:
        exist = conn.execute(
            "SELECT id, credential_code, answers FROM registration "
            "WHERE openid=? AND status='active'",
            (body.openid,),
        ).fetchone()
        if exist:
            try:
                with transaction() as c:
                    # 重复提交是「改信息」：answers 要合并，不能整体覆盖——
                    # 否则第二步补填的字段（在 answers 里）会被这一步冲掉。
                    merged = {}
                    if exist["answers"]:
                        try:
                            merged = json.loads(exist["answers"]) or {}
                        except (TypeError, ValueError):
                            merged = {}
                    merged.update(json.loads(answers_json) if answers_json else {})
                    merged_json = json.dumps(merged, ensure_ascii=False) if merged else None
                    sets = ", ".join("%s=?" % col for col in core.keys())
                    c.execute(
                        "UPDATE registration SET %s, answers=?, schema_version=? WHERE id=?" % sets,
                        list(core.values()) + [merged_json, sch["version"], exist["id"]],
                    )
            except sqlite3.IntegrityError:
                # 把手机号改成了别人已用的号，唯一索引会拦下来
                logx.ev("register_conflict", level="warning", why="phone_taken",
                        openid=logx.mask_openid(body.openid),
                        phone=logx.mask_phone(phone))
                raise HTTPException(409, "该手机号已被其他报名占用，请核对后重填")
            logx.ev("register_updated", openid=logx.mask_openid(body.openid),
                    phone=logx.mask_phone(phone), rid=exist["id"])
            return {"ok": True, "status": "updated", "id": exist["id"],
                    "credential_code": exist["credential_code"]}

    # 同一手机号只能报名一次：openid 可能为空（授权失败），靠手机号兜住重复报名
    # 关闭过的记录不算「已报名」：同一个人可以重新报一次，后台留两条各自可见
    dup = conn.execute(
        "SELECT id, credential_code FROM registration WHERE phone_code=? AND phone=? AND status='active'",
        (phone_code, phone),
    ).fetchone()
    if dup:
        # 常见情形：换了微信 / 清了缓存，openid 变了但人没变。
        # 这时不给自助覆盖（无法验证手机号归属），但要给出走得通的下一步。
        logx.ev("register_rejected", level="warning", reason="phone_dup",
                openid=logx.mask_openid(body.openid), phone=logx.mask_phone(phone))
        raise HTTPException(
            409, "该手机号已经报过名。请用报名时那个微信打开，或到现场让工作人员帮你核对。")

    code = gen_code()
    row = {
        "openid": body.openid,
        "channel": channel,
        "source_code": source_code,
        "privacy": 1,
        "credential_code": code,
        "created_at": now_iso(),
        "answers": answers_json,
        "schema_version": sch["version"],
    }
    row.update(core)   # core 只有 name / phone(+phone_code) / gender 三个通用列
    with transaction() as c:
        rid = insert_row(c, "registration", row)
    logx.ev("register_created", openid=logx.mask_openid(body.openid),
            phone=logx.mask_phone(phone), ch=channel, rid=rid, m=source_code)
    return {"ok": True, "status": "created", "id": rid, "credential_code": code}




@router.post("/api/profile")
def save_profile(body: ProfileIn):
    """第二步（可选）：补充已报名的信息。

    第一步 /register 已落库并生成凭证码，现场凭手机号即可签到；
    这一步只补运营配到 step=2 的字段，失败不影响已完成的报名。
    """
    if not body.openid and not body.credential_code:
        raise HTTPException(400, "缺少身份标识")

    # ---- 第二步同样按 schema 校验，但用 partial：只处理本次提交的字段 ----
    # 第一步已经校验过必填并落库，这里再要求一遍等于逼人重填。
    sch = form_store.get_effective(actx.current_id())
    fields = sch["fields"]
    payload = {}
    if body.answers:
        payload.update({k: v for k, v in body.answers.items() if v is not None})
    # 第二步可能放任意字段（ProfileIn 开了 extra），一并纳入校验与写库。
    # 漏掉这一段的表现是「提交成功但值没存进去」——不报错，最难发现。
    for k, v in (getattr(body, "model_extra", None) or {}).items():
        if k in ("openid", "credential_code", "answers") or v is None:
            continue
        payload[k] = v

    values, errs = form.validate_submission(fields, payload, partial=True)
    if errs:
        raise HTTPException(400, errs[0]["msg"])
    core = form.core_values(fields, values)

    conn = get_conn()
    if body.openid:
        row = conn.execute(
            "SELECT * FROM registration WHERE openid=? AND status='active'",
            (body.openid,),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM registration WHERE credential_code=? AND status='active'",
            (body.credential_code,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "未找到报名记录，请先完成第一步")
    if not core and not form.custom_values(fields, values):
        # 这个活动的第二步没有任何字段（例如非招聘类活动），不算错误
        return {"ok": True, "status": "profile_noop", "id": row["id"]}

    # answers 是**合并**不是覆盖：第一步可能已经写进了自定义字段，
    # 第二步整体覆盖会把它们抹掉。
    merged = {}
    if row["answers"]:
        try:
            merged = json.loads(row["answers"]) or {}
        except (TypeError, ValueError):
            merged = {}
    merged.update(form.custom_values(fields, values))

    # 条件字段可能因为这次改动而「从隐藏变必填」（如状态改成在职 → 现公司必填），
    # 本次又没提交它。只靠 partial 校验会漏过去，这里补一道。
    existing = {}
    for f in fields:
        if f.get("core"):
            if f["type"] == "phone":
                existing[f["key"]] = row["phone"]
                existing[f["key"] + "_code"] = row["phone_code"]
            else:
                existing[f["key"]] = row[form.CORE_KEYS[f["core"]]]
        else:
            existing[f["key"]] = merged.get(f["key"])
    missing = form.missing_required(fields, values, existing)
    if missing:
        raise HTTPException(400, missing[0]["msg"])

    with transaction() as c:
        # 第二步可能没有 core 字段（通用活动的补充字段全进 answers），
        # 此时 SET 子句只写 answers，不能拼出「SET , answers=?」这种坏 SQL。
        core_sets = ", ".join("%s=?" % col for col in core.keys())
        sets = (core_sets + ", " if core_sets else "") + "answers=?, schema_version=?"
        c.execute(
            "UPDATE registration SET %s WHERE id=?" % sets,
            list(core.values()) + [json.dumps(merged, ensure_ascii=False) if merged else None,
                                   sch["version"], row["id"]],
        )
    return {"ok": True, "status": "profile_saved", "id": row["id"]}




@router.get("/api/me")
def me(request: Request, full: int = 0):
    """统一状态源：unregistered / registered / checked_in。

    签到记录一律按 registration_id 查，不能按 openid 查——人工核销那条
    checkin 记录历史上 openid 为空，按 openid 查会把已核销的人判成未签到，
    于是「已签到的人再点链接」会错误地回到报名成功页。

    full=1 时额外返回完整报名字段，供「修改信息」预填；默认不带，减少无谓暴露。
    """
    openid = get_openid(request)
    empty = {
        "ok": True, "state": "unregistered", "registered": False,
        "checked_in": False, "checked_at": None, "method": None,
        "name": None, "credential_code": None, "created_at": None,
        "is_staff": False, "closed": False, "closed_at": None,
    }
    if not openid:
        return empty
    conn = get_conn()
    # 只认有效报名：被后台关闭的记录对用户视同不存在（前端当新用户，可重新报名）
    reg = conn.execute(
        "SELECT id, name, phone_code, phone, gender, answers, "
        "credential_code, created_at FROM registration "
        "WHERE openid=? AND status='active'",
        (openid,),
    ).fetchone()
    if not reg:
        # 现场补录兜底：报名可能是在小程序里用另一个微信完成的，那条报名的 openid
        # 与这次扫码进来的 H5 openid 对不上。补录时 checkin 存了当前 openid 和
        # registration_id，按它能把「我的」那条报名认回来——否则补录成功一刷新又
        # 变回「你还未报名」，人被推回补录表单，来回鬼打墙。
        # 只认 checked_at 有值的自助/补录记录，人工核销那种 openid 为空的匹配不到。
        ck0 = conn.execute(
            "SELECT registration_id FROM checkin WHERE openid=? AND checked_at IS NOT NULL "
            "AND registration_id IS NOT NULL ORDER BY id DESC LIMIT 1", (openid,)
        ).fetchone()
        if ck0:
            reg = conn.execute(
                "SELECT id, name, phone_code, phone, gender, answers, "
                "credential_code, created_at FROM registration WHERE id=? AND status='active'",
                (ck0["registration_id"],),
            ).fetchone()
        if not reg:
            # 曾报名但被后台关闭：state 仍是 unregistered（保留重新报名的能力），
            # 另给 closed 标记，前端据此解释「我明明报过」，不让人以为系统丢了记录。
            closed = conn.execute(
                "SELECT closed_at FROM registration WHERE openid=? AND status='closed' "
                "ORDER BY id DESC LIMIT 1", (openid,)
            ).fetchone()
            return {**empty, "is_staff": staff_is(openid, conn),
                    "closed": bool(closed),
                    "closed_at": closed["closed_at"] if closed else None}
    ck = conn.execute(
        "SELECT method, checked_at FROM checkin WHERE registration_id=? "
        "ORDER BY id DESC LIMIT 1",
        (reg["id"],),
    ).fetchone()
    checked = bool(ck and ck["checked_at"])
    out = {
        "ok": True,
        "state": "checked_in" if checked else "registered",
        "registered": True,
        "checked_in": checked,
        "checked_at": ck["checked_at"] if ck else None,
        "method": ck["method"] if ck else None,
        "name": reg["name"],
        "credential_code": reg["credential_code"],
        "created_at": reg["created_at"],
        "is_staff": staff_is(openid, conn),
        "closed": False, "closed_at": None,
    }
    if full:
        out.update({
            "phone_code": reg["phone_code"] or "86",
            "phone": reg["phone"], "gender": reg["gender"],
        })
        # 行业字段全部从 answers 展开到顶层——前端按 schema 的 key 回填，
        # 不需要知道它们存在 JSON 里。不覆盖已有键，同名以固定列为准。
        try:
            extra = json.loads(reg["answers"] or "{}")
            if isinstance(extra, dict):
                out.update({k: v for k, v in extra.items() if k not in out})
        except (TypeError, ValueError):
            pass
    return out




@router.post("/api/checkin")
def checkin(body: CheckinIn):
    g = gate_state()
    if not g["checkin_open"]:
        logx.ev("checkin_rejected", level="warning", reason="gate_closed",
                openid=logx.mask_openid(body.openid))
        return gate_response()

    conn = get_conn()
    reg = None
    code = (body.credential_code or "").strip().upper()
    phone = (body.phone or "").strip()
    openid = (body.openid or "").strip() or None

    # 身份匹配顺序：凭证号 → openid → 手机号。
    # 凭证号排第一是因为它最不容易串：一个人一个码，且当场就能从报名成功页看到。
    # openid 排第二是给接了微信的部署用；手机号垫底，因为换号/代报名会串到别人身上，
    # 只在现场急用时兜住（取最新一条有效报名）。
    if code:
        reg = conn.execute(
            "SELECT id, name, phone, channel FROM registration"
            " WHERE upper(credential_code)=? AND status='active'",
            (code,),
        ).fetchone()
    if reg is None and openid:
        reg = conn.execute(
            "SELECT id, name, phone, channel FROM registration"
            " WHERE openid=? AND status='active'",
            (openid,),
        ).fetchone()
    if reg is None and phone:
        reg = conn.execute(
            "SELECT id, name, phone, channel FROM registration"
            " WHERE replace(replace(phone,' ',''),'-','')=? AND status='active'"
            " ORDER BY id DESC LIMIT 1",
            (phone,),
        ).fetchone()

    if not code and not openid and not phone:
        raise HTTPException(400, "请提供凭证号、手机号或微信授权后再签到")

    if not reg:
        logx.ev("checkin_failed", level="warning", reason="not_registered",
                openid=logx.mask_openid(openid))
        return JSONResponse(status_code=404, content={
            "ok": False, "code": "not_registered",
            "message": "未查询到报名记录，请现场补录",
        })

    exist = checkin_core.find_existing(reg["id"])
    if exist:
        return {"ok": True, "status": "already", "checked_at": exist}
    # 重复签到已有幂等处理，限流只挡「疯狂重试」这类异常客户端。
    # 限流 key 用报名 id 而不是 openid：没有 openid 时它是 None，所有人会挤进同一个桶。
    limit.guard("checkin", str(reg["id"]), 10, 60)
    try:
        when = checkin_core.record(
            reg["id"], openid=openid, method="self", channel=reg["channel"],
            name=reg["name"], phone=reg["phone"])
    except checkin_core.AlreadyChecked as e:
        return {"ok": True, "status": "already", "checked_at": e.checked_at}
    logx.ev("checkin_ok", openid=logx.mask_openid(openid),
            phone=logx.mask_phone(reg["phone"]), rid=reg["id"])
    return {"ok": True, "status": "checked", "checked_at": when}




@router.post("/api/walkin")
def walkin(body: WalkinIn):
    _guard_org_accepting()
    g = gate_state()
    if not g["checkin_open"]:
        return gate_response()
    name = (body.name or "").strip()
    if not (2 <= len(name) <= 20):
        raise HTTPException(400, "姓名需为 2—20 字")
    # 现场补录的姓名会进名单、导出与签到流水，与自助报名同一条口径
    riskword.guard({"姓名": name}, where="walkin")
    # 与报名表同一套区号规则：现场同样会来境外来宾，不能只收 86 的号
    phone_code, phone = _parse_phone(body.phone_code, body.phone)
    # 现场补录是工作人员代操作，正常一人一次；按区号+号码挡异常重试
    limit.guard("walkin", phone_code + phone, 8, 60)
    gender = body.gender if body.gender in GENDER_OPTIONS else None
    conn = get_conn()
    # 已用该号码报过名的人：直接补签到原记录，不新建第二条报名。
    # 只能按号码查——唯一索引 idx_reg_phone_active 建在 phone 单列上（不含区号），
    # 若先按 (区号, 号码) 匹配，碰到「同号码不同区号」的旧记录会查不到，
    # 接着新建就撞唯一索引，接口直接 500。
    exist_reg = conn.execute(
        "SELECT id, credential_code, phone_code FROM registration "
        "WHERE phone=? AND status='active'", (phone,)
    ).fetchone()
    if exist_reg:
        # 老记录没存区号（历史数据）：把这次现场填的补上，后台显示才不会是空的。
        # 已有区号的不覆盖——号码唯一，原值大概率是正确的，别被手误改掉。
        if not exist_reg["phone_code"]:
            with transaction() as c:
                c.execute("UPDATE registration SET phone_code=? WHERE id=?",
                          (phone_code, exist_reg["id"]))
        done = conn.execute(
            "SELECT checked_at FROM checkin WHERE registration_id=? AND checked_at IS NOT NULL LIMIT 1",
            (exist_reg["id"],),
        ).fetchone()
        if not done:
            with transaction() as c:
                insert_row(c, "checkin", {
                    "openid": body.openid,
                    "registration_id": exist_reg["id"],
                    "method": "walkin",
                    "channel": "现场补录",
                    "name": name,
                    "phone": phone,
                    "staff_id": None,
                    "checked_at": now_iso(),
                    "created_at": now_iso(),
                })
        write_admin_log("walkin", "现场补录命中已有报名：%s / %s" % (name, phone), "现场")
        logx.ev("walkin_ok", mode="existing", phone=logx.mask_phone(phone), rid=exist_reg["id"])
        return {"ok": True, "status": "checked", "credential_code": exist_reg["credential_code"],
                "existing": True, "checked_at": now_iso()}
    code = gen_code()
    write_admin_log("walkin", "现场补录：%s / %s" % (name, phone), "现场")
    with transaction() as c:
        # 现场补录是「最小登记」：只收姓名+手机号，不按 schema 必填去卡人——
        # 排队现场不可能让工作人员逐项补全。但要记下当时的 schema 版本，
        # 否则详情页会按默认版本解释这条记录，字段全对不上。
        rid = insert_row(c, "registration", {
            "openid": body.openid,
            "name": name,
            "phone_code": phone_code,
            "phone": phone,
            "gender": gender,
            "channel": "现场补录",
            "privacy": 1,
            "credential_code": code,
            "created_at": now_iso(),
            "schema_version": form_store.get_effective(actx.current_id())["version"],
        })
        insert_row(c, "checkin", {
            "openid": body.openid,
            "registration_id": rid,
            "method": "walkin",
            "channel": "现场补录",
            "name": name,
            "phone": phone,
            "staff_id": None,
            "checked_at": now_iso(),
            "created_at": now_iso(),
        })
    logx.ev("walkin_ok", mode="new", phone=logx.mask_phone(phone), rid=rid)
    return {"ok": True, "status": "checked", "credential_code": code, "checked_at": now_iso()}



# 运营侧页面不入统计：后台、现场核销、工作人员绑定。
# 前端已经拦了一层，但用户浏览器/微信里可能还缓存着旧 app.js（nginx 30d），
# 旧版拿不到这层判断，所以后端必须再挡一道——否则运营一打开后台就把 UV 抬上去。
OPS_PAGES = ("admin", "verify", "staff-bind")


@router.post("/api/track")
def track(body: TrackIn):
    page = (body.page or "").strip()
    if page.split("/")[0] in OPS_PAGES:
        return {"ok": True, "skipped": "ops_page"}
    conn = get_conn()
    insert_row(conn, "events", {
        "openid": body.openid,
        "event": body.event,
        "page": body.page,
        "ts": now_iso(),
        "payload": body.payload,
        "code": (body.code or "").strip().lower() or None,
        "did": (body.did or "").strip() or None,
    })
    conn.commit()
    return {"ok": True}




@router.post("/api/card/action")
def card_action(body: CardActionIn):
    """记录一次领卡相关点击。身份以报名记录为准，前端传的 name/phone 仅兜底。"""
    if body.action not in CARD_ACTIONS:
        raise HTTPException(400, "未知行为类型")
    openid = (body.openid or "").strip() or None
    name = (body.name or "").strip() or None
    phone = (body.phone or "").strip() or None
    conn = get_conn()
    if openid:
        reg = conn.execute(
            "SELECT name, phone FROM registration WHERE openid=?", (openid,)
        ).fetchone()
        if reg:
            name, phone = reg["name"], reg["phone"]
    if not (openid or phone or name):
        raise HTTPException(400, "缺少用户身份，无法记录")
    # 领卡明细会进后台报表与导出；name 在没有报名记录时是前端传上来的原文
    riskword.guard({"姓名": name}, where="card_action")
    # 身份口径与统计一致：phone > openid > name；三者皆空则为 NULL（唯一索引不拦无身份点击）
    identity = phone or openid or name
    # 「同一行为同一用户只记第一次」用 NOT EXISTS 全表查重，历史行也算在内：
    # 生产库里历史上已有的点击不删，但上线后同一个人再点同一行为不再新增。
    # 写成一条原子 INSERT...SELECT，避免先查后写在并发下漏判；唯一索引作为第二道保险。
    with transaction() as c:
        aid = actx.current_id()
        cur = c.execute(
            "INSERT INTO card_action "
            "(activity_id, openid, name, phone, action, source, visit_id, env, created_at, identity) "
            "SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS ("
            "  SELECT 1 FROM card_action WHERE activity_id=? AND action=? AND identity=? "
            "  AND identity IS NOT NULL)",
            (aid, openid, name, phone, body.action, body.source, body.visit_id,
             DB_ENV, now_iso(), identity,
             aid, body.action, identity),
        )
        duplicate = cur.rowcount == 0
    return {"ok": True, "duplicate": duplicate}




@router.post("/api/card/claim")
def card_claim(body: CardClaimIn):
    """小程序侧回传开卡结果（备用通道）。

    本期小程序侧不配合，真实开卡数拿不到，后台改用 card_action 点击口径；
    该接口保留，等小程序侧排期允许时再启用，未配置 CARD_CLAIM_SECRET 时一律拒绝。
    """
    if not CARD_CLAIM_SECRET:
        raise HTTPException(503, "开卡回传通道未启用")
    if not verify_card_claim_sign(body):
        raise HTTPException(401, "签名校验失败")
    status = body.status if body.status in ("claimed", "duplicate", "invalid") else "invalid"
    conn = get_conn()
    if status == "claimed" and (body.openid or body.phone):
        exist = conn.execute(
            "SELECT id FROM card_claim WHERE status='claimed' AND (openid=? OR phone=?) LIMIT 1",
            (body.openid or "", body.phone or ""),
        ).fetchone()
        if exist:
            status = "duplicate"
    with transaction() as c:
        insert_row(c, "card_claim", {
            "click_id": body.click_id,
            "openid": body.openid,
            "unionid": body.unionid,
            "phone": body.phone,
            "name": body.name,
            "status": status,
            "source": body.source,
            "created_at": now_iso(),
        })
    return {"ok": True, "status": status}
