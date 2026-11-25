"""活动级权限（P2）：平台 / 活动两层角色 + 能力位。

**三层角色**（本期不做机构层，方案里 organization_member 预留）：
    system        平台超管：account.role='admin'，全部活动、全部能力
    activity_admin 活动管理员：activity_member 里 role='admin'，本活动
    member        活动成员：activity_member 里 role='member'，按能力位快照

**两条不能破的规矩**：

1. **权限是快照，不继承。** 授权那一刻把 role 与 caps 写进 activity_member，
   之后改账号的全局属性不影响进行中的活动。正在核对的现场被突然收权是真实事故。

2. **零回归兼容只给默认活动**（code='default'）：老前端不带活动标识，
   全部落到默认活动，这里沿用现有 account.role 全局判断，否则上线那一刻
   现有 staging 的后台会被瞬间锁死。

   **其它活动一律要求显式授权**，哪怕它一条成员记录都没有。否则「没有记录
   就放行」在多活动期等于给所有账号开了万能后门——A 活动授权过的人能凭
   全局角色直接进 B 活动。这个坑是专项用例抓出来的，不是想出来的。

   现场核销人员走 staff 表、与 account 完全独立，本模块不碰那条线。
"""
from __future__ import annotations

import json
from typing import Dict, List, Optional

# 能力位字典（与方案 4.3 一致）。cap 存在 activity_member.caps（JSON）里。
CAPS = {
    "can_full_phone": "查看完整信息",
    "can_export": "导出数据",
    "can_manage_members": "管理活动成员",
    "can_manage_config": "修改活动配置",
    "can_verify": "核销与补录",
}

SYSTEM = "system"
ACT_ADMIN = "activity_admin"
MEMBER = "member"

# 活动管理员默认拥有全部能力；普通成员默认只有看脱敏数据与核销
DEFAULT_CAPS = {
    ACT_ADMIN: {k: True for k in CAPS},
    MEMBER: {"can_full_phone": False, "can_export": False,
             "can_manage_members": False, "can_manage_config": False,
             "can_verify": True},
}


def _flag(acc, key: str) -> bool:
    """读账号布尔位：dict 与 sqlite3.Row 两种形态都认，缺列按 False。"""
    try:
        return bool(acc[key])
    except (KeyError, IndexError, TypeError):
        return False


class PermissionDenied(Exception):
    """权限不足（转成 HTTP 403 由调用方处理）。"""


def _parse_caps(raw) -> Dict[str, bool]:
    if not raw:
        return {}
    try:
        d = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except (ValueError, TypeError):
        return {}
    return {k: bool(v) for k, v in d.items() if k in CAPS}


def _find_member(conn, activity_id: int, account_id: int):
    return conn.execute(
        "SELECT role, caps, status FROM activity_member"
        " WHERE activity_id=? AND account_id=?",
        (activity_id, account_id),
    ).fetchone()


def _activity_has_grants(conn, activity_id: int) -> bool:
    """该活动是否已启用活动级授权（有任意一条成员记录即启用）。"""
    return bool(conn.execute(
        "SELECT 1 FROM activity_member WHERE activity_id=? LIMIT 1",
        (activity_id,),
    ).fetchone())


def effective(account: dict, activity_id: Optional[int] = None) -> dict:
    """算当前账号在指定活动的最终角色与能力。

    返回 {role, caps, source}：source 是 system / grant / global，
    便于审计与后台展示「这个权限从哪来」。
    """
    import activity as _activity
    aid = activity_id if activity_id is not None else _activity.current_id()

    # 机构归属校验（A 批）：活动必须属于账号所在机构，否则一律拒绝。
    # 平台超管放行（其跨机构查询走独立只读留痕通道）。放在权限解析最前面——
    # 归属不对就根本不往下算 caps，避免"判断用机构级、执行用活动级"的越权。
    # 零回归：默认机构/默认活动仍是同一套，历史账号 org_id 全为 1。
    import orgctx
    if aid is not None:
        try:
            orgctx.assert_activity_in_org(account, aid)
        except orgctx.OrgScopeDenied as e:
            raise PermissionDenied(str(e)) from e

    # 平台超管：全局 role=admin / platform_admin，或应急口令的 bootstrap 账号
    if orgctx.is_platform_admin(account):
        return {"role": SYSTEM, "caps": {k: True for k in CAPS}, "source": "system"}

    # 机构档（C 批）：负责人与机构管理员在本机构**全部活动**上拿活动管理员全能力。
    # 归属已在上面的 assert_activity_in_org 校验过，这里只判档位——再查一遍活动
    # 归属就是同一件事写两处。「账号管理」这类只有负责人能做的事不在 caps 里，
    # 由接口上的 require_org_owner 守，两套闸门各管各的。
    if orgctx.is_org_manager(account):
        caps = {k: True for k in CAPS}
        # 演示机构是**公开凭据**（demo/demo 贴在官网和演示链接上），机构档的
        # 「全开」必须在这里再收一道：看全号 / 导出两项只认账号位。
        # 演示数据现在是虚构的，但红线不能靠「反正是假数据」兜着——真有人往里
        # 填了真信息，就是一批真手机号被匿名访客导走。其余能力照旧全开，
        # 否则演示就点不动了（改配置、核销都要能试）。
        import config
        if orgctx.org_id_of(account) == config.DEMO_ORG_ID:
            for k in ("can_full_phone", "can_export"):
                caps[k] = _flag(account, k)
            return {"role": ACT_ADMIN, "caps": caps, "source": "demo"}
        return {"role": ACT_ADMIN, "caps": caps, "source": "org"}

    import db
    conn = db.get_conn()
    # 兼容期只覆盖默认活动。其它活动即使一条授权记录都没有，也必须显式授权，
    # 否则「没记录就放行」= 所有账号凭全局角色可进任意新活动。
    import activity as _activity
    default = _activity.load(_activity.DEFAULT_CODE)
    is_default = default is not None and aid == default.id

    if is_default and not _activity_has_grants(conn, aid):
        # 兼容期：默认活动还没启用活动级授权，沿用账号全局能力位
        return {
            "role": ACT_ADMIN if account.get("role") == "admin" else MEMBER,
            "caps": {k: bool(account.get(k, False)) for k in CAPS},
            "source": "global",
        }

    row = _find_member(conn, aid, account.get("id") or 0)
    if row is None or row["status"] != "active":
        raise PermissionDenied("当前账号未被授权访问该活动")

    role = MEMBER if row["role"] == MEMBER else ACT_ADMIN
    caps = dict(DEFAULT_CAPS[role])
    caps.update(_parse_caps(row["caps"]))   # 授权时的快照覆盖默认
    return {"role": role, "caps": caps, "source": "grant"}


def require_role(account: dict, *roles: str, activity_id: Optional[int] = None) -> dict:
    """要求当前账号在活动里是指定角色之一。"""
    eff = effective(account, activity_id)
    if eff["role"] not in roles:
        raise PermissionDenied("当前账号无权执行此操作")
    return eff


def require_cap(account: dict, cap: str, activity_id: Optional[int] = None) -> dict:
    """要求当前账号在本活动具备某项能力。"""
    eff = effective(account, activity_id)
    if not eff["caps"].get(cap, False):
        raise PermissionDenied("当前账号无此能力：%s" % CAPS.get(cap, cap))
    return eff


def accessible_activity_ids(account: dict) -> Optional[List[int]]:
    """账号可访问的活动 id 列表；None 表示全部（平台超管）。

    供后台「活动切换器」用：只列出该账号有权进入的活动。
    机构负责人/管理员看本机构全部活动——他们是按机构管的，不是按场次被指派的；
    普通用户才按 activity_member 逐场授权。
    """
    import orgctx
    if orgctx.is_platform_admin(account):
        return None
    import db
    conn = db.get_conn()
    if orgctx.is_org_manager(account):
        rows = conn.execute(
            "SELECT id FROM activity WHERE org_id=? ORDER BY id",
            (orgctx.org_id_of(account),),
        ).fetchall()
        return [r["id"] for r in rows]
    rows = conn.execute(
        "SELECT activity_id FROM activity_member"
        " WHERE account_id=? AND status='active'",
        (account.get("id") or 0,),
    ).fetchall()
    return [r["activity_id"] for r in rows]


def grant(conn, activity_id: int, account_id: int, role: str,
          caps: Optional[dict], granted_by: int, note: str = "") -> int:
    """授权（幂等 upsert）。caps 为 None 时按角色取默认快照。"""
    if role not in (ACT_ADMIN, MEMBER):
        raise ValueError("role 只能是 activity_admin / member")
    snap = dict(DEFAULT_CAPS[role])
    if caps:
        snap.update({k: bool(v) for k, v in caps.items() if k in CAPS})
    raw = json.dumps(snap, ensure_ascii=False, sort_keys=True)
    import db
    cur = conn.execute(
        "UPDATE activity_member SET role=?, caps=?, status='active',"
        " granted_by=?, granted_at=?, note=? WHERE activity_id=? AND account_id=?",
        (role, raw, granted_by, db.now_iso(), note, activity_id, account_id),
    )
    if cur.rowcount == 0:
        cur = conn.execute(
            "INSERT INTO activity_member"
            " (activity_id, account_id, role, caps, status, granted_by, granted_at, note)"
            " VALUES (?,?,?,?,'active',?,?,?)",
            (activity_id, account_id, role, raw, granted_by, db.now_iso(), note),
        )
    return cur.lastrowid or conn.execute(
        "SELECT id FROM activity_member WHERE activity_id=? AND account_id=?",
        (activity_id, account_id),
    ).fetchone()["id"]


def revoke(conn, activity_id: int, account_id: int) -> bool:
    """撤销授权：软置 disabled，保留历史。"""
    cur = conn.execute(
        "UPDATE activity_member SET status='disabled'"
        " WHERE activity_id=? AND account_id=?",
        (activity_id, account_id),
    )
    return cur.rowcount > 0


def disable_all_for_activity(conn, activity_id: int) -> int:
    """活动归档时批量失效外部协作者权限（方案 4.3 第三条）。"""
    cur = conn.execute(
        "UPDATE activity_member SET status='disabled'"
        " WHERE activity_id=? AND status='active'",
        (activity_id,),
    )
    return cur.rowcount
