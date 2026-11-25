"""报名附件上传（RD-04，基础版承诺：图≤2、文档≤1、单文件≤5M）。

**为什么不做成表单字段**：报名提交走 JSON（answers），文件塞不进去；
服务器没装 python-multipart，不能走 multipart。要插 file 类型就得给
form.py 加"先传文件拿 URL、再随报名提交"两步流程，动核心校验与渲染，
还要处理"传了没提交"的孤儿文件。改成报名成功后凭凭证码上传，
零核心风险，且能用同一套上传内核支撑 2.8 的主办方资料下载。

**认证**：参与者手上的参会凭证码（不是后台 token）。查报名记录时
同时限定 activity_id，跨活动拿不到——凭证码不能越活动用。

**限制在服务端**：图≤2、文档≤1 按 registration_id 计数；单文件≤5M；
格式按魔数判（不靠可伪造的扩展名），扩展名只作白名单二次约束。
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from config import (UPLOAD_DIR, UPLOAD_URL_PREFIX, UPLOAD_MAX_BYTES,
                    UPLOAD_MAX_IMAGES, UPLOAD_MAX_DOCS, UPLOAD_SIGS, BGM_MAX_BYTES)
from deps import get_conn, transaction, insert_row, now_iso, require_admin
import activity as actx
import riskword

router = APIRouter()

TZ = timezone(timedelta(hours=8))
# 扩展名 → (kind, 魔数键)。docx/xlsx 同 PK 头、doc/xls 同 OLE2 头，
# 所以扩展名参与判定不是为了"信扩展名"，而是区分同头的两类格式。
EXT_MAP = {
    "png": ("image", "png"), "jpg": ("image", "jpeg"), "jpeg": ("image", "jpeg"),
    "gif": ("image", "gif"),
    "pdf": ("document", "pdf"), "doc": ("document", "doc"), "docx": ("document", "docx"),
    "xls": ("document", "doc"), "xlsx": ("document", "docx"),
}


class UploadIn(BaseModel):
    """上传请求参数走 query，文件走 raw body（见下）。此处仅用于文档。"""
    model_config = ConfigDict(extra="forbid")


def _detect(data: bytes, ext: str):
    """按魔数判格式，返回 kind；不符或扩展名不在白名单返回 None。"""
    spec = EXT_MAP.get(ext)
    if not spec:
        return None
    kind, sig_key = spec
    for sig in UPLOAD_SIGS[sig_key]:
        if data.startswith(sig):
            return kind
    return None


def _reg_by_code(conn, code: str):
    """凭证码必须在本活动内找到有效报名，跨活动不认。"""
    return conn.execute(
        "SELECT id, name FROM registration"
        " WHERE credential_code=? AND activity_id=? AND status='active'",
        (code, actx.current_id()),
    ).fetchone()


def _counts(conn, reg_id: int):
    rows = conn.execute(
        "SELECT kind, COUNT(*) AS n FROM registration_attachment"
        " WHERE registration_id=? AND status='active' GROUP BY kind", (reg_id,)
    ).fetchall()
    return {r["kind"]: r["n"] for r in rows}


@router.post("/api/attachment/upload")
async def attachment_upload(request: Request, code: str = "", filename: str = ""):
    """凭参会凭证码上传一个附件。文件走 raw body，参数走 query。"""
    code = (code or "").strip()
    ext = (filename or "").rsplit(".", 1)[-1].lower() if "." in (filename or "") else ""
    if not code:
        raise HTTPException(400, "缺少参会凭证码")
    if ext not in EXT_MAP:
        raise HTTPException(400, "只支持 PNG/JPG/GIF 图片与 PDF/Word/Excel 文档")
    # 原始文件名会显示在后台报名详情与附件列表里；附件本身没人审，
    # 名字是这条上传唯一能被扫的文本。
    riskword.guard({"文件名": filename}, where="attachment_upload")

    data = await request.body()
    if not data:
        raise HTTPException(400, "没有收到文件内容")
    if len(data) > UPLOAD_MAX_BYTES:
        raise HTTPException(413, "单个文件不能超过 5MB")
    kind = _detect(data, ext)
    if not kind:
        raise HTTPException(400, "文件内容与扩展名不符，或格式不支持")

    conn = get_conn()
    reg = _reg_by_code(conn, code)
    if not reg:
        raise HTTPException(404, "凭证码无效或非本活动报名")

    # 数量闸门：先查后写。极低概率并发超限由 UI 提示 + 后台核对兜住，
    # 不为此引入跨请求锁（现场同一人不会并发传 3 张图）。
    counts = _counts(conn, reg["id"])
    limit = UPLOAD_MAX_IMAGES if kind == "image" else UPLOAD_MAX_DOCS
    if counts.get(kind, 0) >= limit:
        raise HTTPException(409, "图片最多 2 张、文档最多 1 个，请先删除再传")

    try:
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        stamp = datetime.now(TZ).strftime("%Y%m%d-%H%M%S-%f")
        safe_code = "".join(c for c in code if c.isalnum())[:16] or "anon"
        name = "attach-%s-%s.%s" % (stamp, safe_code, ext)
        path = os.path.join(UPLOAD_DIR, name)
        with open(path, "wb") as f:
            f.write(data)
        os.chmod(path, 0o644)
    except OSError as e:
        raise HTTPException(500, "写入文件失败：%s" % e)

    url = UPLOAD_URL_PREFIX + "/" + name
    with transaction() as c:
        insert_row(c, "registration_attachment", {
            "activity_id": actx.current_id(),
            "registration_id": reg["id"],
            "kind": kind, "ext": ext,
            "filename": (filename or name)[:120],
            "url": url, "size_bytes": len(data),
            "credential_code": code, "status": "active",
            "created_at": now_iso(),
        })
    return {"ok": True, "kind": kind, "url": url, "size": len(data)}


@router.get("/api/attachment/mine")
def attachment_mine(code: str = ""):
    """参与者按凭证码查自己已传的附件（成功页回显、支持删除重传）。"""
    code = (code or "").strip()
    if not code:
        raise HTTPException(400, "缺少参会凭证码")
    reg = _reg_by_code(get_conn(), code)
    if not reg:
        raise HTTPException(404, "凭证码无效或非本活动报名")
    rows = get_conn().execute(
        "SELECT id, kind, filename, url, size_bytes FROM registration_attachment"
        " WHERE registration_id=? AND status='active' ORDER BY id ASC", (reg["id"],)
    ).fetchall()
    return {"ok": True, "rows": [{
        "id": r["id"], "kind": r["kind"], "filename": r["filename"],
        "url": r["url"], "size": r["size_bytes"],
    } for r in rows], "limits": {"image": UPLOAD_MAX_IMAGES, "document": UPLOAD_MAX_DOCS}}


@router.delete("/api/attachment/mine/{item_id}")
def attachment_delete(item_id: int, code: str = ""):
    """删除自己的附件：凭证码必须能定位到该附件所属的报名，防替人删。"""
    code = (code or "").strip()
    reg = _reg_by_code(get_conn(), code)
    if not reg:
        raise HTTPException(404, "凭证码无效或非本活动报名")
    with transaction() as c:
        cur = c.execute(
            "UPDATE registration_attachment SET status='revoked'"
            " WHERE id=? AND registration_id=? AND status='active'",
            (item_id, reg["id"]))
        if cur.rowcount == 0:
            raise HTTPException(404, "附件不存在")
    return {"ok": True}


# ---------------- 后台：按报名看附件（主办方收作品）----------------
@router.get("/api/admin/attachment/list")
def admin_attachment_list(token: str = "", code: str = ""):
    """按凭证码或报名 id 查附件。主办方收作品用；需后台登录。"""
    require_admin(token)
    sql = ("SELECT a.id, a.registration_id, a.kind, a.filename, a.url, a.size_bytes,"
           " a.created_at, r.name FROM registration_attachment a"
           " JOIN registration r ON r.id=a.registration_id"
           " WHERE a.activity_id=? AND a.status='active'")
    params = [actx.current_id()]
    if code:
        sql += " AND a.credential_code=?"
        params.append(code.strip())
    sql += " ORDER BY a.id ASC"
    rows = get_conn().execute(sql, params).fetchall()
    return {"ok": True, "rows": [{
        "id": r["id"], "registration_id": r["registration_id"],
        "name": r["name"], "kind": r["kind"], "filename": r["filename"],
        "url": r["url"], "size": r["size_bytes"], "created_at": r["created_at"],
    } for r in rows]}
