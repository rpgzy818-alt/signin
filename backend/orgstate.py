"""机构状态与冻结（单机构版）。

原项目是 SaaS：机构有试用期、付费到期日、冻结、数据清理、解冻这一套生命周期，
所以报名入口要检查「机构是否还能收人」，新建活动要检查「机构是否只读」。

**单机构版没有这层状态**——数据在自己服务器上，不存在欠费停机。
但调用点（报名、建活动）保留着这些检查，所以这里提供同签名的空实现：
检查恒通过，异常类型保留，让 `try/except orgstate.OrgFrozen` 的代码一行不改。

安全说明：这不是"关掉了安全检查"。单机构版的隔离靠服务器边界，
不靠机构状态机——两者不是同一件事。
"""
from __future__ import annotations

from typing import Optional


class OrgFrozen(Exception):
    """机构被冻结时抛出。单机构版不会抛，保留类型供调用点 catch。"""


def state(org_id: int, mark: bool = True, row=None) -> dict:
    """机构状态摘要。单机构版恒为正常可用。"""
    return {
        "org_id": int(org_id or 1),
        "status": "normal",
        "label": "正常",
        "readonly": False,
        "accepting": True,
        "trial": False,
        "expires_at": "",
        "remaining_days": None,
    }


def is_readonly(org_id: int) -> bool:
    """是否只读。单机构版恒否。"""
    return False


def assert_writable(org_id: int, action: str = "此操作") -> None:
    """写操作前的护栏。单机构版恒通过。"""
    return None


def assert_accepting(org_id: int) -> None:
    """能否接收新报名。单机构版恒通过。"""
    return None


def purge_business_data(c, org_id: int) -> dict:
    """清理机构业务数据（到期后的数据清理）。单机构版不提供，返回空统计。"""
    return {}


def already_purged(row) -> bool:
    """是否已清理过。单机构版恒否。"""
    return False


def unfreeze(org_id: int) -> dict:
    """解冻。单机构版无冻结概念，返回正常态。"""
    return state(org_id, mark=False)
