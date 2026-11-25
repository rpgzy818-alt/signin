"""活动资料下载（2.8，专业版能力位 material_download）。

方向：主办方 → 参与者。每活动一条记录，`kind=file`（≤5M PDF）与
`kind=link`（网盘链接）二选一，避免"两个都填了以哪个为准"的扯皮。

**为什么不复用 CTA 的域名白名单**：CTA 默认只放微信域名（合规要求），
而资料下载要放百度网盘、夸克等——两套用途不同，白名单不能共用。
这里默认不限制域名，只收 http/https；如需收窄由 `MATERIAL_URL_DOMAINS`
环境变量给出逗号分隔的域名表。填链接的是付费主办方，责任自负。

**上传走 raw body**：与 BGM / 报名附件同法，不引 python-multipart。
文件名前缀 `material-` 必须在 deploy.sh 的 rsync `--delete` 之前排除，
否则下次部署线上 PDF 全清。
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from config import UPLOAD_DIR, UPLOAD_URL_PREFIX, UPLOAD_MAX_BYTES, UPLOAD_SIGS
from deps import get_conn, transaction, now_iso, require_admin, write_admin_log
import activity as actx
import feature as _feature
import riskword
import perm as _perm

router = APIRouter()

TZ = timezone(timedelta(hours=8))
KINDS = {"file", "link"}
_URL_SCHEMES = {"http", "https"}
_MATERIAL_DOMAINS_ENV = "MATERIAL_URL_DOMAINS"
MAX_TITLE = 60
MAX_FILENAME = 120

PUBLIC_FIELDS = ("kind", "title", "url", "filename", "size_bytes")


class LinkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = "活动资料"
    url: str


class PatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: int


def _admin_ctx(token):
    """与日程/嘉宾同口径：登录 + 当前活动存在 + 可管理。"""
    acc = require_admin(token)
    aid = actx.current_id()
    row = get_conn().execute("SELECT id FROM activity WHERE id=?", (aid,)).fetchone()
    if not row:
        raise HTTPException(404, "活动不存在")
    ids = _perm.accessible_activity_ids(acc)
    if ids is not None and aid not in ids:
        raise HTTPException(403, "没有该活动的管理权限")
    return acc, aid


def _allowed_domains() -> set:
    raw = os.environ.get(_MATERIAL_DOMAINS_ENV, "")
    return {d.strip().lower() for d in raw.split(",") if d.strip()}


def _clean_link(url: str) -> str:
    url = (url or "").strip()
    parsed = urlparse(url)
    if parsed.scheme.lower() not in _URL_SCHEMES or not parsed.netloc:
        raise HTTPException(400, "网盘链接只支持 http/https，且必须带域名")
    if parsed.username or parsed.password:
        raise HTTPException(400, "链接不允许携带账号密码")
    allowed = _allowed_domains()
    if allowed and (parsed.hostname or "").lower() not in allowed:
        raise HTTPException(400, "该域名不在资料链接白名单内")
    return url[:500]


def _row(r) -> dict:
    return {k: (r[k] if r[k] is not None else "") for k in PUBLIC_FIELDS}


def _public_row(r) -> dict:
    """前台只拿渲染所需，不含 id / activity_id / env。"""
    return _row(r)


def public_material(aid: int):
    """供 `/config` 下发的活动资料；未开通能力位或没配都返回 None。"""
    if not _feature.enabled("material_download", aid):
        return None
    try:
        r = get_conn().execute(
            "SELECT * FROM activity_material WHERE activity_id=? AND enabled=1",
            (aid,),
        ).fetchone()
    except Exception:
        return None          # 老库还没建表：沉默降级，不拖垮 config
    return _public_row(r) if r else None


@router.get("/api/material")
def public_get():
    """公开只读：未买专业版 403；没配资料 404。"""
    _feature.require_feature("material_download")
    got = public_material(actx.current_id())
    if not got:
        raise HTTPException(404, "该活动暂未提供资料下载")
    return {"ok": True, **got}


@router.get("/api/admin/activity/material")
def admin_get(token: str = ""):
    _acc, aid = _admin_ctx(token)
    r = get_conn().execute(
        "SELECT * FROM activity_material WHERE activity_id=?", (aid,)
    ).fetchone()
    return {"ok": True, "row": dict(r) if r else None,
            "max_bytes": UPLOAD_MAX_BYTES,
            "domain_env": _MATERIAL_DOMAINS_ENV}


def _save(aid: int, data: dict, acc=None):
    """UPDATE → rowcount==0 再 INSERT；不用 ON CONFLICT（旧库主键不一致）。"""
    # 风控放在这个唯一落库点：链接与上传两条路都经过它，分别加必然漏一条。
    # 文件名是用户上传时的原始名，会显示在资料卡片的标题下方。
    riskword.guard({"资料标题": data.get("title"), "文件名": data.get("filename")},
                   where="material_save", acc=acc)
    conn = get_conn()
    old = conn.execute(
        "SELECT url, kind FROM activity_material WHERE activity_id=?", (aid,)
    ).fetchone()
    now = now_iso()
    with transaction() as c:
        if old:
            c.execute(
                "UPDATE activity_material SET kind=?, title=?, filename=?, url=?,"
                " size_bytes=?, enabled=1, updated_at=? WHERE activity_id=?",
                (data["kind"], data["title"], data["filename"], data["url"],
                 data["size_bytes"], now, aid),
            )
        else:
            c.execute(
                "INSERT INTO activity_material"
                " (activity_id, kind, title, filename, url, size_bytes, enabled,"
                " env, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (aid, data["kind"], data["title"], data["filename"], data["url"],
                 data["size_bytes"], 1, os.environ.get("DB_ENV", "staging"), now),
            )
    return old


def _remove_local_file(url: str):
    """只删自己上传的 material- 文件，绝不碰附件与 BGM。"""
    name = os.path.basename((url or "").split("?")[0])
    if not name.startswith("material-") or not name.endswith(".pdf"):
        return
    path = os.path.join(UPLOAD_DIR, name)
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


@router.post("/api/admin/activity/material/link")
def admin_save_link(body: LinkIn, token: str = ""):
    acc, aid = _admin_ctx(token)
    url = _clean_link(body.url)
    old = _save(aid, {"kind": "link", "title": (body.title or "活动资料").strip()[:MAX_TITLE],
                      "filename": "", "url": url, "size_bytes": 0}, acc=acc)
    if old and old["kind"] == "file":
        _remove_local_file(old["url"])
    write_admin_log("material_link", "活动 #%d 设置资料链接" % aid, acc["username"])
    return {"ok": True}


@router.post("/api/admin/activity/material/upload")
async def admin_upload(request: Request, token: str = "", filename: str = "",
                       title: str = "活动资料"):
    """上传 ≤5M 的 PDF。文件走 raw body，参数走 query。"""
    acc, aid = _admin_ctx(token)
    # 先审再落盘：_save 里那道是兜底，但那时文件已经写进上传目录了，
    # 被拦下的会变成一份没有数据库记录的孤儿文件。
    riskword.guard({"资料标题": title, "文件名": filename}, where="material_upload", acc=acc)
    data = await request.body()
    if not data:
        raise HTTPException(400, "没有收到文件内容")
    if len(data) > UPLOAD_MAX_BYTES:
        raise HTTPException(413, "文件不能超过 5MB")
    if not data.startswith(UPLOAD_SIGS["pdf"][0]):
        raise HTTPException(400, "只支持 PDF 文件")
    try:
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        stamp = datetime.now(TZ).strftime("%Y%m%d-%H%M%S-%f")
        name = "material-%s-%d.pdf" % (stamp, aid)
        with open(os.path.join(UPLOAD_DIR, name), "wb") as f:
            f.write(data)
        os.chmod(os.path.join(UPLOAD_DIR, name), 0o644)
    except OSError as e:
        raise HTTPException(500, "写入文件失败：%s" % e)
    url = UPLOAD_URL_PREFIX + "/" + name
    old = _save(aid, {"kind": "file", "title": (title or "活动资料").strip()[:MAX_TITLE],
                      "filename": (filename or name)[:MAX_FILENAME],
                      "url": url, "size_bytes": len(data)}, acc=acc)
    if old and old["kind"] == "file":
        _remove_local_file(old["url"])
    write_admin_log("material_upload", "活动 #%d 上传资料 %s（%d KB）"
                    % (aid, (filename or name)[:MAX_FILENAME], len(data) // 1024),
                    acc["username"])
    return {"ok": True, "url": url, "size": len(data)}


@router.patch("/api/admin/activity/material")
def admin_patch(body: PatchIn, token: str = ""):
    acc, aid = _admin_ctx(token)
    r = get_conn().execute(
        "SELECT id FROM activity_material WHERE activity_id=?", (aid,)
    ).fetchone()
    if not r:
        raise HTTPException(404, "还没有配置活动资料")
    with transaction() as c:
        c.execute("UPDATE activity_material SET enabled=?, updated_at=? WHERE activity_id=?",
                  (1 if body.enabled else 0, now_iso(), aid))
    write_admin_log("material_toggle", "活动 #%d 资料下载=%s"
                    % (aid, "开" if body.enabled else "关"), acc["username"])
    return {"ok": True}


@router.delete("/api/admin/activity/material")
def admin_delete(token: str = ""):
    acc, aid = _admin_ctx(token)
    r = get_conn().execute(
        "SELECT kind, url FROM activity_material WHERE activity_id=?", (aid,)
    ).fetchone()
    if not r:
        raise HTTPException(404, "还没有配置活动资料")
    with transaction() as c:
        c.execute("DELETE FROM activity_material WHERE activity_id=?", (aid,))
    if r["kind"] == "file":
        _remove_local_file(r["url"])
    write_admin_log("material_delete", "活动 #%d 删除资料配置" % aid, acc["username"])
    return {"ok": True}
