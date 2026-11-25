"""工作端接口：核销、现场补录、工作人员绑定。

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
import checkin_core
import offline as offline_def

router = APIRouter()




@router.get("/api/verify/lookup")
def verify_lookup(token: str, code: str):
    if not staff_ok(token):
        raise HTTPException(403, "核销凭据无效")
    conn = get_conn()
    reg = conn.execute(
        "SELECT id, name, phone, created_at FROM registration WHERE credential_code=?",
        (code,),
    ).fetchone()
    if not reg:
        raise HTTPException(404, "未找到对应报名记录")
    ck = conn.execute(
        "SELECT method, checked_at, staff_id FROM checkin WHERE registration_id=? ORDER BY id DESC LIMIT 1",
        (reg["id"],),
    ).fetchone()
    return {
        "ok": True,
        "found": True,
        "name": mask_name(reg["name"]),
        "phone": mask_phone(reg["phone"]),
        "created_at": reg["created_at"],
        "checked_in": bool(ck and ck["checked_at"]),
        "checked_at": ck["checked_at"] if ck else None,
        "method": ck["method"] if ck else None,
    }




@router.post("/api/verify/confirm")
def verify_confirm(body: VerifyConfirmIn):
    if not staff_ok(body.token):
        raise HTTPException(403, "核销凭据无效")
    conn = get_conn()
    reg = conn.execute(
        "SELECT id, openid FROM registration WHERE credential_code=?", (body.code,)
    ).fetchone()
    if not reg:
        raise HTTPException(404, "未找到对应报名记录")
    exist = checkin_core.find_existing(reg["id"])
    if exist:
        return {"ok": True, "status": "already", "checked_at": exist}
    # 这里要取 username 写操作日志；只 SELECT id 会在下方取 ["username"] 时抛错
    staff = conn.execute(
        "SELECT id, username FROM staff WHERE token=?", (body.token,)
    ).fetchone()
    try:
        when = checkin_core.record(
            reg["id"], openid=reg["openid"], method="verify",
            channel="推文物料", staff_id=staff["id"] if staff else None)
    except checkin_core.AlreadyChecked as e:
        return {"ok": True, "status": "already", "checked_at": e.checked_at}
    write_admin_log("verify_confirm", "人工核销凭证码 %s" % body.code,
                    staff["username"] if staff else None)
    return {"ok": True, "status": "checked", "checked_at": when}




@router.get("/api/staff/resolve")
def staff_resolve(openid: str = ""):
    """当前微信是否为在册工作人员；是则回传其专属凭证，供核销页自动填入。"""
    conn = get_conn()
    row = conn.execute(
        "SELECT username, token FROM staff WHERE openid=? AND enabled=1", (openid,)
    ).fetchone() if openid else None
    if not row:
        return {"ok": True, "is_staff": False}
    return {"ok": True, "is_staff": True,
            "username": row["username"], "token": row["token"]}




@router.post("/api/staff/bind")
def staff_bind(body: StaffBindIn):
    """工作人员扫后台绑定码：一次性票据换成 openid 绑定，绑定后即可扫码核销。"""
    conn = get_conn()
    t = conn.execute(
        "SELECT * FROM staff_bind_ticket WHERE nonce=?", (body.ticket,)
    ).fetchone()
    if not t or t["used"]:
        raise HTTPException(400, "绑定码无效或已使用")
    if (t["expires_at"] or "") < now_iso():
        raise HTTPException(400, "绑定码已过期，请在后台重新生成")
    openid = (body.openid or "").strip()
    if not openid:
        raise HTTPException(400, "未获取到微信身份，请重新进入")
    dup = conn.execute(
        "SELECT id FROM staff WHERE openid=? AND id<>?", (openid, t["staff_id"])
    ).fetchone()
    if dup:
        raise HTTPException(400, "该微信已绑定其他工作人员，请先解绑")
    with transaction() as c:
        c.execute("UPDATE staff SET openid=? WHERE id=?", (openid, t["staff_id"]))
        c.execute("UPDATE staff_bind_ticket SET used=1 WHERE nonce=?", (body.ticket,))
    row = conn.execute("SELECT username FROM staff WHERE id=?", (t["staff_id"],)).fetchone()
    return {"ok": True, "username": row["username"] if row else ""}


# ==================== P8-b 离线核销 ====================

class OfflineSyncIn(BaseModel):
    items: list  # [{token, offline_token, checked_at}]，单批最多 50 条


@router.get("/api/verify/offline-token")
def verify_offline_token(token: str, code: str):
    """联网时预取一张短时签名凭证，供断网核销后在本地暂存。

    只签发给已验证的工作人员，且必须是本活动的有效报名。
    签名绑定 staff token 与活动，凭证串里不含明文 token。
    """
    if not staff_ok(token):
        raise HTTPException(403, "核销凭据无效")
    conn = get_conn()
    aid = actx.current_id()
    reg = conn.execute(
        "SELECT id FROM registration WHERE credential_code=? AND activity_id=? AND status='active'",
        (code, aid),
    ).fetchone()
    if not reg:
        raise HTTPException(404, "未找到对应报名记录")
    signed = offline_def.issue(aid, reg["id"], token)
    return {"ok": True, "offline_token": signed,
            "expires_in": offline_def.DEFAULT_TTL}


@router.post("/api/verify/offline-sync")
def verify_offline_sync(body: OfflineSyncIn):
    """联网后批量补传离线核销。逐条验签 + 走统一幂等核心。

    结果同构：每条返回 status = checked / already / rejected，
    单条失败不影响整批；幂等由 registration_id 唯一索引兜底。
    """
    items = body.items or []
    if not isinstance(items, list) or len(items) > 50:
        raise HTTPException(400, "单次最多补传 50 条")
    aid = actx.current_id()
    out = []
    for it in items:
        if not isinstance(it, dict):
            out.append({"status": "rejected", "reason": "格式错误"})
            continue
        tok = str(it.get("token") or "")
        ot = str(it.get("offline_token") or "")
        when = str(it.get("checked_at") or "")[:40]
        if not staff_ok(tok):
            out.append({"status": "rejected", "reason": "凭据无效"})
            continue
        try:
            rid, _ = offline_def.verify(ot, tok, aid)
        except offline_def.BadToken as e:
            out.append({"status": "rejected", "reason": str(e)})
            continue
        # 报名必须还在本活动
        reg = get_conn().execute(
            "SELECT id, openid FROM registration WHERE id=? AND activity_id=?", (rid, aid)
        ).fetchone()
        if not reg:
            out.append({"status": "rejected", "reason": "报名不存在"})
            continue
        try:
            when2 = checkin_core.record(
                rid, openid=reg["openid"], method="offline", channel="离线补传",
                checkin_at=when or None)
            out.append({"status": "checked", "checked_at": when2})
        except checkin_core.AlreadyChecked as e:
            out.append({"status": "already", "checked_at": e.checked_at})
        except Exception:
            out.append({"status": "rejected", "reason": "写入失败"})
    return {"ok": True, "rows": out,
            "summary": {
                "checked": sum(1 for r in out if r["status"] == "checked"),
                "already": sum(1 for r in out if r["status"] == "already"),
                "rejected": sum(1 for r in out if r["status"] == "rejected"),
            }}
