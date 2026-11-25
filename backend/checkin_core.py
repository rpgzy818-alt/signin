"""核销写入核心（P8-a）：三条入口共用一个幂等实现。

**为什么必须抽这一层**：
  自助签到 / 工作人员核销 / 后台手工登记三条路径，原来都是
  「先 SELECT 查有没有 → 再 INSERT」。这是经典竞态：两个人同时扫同一个码，
  两边都查到「未核销」，两边都插入 —— 到场率统计就错了，而且不报错。

**统一做法（两层，缺一不可）**：
  1. 数据库部分唯一索引 `idx_checkin_dedup` 兜底
     （activity_id, registration_id WHERE checked_at IS NOT NULL）
  2. 写入捕获唯一约束冲突 → 当作 already 返回，不 500

  应用层 SELECT 仍保留，但只用于**快速返回**（绝大多数重复请求走这条路），
  真正的正确性靠数据库约束——并发窗口里 INSERT 会失败并被正确翻译。

**幂等键**：registration_id。凭证码 → registration 的映射由调用方查好传进来。
"""
from __future__ import annotations

import sqlite3
from typing import Optional

from deps import get_conn, transaction, insert_row, now_iso
import activity as actx
import logx


class AlreadyChecked(Exception):
    """已被核销。携带已存在的核销时间。"""

    def __init__(self, checked_at: Optional[str] = None):
        self.checked_at = checked_at
        super().__init__("already checked in")


def find_existing(registration_id: int) -> Optional[str]:
    """查已核销记录，返回 checked_at；无则 None。仅作快速路径。"""
    row = get_conn().execute(
        "SELECT checked_at FROM checkin WHERE activity_id=? AND registration_id=?"
        " AND checked_at IS NOT NULL ORDER BY id LIMIT 1",
        (actx.current_id(), registration_id),
    ).fetchone()
    return row["checked_at"] if row else None


def _is_unique_violation(exc: Exception) -> bool:
    """SQLite / PG 的唯一约束异常都认。"""
    if isinstance(exc, sqlite3.IntegrityError):
        return "UNIQUE" in str(exc).upper()
    name = type(exc).__name__
    if name == "UniqueViolation":
        return True
    return "unique" in str(exc).lower() and "violat" in str(exc).lower()


def record(registration_id: int, *, openid=None, method: str, channel=None,
           name=None, phone=None, staff_id=None, checkin_at: str = "") -> str:
    """幂等写入一条核销。返回 checked_at；重复则抛 AlreadyChecked。

    调用方应包 try/except AlreadyChecked 转成 "already" 响应。
    """
    aid = actx.current_id()
    # 快速路径：绝大多数重复点击在这里就返回，不写库
    old = find_existing(registration_id)
    if old:
        raise AlreadyChecked(old)

    when = checkin_at or now_iso()
    try:
        with transaction() as c:
            insert_row(c, "checkin", {
                "activity_id": aid,
                "openid": openid, "registration_id": registration_id,
                "method": method, "channel": channel,
                "name": name, "phone": phone, "staff_id": staff_id,
                "checked_at": when, "created_at": now_iso(),
            })
    except Exception as e:
        if _is_unique_violation(e):
            # 并发窗口里别人先写入了：约束兜住，翻译成 already
            logx.ev("checkin_dedup_hit", level="warning",
                    registration_id=registration_id, method=method)
            raise AlreadyChecked(find_existing(registration_id) or when)
        raise
    return when
