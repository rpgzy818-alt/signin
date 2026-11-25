"""公共依赖层：配置校验、数据模型、鉴权、格式化工具。

不含任何路由；由 main.py 与 routers/* 共同引用。
由 scripts/split_backend.py 从原 main.py 自动生成，改代码请直接改本文件。
"""

from fastapi import FastAPI, Request, HTTPException

from fastapi.responses import JSONResponse, PlainTextResponse

from fastapi.middleware.cors import CORSMiddleware

from pydantic import BaseModel, Field

from typing import Optional

import os

import re

import hmac

import hashlib

import secrets

import sqlite3

import json

from datetime import datetime, timedelta, timezone


from config import (ADMIN_TOKEN, CORS_ORIGINS, DB_ENV, CARD_CLAIM_SECRET,
                    SESSION_MINUTES, SUPER_ADMIN_USERNAME, validate as cfg_validate,
                    AUDIO_DIR, BGM_MAX_BYTES)

from db import (
    get_conn, transaction, now_iso, gen_code, gen_material_code, insert_row,
    CHANNEL_OPTIONS, CHECKIN_METHODS, GENDER_OPTIONS,
    site_config_get, site_config_set, gate_config_get,
)

from gate import gate_state

import orgctx

from db import TZ

from auth import (hash_password, verify_password, new_session_token,
                   token_digest, PASSWORD_MIN)


validate = cfg_validate()


PHONE_RE = re.compile(r"^1[3-9]\d{9}$")



def norm_phone_code(value):
    """区号归一：去掉 + 号，只留数字；非法或为空一律回落 86。"""
    v = (value or "86").strip().lstrip("+").strip()
    if not v.isdigit() or not (1 <= len(v) <= 4):
        return "86"
    return v



# ---------------- 入参模型 ----------------
class RegisterIn(BaseModel):
    openid: Optional[str] = None
    name: str
    phone_code: Optional[str] = "86"  # 国际区号纯数字，如 86 / 1 / 852
    phone: str
    gender: Optional[str] = None      # 男 / 女；选填
    privacy: bool = False
    channel: Optional[str] = "活动链接"
    source_code: Optional[str] = None   # 投放物料短码（URL 的 m 参数），无则空
    # 动态表单：所有非固定列的字段值都在这里。行业字段（学历/单位/岗位…）
    # 一律走 answers，不再有专属具名字段——办什么活动填什么，我们不预设。
    answers: Optional[dict] = None



class ProfileIn(BaseModel):
    """第二步（可选）：增量更新已报名的信息。第一步已落库，这里只改本次提交的字段。

    **允许额外字段**：「哪些字段在第几步」由运营配，第二步可能放任意字段。
    写死字段名会让提交的字段静默丢失——不报错，只是存不进去，最难发现。
    """
    model_config = {"extra": "allow"}

    openid: Optional[str] = None
    credential_code: Optional[str] = None
    answers: Optional[dict] = None    # 动态字段的增量值



class CheckinIn(BaseModel):
    """签到入参。三种身份凭证任给其一即可，按 凭证号 > openid > 手机号 的顺序匹配。

    为什么不能只留 openid：那是微信网页授权才有的东西。自部署不接公众号时
    根本没有 openid，签到会直接 422；现场也常有人手机没网/微信没登录，
    靠打印在报名成功页上的凭证号最稳。

    三个字段全给空由接口层拦（返回 400），不在模型层用校验器，
    是为了让错误信息能说清楚「该给哪一个」。
    """
    openid: Optional[str] = None
    credential_code: Optional[str] = None
    phone: Optional[str] = None



class WalkinIn(BaseModel):
    name: str
    phone: str
    phone_code: Optional[str] = "86"     # 国际区号纯数字，与报名表同口径
    gender: Optional[str] = None
    openid: Optional[str] = None



class VerifyLookupIn(BaseModel):
    token: str
    code: str



class VerifyConfirmIn(BaseModel):
    token: str
    code: str



class GateIn(BaseModel):
    switch: Optional[bool] = None
    window_start: Optional[str] = None
    window_end: Optional[str] = None
    registration_switch: Optional[bool] = None   # 报名开关：None 表示不修改
    event_ended: Optional[bool] = None           # 活动结束标记：None 表示不修改
    registration_end: Optional[str] = None       # 报名截止时间：空串表示清除时效
    event_end: Optional[str] = None              # 活动结束时间：空串表示清除时效



class CardClaimIn(BaseModel):
    click_id: Optional[str] = None
    openid: Optional[str] = None
    unionid: Optional[str] = None
    phone: Optional[str] = None
    name: Optional[str] = None
    status: str = "claimed"       # claimed / duplicate / invalid
    source: Optional[str] = None  # signup / checkin
    ts: Optional[str] = None      # 签名时间戳（秒），用于防重放
    sign: Optional[str] = None    # HMAC-SHA256(secret, click_id|openid|phone|ts)



class TrackIn(BaseModel):
    event: str
    page: Optional[str] = None
    openid: Optional[str] = None
    payload: Optional[str] = None
    code: Optional[str] = None    # 投放物料短码，独立成列便于按码聚合
    did: Optional[str] = None     # 设备指纹，按码统计人数时去重用



class LoginIn(BaseModel):
    username: str
    password: str



class PasswordIn(BaseModel):
    token: str
    old_password: str
    new_password: str



class AccountIn(BaseModel):
    token: str
    username: str
    password: str
    role: str = "org_user"              # platform_admin / org_owner / org_admin / org_user（旧值 admin/staff 兼容）
    can_full_phone: bool = False
    can_export: bool = False
    org_id: Optional[int] = None        # 仅平台超管可指定；机构负责人一律落到自己机构



class AccountUpdateIn(BaseModel):
    token: str
    id: int
    role: Optional[str] = None
    can_full_phone: Optional[bool] = None
    can_export: Optional[bool] = None
    enabled: Optional[bool] = None
    password: Optional[str] = None      # 管理员重置他人密码



class CardActionIn(BaseModel):
    """H5 侧领卡行为：点击领取礼物 / 点击开卡。身份由 openid 回查报名记录补齐。"""
    openid: Optional[str] = None
    action: str                     # gift_claim / card_click
    source: Optional[str] = None    # signup / checkin
    visit_id: Optional[str] = None
    name: Optional[str] = None
    phone: Optional[str] = None



class ManualCheckinIn(BaseModel):
    """后台手工签到兜底：现场 H5 不可用时，工作人员按手机号签到。
    token 走 query string（与 /admin/gate 一致），body 只放 phone。
    """
    phone: str



# ---------------- 工具 ----------------
def write_admin_log(action, detail=None, operator=None):
    """管理操作留痕：导出、核销、补录等动作写入 admin_log，后台可查。"""
    conn = get_conn()
    insert_row(conn, "admin_log", {
        "action": action,
        "detail": detail,
        "operator": operator,
        "created_at": now_iso(),
    })
    conn.commit()



def _row_get(row, name, default=None):
    """sqlite3.Row 安全取列：老库尚未迁移到新列时返回默认值，不让接口整体 500。"""
    if row is None:
        return default
    try:
        return row[name]
    except (IndexError, KeyError):
        return default



def _as_dt(s):
    """把后台存的 ISO 串解析成带时区的时间；解析失败返回 None（当作没设时效）。"""
    if not s:
        return None
    try:
        d = datetime.fromisoformat(str(s).strip().replace(" ", "T"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=TZ)



def read_switches():
    """读**当前活动**的运营开关（报名开关 / 活动结束）+ 时效约束。

    判定：开关与时间两者取「更严格」的一侧——
      registration_open = 报名开关 且 未过报名截止时间
      event_ended       = 已手动标记结束 或 已过活动结束时间
    老库缺列、缺表或本活动尚无 gate_config 行时，按 DEFAULT 返回：
    报名默认开放、活动默认未结束，绝不因缺列误判成「报名已截止」。

    **必须按 activity_id 取**（走 db.gate_config_get 这一个收口）。平台化之前
    这里写的是 `WHERE id=1`——单活动期碰巧对，多活动时活动 B 会读到活动 A 的
    开关：A 已关闭而 B 在报名，B 的访客看到「报名已截止」；反过来更糟，
    B 的报名接口会照收一个已经结束的活动的报名。
    """
    default = {"registration_open": True, "event_ended": False}
    conn = get_conn()
    try:
        row = gate_config_get(conn)
    except sqlite3.OperationalError:
        return dict(default)      # 老库缺列/缺表：按列 DEFAULT
    if not row:
        return dict(default)      # 本活动从未保存过 gate：报名默认开、活动默认未结束

    now = datetime.now(TZ)
    reg_open = bool(_row_get(row, "registration_switch", 1))
    if reg_open:
        reg_end = _as_dt(_row_get(row, "registration_end"))
        if reg_end and now > reg_end:
            reg_open = False
    ended = bool(_row_get(row, "event_ended", 0))
    if not ended:
        ev_end = _as_dt(_row_get(row, "event_end"))
        if ev_end and now > ev_end:
            ended = True
    return {"registration_open": reg_open, "event_ended": ended}



# ---------------- 账号与会话 ----------------
SESSION_WRITE_GAP = 60      # 秒：last_seen 超过这个间隔才落库，避免每次请求都写



def account_public(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        # 归一后的机构档：界面显示与判断都读它，不读 role 字面量
        "org_role": orgctx.org_role(row),
        "org_id": int(_row_get(row, "org_id", 1) or 1),
        "can_full_phone": bool(row["can_full_phone"]),
        "can_export": bool(row["can_export"]),
        "enabled": bool(row["enabled"]),
        "created_at": row["created_at"],
        "last_login_at": row["last_login_at"],
        "is_super": row["username"] == SUPER_ADMIN_USERNAME,
        # 平台超管标识：界面据此显示「机构管理」tab。判据只有一处（orgctx），
        # 前端不自己认角色字面量——否则四档角色一改，前后端口径就分叉。
        "is_platform_admin": orgctx.is_platform_admin(row),
    }



def create_session(account_id):
    token = new_session_token()
    now = datetime.now(TZ)
    with transaction() as c:
        insert_row(c, "account_session", {
            "token_hash": token_digest(token),
            "account_id": account_id,
            "created_at": now.isoformat(timespec="seconds"),
            "expires_at": (now + timedelta(minutes=SESSION_MINUTES)).isoformat(timespec="seconds"),
            "last_seen_at": now.isoformat(timespec="seconds"),
        })
    return token



def resolve_account(token):
    """token 换账号。ADMIN_TOKEN 作为应急口令，等价超级管理员。

    会话按访问滑动续期：默认 SESSION_MINUTES 分钟内有操作就不掉线，刷新页面不用重登。
    """
    if not token:
        return None
    if token == ADMIN_TOKEN:
        return {"id": 0, "username": "admin", "role": "admin",
                "can_full_phone": 1, "can_export": 1, "enabled": 1, "bootstrap": True}
    conn = get_conn()
    row = conn.execute(
        "SELECT a.*, s.expires_at AS s_expires, s.last_seen_at AS s_seen "
        "FROM account_session s JOIN account a ON a.id = s.account_id "
        "WHERE s.token_hash = ?", (token_digest(token),)
    ).fetchone()
    if not row or not row["enabled"]:
        return None
    now = datetime.now(TZ)
    if row["s_expires"] < now.isoformat(timespec="seconds"):
        conn.execute("DELETE FROM account_session WHERE token_hash=?", (token_digest(token),))
        conn.commit()
        return None
    # 滑动续期：隔一段时间才写库
    try:
        seen = datetime.fromisoformat(row["s_seen"]) if row["s_seen"] else None
    except ValueError:
        seen = None
    if not seen or (now - seen).total_seconds() > SESSION_WRITE_GAP:
        conn.execute(
            "UPDATE account_session SET last_seen_at=?, expires_at=? WHERE token_hash=?",
            (now.isoformat(timespec="seconds"),
             (now + timedelta(minutes=SESSION_MINUTES)).isoformat(timespec="seconds"),
             token_digest(token)),
        )
        conn.commit()
    acc = dict(row)
    acc["can_full_phone"] = 1 if acc["can_full_phone"] else 0
    acc["can_export"] = 1 if acc["can_export"] else 0
    acc["expires_at"] = (now + timedelta(minutes=SESSION_MINUTES)).isoformat(timespec="seconds")
    # P2：把活动级权限快照写回 acc。名单页/流水页直接读 acc["can_full_phone"]
    # 决定是否脱敏，必须在账号解析这一层就换成活动内的值，而不是各接口自己换。
    # 兼容期（默认活动无授权）会原样保留全局位，零回归。
    try:
        import perm as _perm
        eff = _perm.effective(acc)
        for k, v in eff["caps"].items():
            acc[k] = 1 if v else 0
        acc["activity_role"] = eff["role"]
        acc["activity_role_source"] = eff["source"]
    except Exception:
        # 未授权活动：权限位全部置 0（fail-closed），由各接口的 require_* 报 403。
        # 绝不在这里放行——放行等于让没授权的人看到全号。
        import perm as _perm
        for k in _perm.CAPS:
            acc[k] = 0
        acc["activity_role"] = "denied"
        acc["activity_role_source"] = "error"
    return acc



def require_login(token: str):
    acc = resolve_account(token)
    if not acc:
        raise HTTPException(401, "登录已失效，请重新登录")
    return acc



def require_admin(token: str):
    """机构管理员及以上：平台超管 / 机构负责人 / 机构管理员。

    C 批把口径从「role 字面量等于 admin」换成机构档位判断。原因不是图省事：
    admin.py 有 20 个写接口挂着这个闸门，四档角色一上线，机构负责人自己
    反而被拦在门外，机构后台就成了看得见点不动的空壳。
    org_user 仍然进不来——它对活动的权限只来自 activity_member 授权快照。
    """
    acc = require_login(token)
    if not orgctx.is_org_manager(acc):
        raise HTTPException(403, "仅机构管理员可操作")
    return acc


def require_org_owner(token: str):
    """机构负责人档：账号管理、机构信息这类只能一家之主定的事。

    机构管理员看得见入口但不渲染（方案 C 批：不渲染，不给「点一下弹没权限」）。
    后端照样拦，边界在接口这一层。
    """
    acc = require_login(token)
    if not orgctx.is_org_owner(acc):
        raise HTTPException(403, "仅机构负责人可操作")
    return acc



def _caps_for(acc):
    """能力位解析：优先用活动级授权快照，兼容期回落账号全局位。

    收敛在这一处，是因为 admin.py 已有 5 个导出接口在用 require_perm /
    acc["can_export"]，逐个改等于埋雷。这里一次改透，业务接口不用动。

    失败时（例如没授权的活动）按 fail-closed 返回全 False——宁可拒绝，
    不要因为权限解析出错就放行导出。
    """
    try:
        import perm as _perm
        eff = _perm.effective(acc)
        return eff["caps"], eff
    except Exception:
        caps = {k: False for k in _perm.CAPS} if "_perm" in locals() else {}
        for k in ("can_full_phone", "can_export"):
            caps[k] = bool(acc.get(k, False))
        return caps, None


def require_perm(token: str, perm: str):
    acc = require_login(token)
    caps, _ = _caps_for(acc)
    if not caps.get(perm, False):
        raise HTTPException(403, "当前账号无此权限")
    # 关键：把活动级快照写回 acc。调用方后面还读 acc["can_export"] /
    # acc["can_full_phone"] 决定导不导出全号——判断用活动级、执行用全局
    # 就是最隐蔽的越权：判断"有权限导出"放行，执行时却按全局位给了全号。
    for k, v in caps.items():
        acc[k] = 1 if v else 0
    return acc



def mask_phone(p: str) -> str:
    if len(p) >= 7:
        return p[:3] + "****" + p[-4:]
    return p



def mask_name(n: str) -> str:
    """姓名脱敏：张三→张*，张晓明→张*明，欧阳修文→欧**文。

    含空格的多段姓名（英文名、部分少数民族姓名）按段各自脱敏：
    John Smith → J*** S****，避免整串被压成 J********h 那种没法读的样子。
    """
    n = (n or "").strip()
    if not n:
        return ""
    if " " in n:
        return " ".join((t[:1] + "*" * (len(t) - 1)) if len(t) > 1 else t
                        for t in n.split() if t)
    if len(n) == 1:
        return "*"
    if len(n) == 2:
        return n[0] + "*"
    return n[0] + "*" * (len(n) - 2) + n[-1]



# 注：权限位沿用历史列名 can_full_phone，语义已扩展为「可查看完整信息」——
# 同时控制姓名与手机号；不改列名是为了避免无谓迁移。
def show_name(n, full) -> str:
    """按「完整信息」权限决定姓名出原值还是脱敏值。"""
    n = n or ""
    return n if full else mask_name(n)



def show_phone(p, full) -> str:
    """按「完整信息」权限决定手机号出原值还是脱敏值。"""
    p = p or ""
    return p if full else mask_phone(p)



def get_openid(req: Request) -> Optional[str]:
    # 本地联调用 ?openid= ；真机由前端经 rc-api 换得后通过 X-Openid 或 body 传入
    q = req.query_params.get("openid")
    if q:
        return q
    h = req.headers.get("X-Openid")
    return h



PAGE_SIZES = (20, 50, 100)



def page_params(page, size):
    """后台列表分页参数：单页只允许 20/50/100，默认 20。"""
    try:
        page = int(page or 1)
    except (TypeError, ValueError):
        page = 1
    try:
        size = int(size or 20)
    except (TypeError, ValueError):
        size = 20
    if size not in PAGE_SIZES:
        size = 20
    return max(1, page), size



def staff_ok(token: str) -> bool:
    if not token:
        return False
    conn = get_conn()
    row = conn.execute(
        "SELECT id FROM staff WHERE token=? AND enabled=1", (token,)
    ).fetchone()
    return row is not None



def staff_is(openid: str, conn=None) -> bool:
    """该微信是否在「可辅助签到」白名单里（按 openid，不按 token）。"""
    if not openid:
        return False
    c = conn or get_conn()
    return c.execute(
        "SELECT 1 FROM staff WHERE openid=? AND enabled=1", (openid,)
    ).fetchone() is not None



def gate_response():
    g = gate_state()
    return JSONResponse(
        status_code=403,
        content={"ok": False, "code": "gate_closed", "message": "当前不在签到时段", "data": g},
    )



# ---------------- 现场工作人员：OpenID 白名单 + 专属核销凭证 ----------------
class StaffCreateIn(BaseModel):
    token: str
    username: str
    account_id: Optional[int] = None



class StaffUpdateIn(BaseModel):
    token: str
    id: int
    enabled: Optional[bool] = None
    reset_token: Optional[bool] = None
    unbind: Optional[bool] = None



class StaffTicketIn(BaseModel):
    token: str
    id: int


class StaffDeleteIn(BaseModel):
    token: str
    id: int



class StaffBindIn(BaseModel):
    ticket: str
    openid: str



class RegStateIn(BaseModel):
    token: str
    id: int
    reason: Optional[str] = None



class RegUpdateIn(BaseModel):
    """后台改报名信息：只开放通用字段，其余业务字段走 answers。"""
    token: str
    id: int
    name: str
    phone: str
    phone_code: Optional[str] = None       # 国际区号纯数字；None 表示不改
    gender: Optional[str] = None
    answers: Optional[dict] = None



# ---------------- 背景音乐：后台可开关 + 可上传 ----------------
# 配置存 site_config（KV），不塞进 gate_config：后续平台化再加「主题色 / 落地图」这类
# 运营项时只加键、不改表结构。
BGM_DEFAULT_NAME = "bgm-full-60s-96k.mp3"



class BgmToggleIn(BaseModel):
    token: str
    enabled: bool



class BgmTokenIn(BaseModel):
    token: str



def bgm_config():
    """读背景音乐配置。

    enabled 默认开（与上线版本行为一致）；bgm_url 为空表示用内置默认曲目，
    上传过自定义文件则指向它。返回的 url 是相对站点根的路径，前端直接给 <audio src>。
    """
    cfg = site_config_get(defaults={
        "bgm_enabled": "1", "bgm_url": "", "bgm_name": "",
        "bgm_size": "", "bgm_updated_at": "",
    })
    custom = (cfg.get("bgm_url") or "").strip()
    return {
        "enabled": str(cfg.get("bgm_enabled") or "1") != "0",
        "url": custom or ("audio/" + BGM_DEFAULT_NAME),
        "custom": bool(custom),
        "name": cfg.get("bgm_name") or "",
        "size": int(cfg.get("bgm_size") or 0),
        "updated_at": cfg.get("bgm_updated_at") or "",
        "default_name": BGM_DEFAULT_NAME,
    }



def _bgm_remove_file(url):
    """删掉上一版自定义音频。只删 AUDIO_DIR 目录内的文件，防路径穿越。"""
    if not url:
        return
    base = os.path.basename(url)
    if not base:
        return
    root = os.path.abspath(AUDIO_DIR)
    path = os.path.abspath(os.path.join(root, base))
    if not path.startswith(root + os.sep):
        return
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass



# ---------------- 后台账号：登录、改密、账号管理 ----------------

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,20}$")



class AccountIdIn(BaseModel):
    token: str
    id: int



# ---------------- 领卡行为（本期口径：H5 点击，不依赖小程序回传）----------------
# 为什么不做真实开卡回传：小程序侧排期排不开，等它回调等于把统计挂在别人肩上。
# 改为「用户点领取礼物 / 点开卡」两个点击动作留痕：带身份（openid→姓名手机号）、
# 时间、行为、来源页、访问 ID，可导出与报名签到记录逐人比对。
# 口径边界：这是"点了"，不是"真开卡"；对外表述不得当开卡数用。

CARD_ACTIONS = ("gift_claim", "card_click")

CARD_ACTION_CN = {"gift_claim": "点击领取礼物", "card_click": "点击开卡"}



# ---------------- 开卡回传通道（备用：小程序侧本期不配合，仅保留接口）----------------

def card_claim_sign_src(click_id, openid, phone, ts):
    """签名原文：click_id|openid|phone|ts（字段顺序固定，双方必须一致）"""
    return "%s|%s|%s|%s" % (click_id or "", openid or "", phone or "", ts or "")



def verify_card_claim_sign(body: CardClaimIn):
    """校验小程序回传签名：共享密钥 HMAC-SHA256 + 时间戳时效（防重放）。"""
    if not CARD_CLAIM_SECRET:
        return False                     # 未配置密钥＝通道未启用，不接受写入
    if not body.ts or not body.sign:
        return False
    try:
        ts = int(body.ts)
    except (TypeError, ValueError):
        return False
    if abs(int(datetime.now(TZ).timestamp()) - ts) > 600:   # 10 分钟时效
        return False
    src = card_claim_sign_src(body.click_id, body.openid, body.phone, body.ts)
    expect = hmac.new(CARD_CLAIM_SECRET.encode("utf-8"), src.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expect, (body.sign or "").lower())
