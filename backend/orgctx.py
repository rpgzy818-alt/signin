"""机构上下文与归属校验（A 批）。

**三条硬规矩**（决策清单 D14）：

1. **机构来自会话，不来自前端。** org_id 由 resolve_account 从登录账号读出，
   没有任何请求头 / query 能让前端声明机构。活动才允许前端选（X-Activity-Code），
   且必须校验它属于当前机构。
2. **跨机构只有一条只读通道**：platform_admin 走它，每次写 admin_log。
   不做成散点的 `if role == ...`——那样任何人在任何接口加一句判断就能跨机构。
3. **零回归**：admin / staff 是四档角色的兼容别名，现有 `role == "admin"` 判断
   一个都不删；默认机构（id=1）与默认活动的兼容路径原样保留。

四级角色：
  platform_admin  平台超管（旧值 admin）  —— 全平台，只读排障
  org_owner       机构负责人              —— 本机构全部 + 账号 + 机构信息
  org_admin       机构管理员              —— 本机构活动/配置/数据，不含账号
  org_user        普通用户（旧值 staff）   —— 被指派的活动

有效角色（perm.effective 返回）另有一套 system/activity_admin/member，
那是活动段的快照，与本模块的账号角色不是一回事——见方案文档角色口径表。
"""
from __future__ import annotations

from typing import Optional

# 账号角色四档 + 旧值别名
PLATFORM_ADMIN = "platform_admin"
ORG_OWNER = "org_owner"
ORG_ADMIN = "org_admin"
ORG_USER = "org_user"

# 旧值 → 新值。判断时两边都认，避免迁移期锁死后台。
# 单机构版的差异：`admin` 归到 org_owner（机构负责人），而不是 platform_admin。
# 这个项目只服务一家机构，"平台超管"这个概念在这里没有对应物——真按超管算，
# 后台会显示"机构管理""跨机构检索"这类入口，点开是空数据，只会让人困惑。
_ALIASES = {
    "admin": ORG_OWNER,
    "staff": ORG_USER,
}

DEFAULT_ORG_ID = 1


class OrgScopeDenied(Exception):
    """活动不属于当前账号机构。由 perm 转成 PermissionDenied 统一出 403。"""


def norm_role(role: Optional[str]) -> str:
    """把账号角色归一到四档；未知值按最小权限 org_user 处理（fail-closed）。"""
    if role in _ALIASES:
        return _ALIASES[role]
    if role in (PLATFORM_ADMIN, ORG_OWNER, ORG_ADMIN, ORG_USER):
        return role
    return ORG_USER


def _acc_get(acc, key, default=None):
    """账号行取值：dict 与 sqlite3.Row 两种形态都要能读。

    为什么不能只写 acc.get()：登录、/admin/me 传进来的是 sqlite3.Row（没有 .get），
    一旦按 dict 写，这类账号登录直接 500——而平台超管走的是 bootstrap 口径，
    恰好绕过了这条路径，测不出来。只在这一处做兼容，调用方照常读字段。
    """
    if hasattr(acc, "get"):
        return acc.get(key, default)
    try:
        return acc[key]
    except (IndexError, KeyError, TypeError):
        return default


def is_platform_admin(acc: dict) -> bool:
    """是否平台超管。旧值 admin 与 bootstrap 应急口令都算。"""
    return bool(
        _acc_get(acc, "bootstrap")
        or norm_role(_acc_get(acc, "role")) == PLATFORM_ADMIN
    )


def org_id_of(acc: dict) -> int:
    """账号所属机构。平台超管的应急口令账号 id=0 没有 org_id，落到默认机构。"""
    return int(_acc_get(acc, "org_id") or DEFAULT_ORG_ID)


def org_role(acc) -> str:
    """账号的机构档位（归一后）。旧值 admin/staff 也按新口径返回。

    只此一处出角色字面量：界面收口、接口判定、日志文案都读它，
    免得四档角色一改，前后端各自认一套。
    """
    if is_platform_admin(acc):
        return PLATFORM_ADMIN
    return norm_role(_acc_get(acc, "role"))


def is_org_manager(acc) -> bool:
    """能否管理本机构：平台超管 / 机构负责人 / 机构管理员。

    普通用户（org_user）一律否——其权限只来自活动级授权快照。
    """
    return org_role(acc) in (PLATFORM_ADMIN, ORG_OWNER, ORG_ADMIN)


def is_org_owner(acc) -> bool:
    """机构负责人档：账号管理、机构信息这类只能一家之主定的事。"""
    return org_role(acc) in (PLATFORM_ADMIN, ORG_OWNER)


def assert_org_writable_scope(acc, org_id: int) -> None:
    """写操作前确认目标机构就是自己的机构（平台超管放行）。

    为什么单独有这一条：机构管理员能在请求体里填任意 org_id，
    只要接口照着 body 落库，跨机构写就是一次填表的事。
    """
    if is_platform_admin(acc):
        return
    if int(org_id or DEFAULT_ORG_ID) != org_id_of(acc):
        raise OrgScopeDenied("不能操作其它机构")


def assert_activity_in_org(acc: dict, activity_id: int) -> None:
    """活动必须属于当前账号的机构。平台超管放行（其跨机构查询单独留痕）。

    raise ValueError 而非 HTTPException：让调用方决定怎么转成 4xx，
    避免数据层依赖 fastapi。
    """
    if is_platform_admin(acc):
        return
    import db
    row = db.get_conn().execute(
        "SELECT org_id FROM activity WHERE id=?", (activity_id,)
    ).fetchone()
    if row is None:
        raise OrgScopeDenied("活动不存在")
    if int(row["org_id"]) != org_id_of(acc):
        raise OrgScopeDenied("活动不属于当前机构")


def accessible_org_ids(acc: dict):
    """账号可见机构集合：平台超管 None（全部），其余只本机构。"""
    if is_platform_admin(acc):
        return None
    return [org_id_of(acc)]
