"""机构公开信息与活动列表（单机构版）。

原项目靠这个模块做多机构的「门户」：按短码或域名认出是哪家机构，再列出它的活动。
单机构版只有一个机构，认领逻辑退化成「永远返回那唯一一家」，
但对外返回结构保持不变，前端不用改。

保留结构的原因：机构首页（`/`）和演示链接（`?org=xxx`）都吃这个 payload，
字段一改前端就白屏。
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

MAX_ACTIVITIES = 50
STATE_LABEL = {"open": "报名中", "closed": "报名已截止", "ended": "已结束"}

_DEFAULT_ORG_SQL = "SELECT id, code, name FROM organization WHERE status='active' ORDER BY id LIMIT 1"


def _get(row, key, default=None):
    """行取值：dict 与 sqlite3.Row 两种形态都要能读。"""
    if hasattr(row, "get"):
        return row.get(key, default)
    try:
        return row[key]
    except (IndexError, KeyError, TypeError):
        return default


def _as_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def find_org(conn, code: str = "", host: str = ""):
    """定位机构。

    单机构版：给了 `?org=<code>` 就按 code 找（保持演示链接可用），
    否则直接返回唯一那家。**host 参数保留但不参与判断**——
    单机构版不靠域名区分机构，域名指向谁就是谁。
    """
    code = (code or "").strip().lower()
    if code:
        row = conn.execute(
            "SELECT id, code, name FROM organization WHERE lower(code)=? AND status='active'",
            (code,),
        ).fetchone()
        if row is not None:
            return row
    return conn.execute(_DEFAULT_ORG_SQL).fetchone()


def state_of(row, now: Optional[datetime] = None) -> str:
    """活动对外状态：open / closed / ended。

    判据优先级：管理员手动结束 > 报名开关关 > 报名截止时间已过 > 结束时间已过。
    与原实现同口径，改坏会让活动页状态显示错。
    """
    now = now or datetime.now()
    ended_flag = _get(row, "event_ended")
    if ended_flag:
        return "ended"
    if not (_get(row, "registration_switch") or 0):
        return "closed"
    reg_end = _as_dt(_get(row, "registration_end"))
    if reg_end is not None and now.tzinfo is None and reg_end.tzinfo is not None:
        now = now.replace(tzinfo=reg_end.tzinfo)
    if reg_end is not None and now >= reg_end:
        return "closed"
    ev_end = _as_dt(_get(row, "event_end"))
    if ev_end is not None and now >= ev_end:
        return "ended"
    return "open"


def list_activities(conn, org_id: int, now: Optional[datetime] = None):
    """本机构对外可看的活动，按「还来得及的在前」排。"""
    rows = conn.execute(
        "SELECT a.code, a.name, a.start_at, a.end_at,"
        "       g.registration_switch, g.registration_end, g.event_ended, g.event_end"
        "  FROM activity a LEFT JOIN gate_config g ON g.activity_id = a.id"
        " WHERE a.org_id=? AND a.status='active'"
        " ORDER BY a.id",
        (org_id,),
    ).fetchall()

    order = {"open": 0, "closed": 1, "ended": 2}
    out = []
    for r in rows[:MAX_ACTIVITIES]:
        st = state_of(r, now)
        out.append({
            "code": r["code"],
            "name": r["name"],
            "start_at": r["start_at"] or "",
            "end_at": r["end_at"] or "",
            "state": st,
            "state_label": STATE_LABEL[st],
        })

    def key(item):
        return (order[item["state"]], item["start_at"] or "9999", item["code"])

    out.sort(key=key)
    return out


def payload(conn, org_row, now: Optional[datetime] = None) -> dict:
    """机构首页的完整响应：机构公开信息 + 活动列表。

    刻意不含 note / domain / 到期时间这类经营信息——机构首页是给访客看的。
    """
    if org_row is None:
        return {"org": {"code": "", "name": ""}, "activities": []}
    return {
        "org": {"code": org_row["code"], "name": org_row["name"]},
        "activities": list_activities(conn, int(org_row["id"]), now),
    }
