"""日程 / 议程接口（RD-04，基础版承诺项）。

一张表 `activity_agenda` 两种 kind：
  · schedule 日程——按天的大块（「11-29 上午 · 开幕式」）
  · agenda   议程——时段明细（「09:30-10:00 领导致辞」）

**为什么不挂功能位**：日程/议程在体验版对比表里就勾了 ✅，属于基础承诺。
feature gate 是给「买了才能用」的增值能力用的，把基础承诺也 gate 起来
等于让最低档的客户继续穿帮。公开读取只要当前活动上下文，不判开关。

**边界**：后台增删改 require_admin + 活动授权校验（与 P6 同口径）；
公开列表按当前活动过滤，只回启用行，字段白名单输出。

**安全**：map_url 只收 http/https，防 javascript: 伪协议；
所有文本字段限长，避免运营贴进整篇文章把布局撑爆。
"""
from __future__ import annotations

import re
from urllib.parse import urlparse
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from deps import (get_conn, transaction, insert_row, now_iso,
                  require_admin, write_admin_log)
import activity as actx
import perm as _perm
import riskword

router = APIRouter()

KINDS = {"schedule", "agenda"}
_MAP_RE = re.compile(r"^https?://", re.I)
_MAX = {"day": 40, "time_range": 40, "title": 80,
        "location": 80, "map_url": 500, "speaker": 60, "note": 300}


class AgendaIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = "agenda"
    day: str = ""
    time_range: str = ""
    title: str
    location: str = ""
    map_url: str = ""
    speaker: str = ""
    note: str = ""
    sort_order: int = 0
    enabled: int = 1


class AgendaPatchIn(BaseModel):
    """批量排序 / 启停：只写传了的字段。"""
    model_config = ConfigDict(extra="forbid")
    sort_order: Optional[int] = None
    enabled: Optional[int] = None


class SpeakerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    title: str = ""
    org: str = ""
    bio: str = ""
    avatar_url: str = ""
    sort_order: int = 0
    enabled: int = 1


def _get_activity(aid: int):
    row = get_conn().execute("SELECT * FROM activity WHERE id=?", (aid,)).fetchone()
    if not row:
        raise HTTPException(404, "活动不存在")
    return row


def _assert_can_manage(acc, aid: int):
    ids = _perm.accessible_activity_ids(acc)
    if ids is not None and aid not in ids:
        raise HTTPException(403, "没有该活动的管理权限")


def _clean(body: AgendaIn) -> dict:
    """校验并把字段归一成入库 dict。标题必填，其余按长度截断。"""
    kind = (body.kind or "").strip()
    if kind not in KINDS:
        raise HTTPException(400, "类型只能是 schedule 或 agenda")
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(400, "标题不能为空")
    url = (body.map_url or "").strip()
    if url and not _MAP_RE.match(url):
        raise HTTPException(400, "定位链接只支持 http/https")
    out = {
        "kind": kind, "title": title[:_MAX["title"]],
        "map_url": url[:_MAX["map_url"]],
        "sort_order": int(body.sort_order or 0),
        "enabled": 1 if body.enabled else 0,
    }
    for k in ("day", "time_range", "location", "speaker", "note"):
        out[k] = (getattr(body, k) or "").strip()[:_MAX[k]]
    # urlparse 兜底：即使前缀过了也必须有 host，挡 http:// 这种空壳
    if url:
        p = urlparse(url)
        if not p.netloc:
            raise HTTPException(400, "定位链接缺少域名")
    return out


# 公开投影的字段白名单：/agenda 与 /config 共用同一份，避免两个公开出口
# 一个漏出内部 id/排序、一个不漏——口径分裂比漏洞本身更难查。
PUBLIC_FIELDS = ("kind", "day", "time_range", "title",
                 "location", "map_url", "speaker", "note")


def public_row(r) -> dict:
    return {k: (r[k] or "") for k in PUBLIC_FIELDS}


def _row_dict(r) -> dict:
    """后台视角：带 id / 排序 / 启停，供管理界面操作。"""
    return {
        "id": r["id"], "activity_id": r["activity_id"], "kind": r["kind"],
        "day": r["day"], "time_range": r["time_range"], "title": r["title"],
        "location": r["location"], "map_url": r["map_url"],
        "speaker": r["speaker"], "note": r["note"],
        "sort_order": r["sort_order"], "enabled": r["enabled"],
    }


# ---------------- 公开只读 ----------------
@router.get("/api/agenda")
def public_agenda(kind: str = ""):
    """当前活动的日程/议程，按 sort_order 升序。只回启用行。

    kind 不传回全部，按调用方分组渲染；传了必须是合法 kind，否则 400——
    静默回空会让运营以为"配了没显示"，排查方向全错。
    """
    if kind and kind not in KINDS:
        raise HTTPException(400, "未知类型")
    aid = actx.current_id()
    sql = ("SELECT * FROM activity_agenda WHERE activity_id=? AND enabled=1")
    params = [aid]
    if kind:
        sql += " AND kind=?"
        params.append(kind)
    sql += " ORDER BY sort_order ASC, id ASC"
    rows = get_conn().execute(sql, params).fetchall()
    return {"ok": True, "rows": [public_row(r) for r in rows]}


# ---------------- 后台管理 ----------------
# 不带 {aid} 路径参数，活动从请求上下文取——与 CTA 后台接口同口径。
# 后台切活动是 setActivityCode + 整页重载，前端不必也不需要知道 aid。

def _admin_ctx(token):
    """统一后台守卫：登录 + 当前活动存在 + 可管理。返回 (账号, aid)。"""
    acc = require_admin(token)
    aid = actx.current_id()
    _get_activity(aid); _assert_can_manage(acc, aid)
    return acc, aid


@router.get("/api/admin/activity/agenda")
def admin_agenda_list(token: str = "", kind: str = ""):
    _acc, aid = _admin_ctx(token)
    if kind and kind not in KINDS:
        raise HTTPException(400, "未知类型")
    sql = "SELECT * FROM activity_agenda WHERE activity_id=?"
    params = [aid]
    if kind:
        sql += " AND kind=?"
        params.append(kind)
    sql += " ORDER BY sort_order ASC, id ASC"
    rows = get_conn().execute(sql, params).fetchall()
    return {"ok": True, "rows": [_row_dict(r) for r in rows]}


@router.post("/api/admin/activity/agenda")
def admin_agenda_create(body: AgendaIn, token: str = ""):
    acc, aid = _admin_ctx(token)
    data = _clean(body)
    # 风控：议程直接渲染在参与者日程页与 /config，标题与地点都是访客可见文本
    riskword.guard({"议程": [data.get(k) for k in ("title", "location", "speaker", "note")]},
                   where="agenda_create", acc=acc)
    now = now_iso()
    with transaction() as c:
        insert_row(c, "activity_agenda", {**data, "activity_id": aid,
                                          "created_at": now, "updated_at": now})
    write_admin_log("agenda_create",
                    "活动 #%d 新增%s「%s」" % (aid, data["kind"], data["title"]),
                    acc["username"])
    return {"ok": True}


@router.put("/api/admin/activity/agenda/{item_id}")
def admin_agenda_update(item_id: int, body: AgendaIn, token: str = ""):
    acc, aid = _admin_ctx(token)
    if not get_conn().execute("SELECT 1 FROM activity_agenda WHERE id=? AND activity_id=?",
                              (item_id, aid)).fetchone():
        raise HTTPException(404, "条目不存在")
    data = _clean(body)
    riskword.guard({"议程": [data.get(k) for k in ("title", "location", "speaker", "note")]},
                   where="agenda_update", acc=acc)
    sets = ", ".join("%s=?" % k for k in data)
    with transaction() as c:
        c.execute("UPDATE activity_agenda SET %s, updated_at=? WHERE id=? AND activity_id=?"
                  % sets, list(data.values()) + [now_iso(), item_id, aid])
    write_admin_log("agenda_update", "活动 #%d 修改%s #%d" % (aid, data["kind"], item_id),
                    acc["username"])
    return {"ok": True}


@router.patch("/api/admin/activity/agenda/{item_id}")
def admin_agenda_patch(item_id: int, body: AgendaPatchIn, token: str = ""):
    """只改排序或启停——界面上拖拽调序、一键停用时用，不必回传整条。"""
    _acc, aid = _admin_ctx(token)
    fields = {}
    if body.sort_order is not None:
        fields["sort_order"] = int(body.sort_order)
    if body.enabled is not None:
        fields["enabled"] = 1 if body.enabled else 0
    if not fields:
        raise HTTPException(400, "没有要修改的字段")
    with transaction() as c:
        cur = c.execute(
            "UPDATE activity_agenda SET %s, updated_at=? WHERE id=? AND activity_id=?"
            % ", ".join("%s=?" % k for k in fields),
            list(fields.values()) + [now_iso(), item_id, aid])
        if cur.rowcount == 0:
            raise HTTPException(404, "条目不存在")
    return {"ok": True}


@router.delete("/api/admin/activity/agenda/{item_id}")
def admin_agenda_delete(item_id: int, token: str = ""):
    acc, aid = _admin_ctx(token)
    with transaction() as c:
        cur = c.execute("DELETE FROM activity_agenda WHERE id=? AND activity_id=?",
                        (item_id, aid))
        if cur.rowcount == 0:
            raise HTTPException(404, "条目不存在")
    write_admin_log("agenda_delete", "活动 #%d 删除日程议程 #%d" % (aid, item_id),
                    acc["username"])
    return {"ok": True}


# ================= 嘉宾 / 讲师（专业版，能力位 speaker）=================
# 与日程同为「活动内容」，放在同一模块，但独立表、独立 feature gate。
# 公开读取走 require_feature：没买专业版的机构看不到、也调不通。

_SPEAKER_MAX = {"name": 40, "title": 60, "org": 80, "bio": 300, "avatar_url": 500}


def _clean_speaker(body: SpeakerIn) -> dict:
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "嘉宾姓名不能为空")
    avatar = (body.avatar_url or "").strip()
    if avatar and not _MAP_RE.match(avatar):
        raise HTTPException(400, "头像链接只支持 http/https")
    if avatar and not urlparse(avatar).netloc:
        raise HTTPException(400, "头像链接缺少域名")
    out = {"name": name[:_SPEAKER_MAX["name"]],
           "avatar_url": avatar[:_SPEAKER_MAX["avatar_url"]],
           "sort_order": int(body.sort_order or 0),
           "enabled": 1 if body.enabled else 0}
    for k in ("title", "org", "bio"):
        out[k] = (getattr(body, k) or "").strip()[:_SPEAKER_MAX[k]]
    return out


_SPEAKER_PUBLIC = ("name", "title", "org", "bio", "avatar_url")


def speaker_row(r) -> dict:
    return {k: (r[k] or "") for k in _SPEAKER_PUBLIC}


@router.get("/api/speakers")
def public_speakers():
    """嘉宾列表：专业版能力位放行，只回启用行。未开通返回 403。"""
    import feature as _feature
    _feature.require_feature("speaker")
    rows = get_conn().execute(
        "SELECT * FROM activity_speaker WHERE activity_id=? AND enabled=1"
        " ORDER BY sort_order ASC, id ASC", (actx.current_id(),)
    ).fetchall()
    return {"ok": True, "rows": [speaker_row(r) for r in rows]}


@router.get("/api/admin/activity/speakers")
def admin_speakers_list(token: str = ""):
    _acc, aid = _admin_ctx(token)
    rows = get_conn().execute(
        "SELECT * FROM activity_speaker WHERE activity_id=?"
        " ORDER BY sort_order ASC, id ASC", (aid,)
    ).fetchall()
    return {"ok": True, "rows": [{
        "id": r["id"], "activity_id": r["activity_id"],
        "name": r["name"], "title": r["title"], "org": r["org"],
        "bio": r["bio"], "avatar_url": r["avatar_url"],
        "sort_order": r["sort_order"], "enabled": r["enabled"],
    } for r in rows]}


@router.post("/api/admin/activity/speakers")
def admin_speakers_create(body: SpeakerIn, token: str = ""):
    acc, aid = _admin_ctx(token)
    data = _clean_speaker(body)
    # 风控：嘉宾姓名/头衔/单位/简介全部渲染在参与者页，简介是最长的自由文本
    riskword.guard({"嘉宾": [data.get(k) for k in ("name", "title", "org", "bio")]},
                   where="speaker_create", acc=acc)
    now = now_iso()
    with transaction() as c:
        insert_row(c, "activity_speaker", {**data, "activity_id": aid,
                                           "created_at": now, "updated_at": now})
    write_admin_log("speaker_create", "活动 #%d 新增嘉宾「%s」" % (aid, data["name"]),
                    acc["username"])
    return {"ok": True}


@router.put("/api/admin/activity/speakers/{item_id}")
def admin_speakers_update(item_id: int, body: SpeakerIn, token: str = ""):
    acc, aid = _admin_ctx(token)
    if not get_conn().execute("SELECT 1 FROM activity_speaker WHERE id=? AND activity_id=?",
                              (item_id, aid)).fetchone():
        raise HTTPException(404, "嘉宾不存在")
    data = _clean_speaker(body)
    riskword.guard({"嘉宾": [data.get(k) for k in ("name", "title", "org", "bio")]},
                   where="speaker_update", acc=acc)
    with transaction() as c:
        c.execute("UPDATE activity_speaker SET %s, updated_at=? WHERE id=? AND activity_id=?"
                  % ", ".join("%s=?" % k for k in data),
                  list(data.values()) + [now_iso(), item_id, aid])
    write_admin_log("speaker_update", "活动 #%d 修改嘉宾 #%d" % (aid, item_id),
                    acc["username"])
    return {"ok": True}


@router.patch("/api/admin/activity/speakers/{item_id}")
def admin_speakers_patch(item_id: int, body: AgendaPatchIn, token: str = ""):
    _acc, aid = _admin_ctx(token)
    fields = {}
    if body.sort_order is not None:
        fields["sort_order"] = int(body.sort_order)
    if body.enabled is not None:
        fields["enabled"] = 1 if body.enabled else 0
    if not fields:
        raise HTTPException(400, "没有要修改的字段")
    with transaction() as c:
        cur = c.execute(
            "UPDATE activity_speaker SET %s, updated_at=? WHERE id=? AND activity_id=?"
            % ", ".join("%s=?" % k for k in fields),
            list(fields.values()) + [now_iso(), item_id, aid])
        if cur.rowcount == 0:
            raise HTTPException(404, "嘉宾不存在")
    return {"ok": True}


@router.delete("/api/admin/activity/speakers/{item_id}")
def admin_speakers_delete(item_id: int, token: str = ""):
    acc, aid = _admin_ctx(token)
    with transaction() as c:
        cur = c.execute("DELETE FROM activity_speaker WHERE id=? AND activity_id=?",
                        (item_id, aid))
        if cur.rowcount == 0:
            raise HTTPException(404, "嘉宾不存在")
    write_admin_log("speaker_delete", "活动 #%d 删除嘉宾 #%d" % (aid, item_id),
                    acc["username"])
    return {"ok": True}
