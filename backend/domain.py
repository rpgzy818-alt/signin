"""域名工具（单机构版）。

原项目是多机构 SaaS：客户可以绑自己的域名，平台也提供 `<短码>.父域` 的托管子域，
所以需要一整套域名归属校验（解析 IP 比对、占用冲突检查、验证状态机）。

单机构版只服务一家机构，这些能力整体不适用：
- **没有归属校验**：部署在哪个域名下就是哪家，不存在「谁的域名」的问题
- **没有托管子域**：没有父域，`org_suffix()` 恒为空
- **没有绑定流程**：后台不提供独立域名入口

保留同名函数是为了让 `activity.py` 与 `routers/admin.py` 的调用点一行不改——
接口一致、语义简化，是拆分里改动面最小的一种做法。
"""
from __future__ import annotations

import ipaddress
import re
from typing import Optional, Set, Tuple

import config

# 保留标签：即使将来要支持托管子域，这些也不能作为机构短码
RESERVED_LABELS = {"www", "api", "admin", "static", "assets", "mail", "ftp"}

_LABEL_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


def site_host() -> str:
    """站点主域名。留空表示「按请求 Host 处理」，单机构版通常就是空。"""
    return getattr(config, "SITE_HOST", "") or ""


def norm(host: Optional[str]) -> str:
    """把 Host 归一：小写、去端口、去尾点。"""
    h = (host or "").strip().lower()
    if h.startswith("["):                      # IPv6 字面量
        return h
    h = h.split(":")[0].rstrip(".")
    return h


def org_suffix() -> str:
    """托管子域父域。单机构版恒为空——没有父域，也就不会有子域路由。"""
    return getattr(config, "ORG_DOMAIN_SUFFIX", "") or ""


def org_label_of(host: Optional[str]) -> str:
    """从 Host 反推机构短码。单机构版不通过域名区分机构，恒返回空。"""
    return ""


def is_ip_literal(host: str) -> bool:
    """是否直接是 IP（IPv4 或 IPv6）。"""
    h = norm(host)
    if not h:
        return False
    try:
        ipaddress.ip_address(h)
        return True
    except ValueError:
        return False


def is_reserved(host: str) -> bool:
    """是否保留/非法域名（保留标签、非法字符、IP 字面量、localhost）。"""
    h = norm(host)
    if not h or h == "localhost" or is_ip_literal(h):
        return True
    labels = h.split(".")
    if any(lbl in RESERVED_LABELS for lbl in labels):
        return True
    return not all(_LABEL_RE.match(lbl) for lbl in labels)


def resolve_ips(host: str) -> Set[str]:
    """解析域名到 IP 集合。单机构版不做归属校验，不解析。"""
    return set()


def points_to_us(host: str) -> Tuple[bool, str]:
    """域名是否解析到本站。单机构版无此概念，一律放行并说明原因。"""
    return True, "单机构版不做域名归属校验"


def conflict(conn, scope: str, row_id: int, host: str) -> Optional[str]:
    """域名占用冲突检查。单机构版只有一个站点，不会冲突。"""
    return None


def org_has_plan(conn, org_id: int) -> bool:
    """机构是否有可用版本。单机构版无版本与计费，恒为有。"""
    return True


def activity_has_feature(activity_id: int) -> bool:
    """活动是否够格用某项能力。单机构版无档位差异，恒为真。"""
    return True


def mark(conn, scope: str, row_id: int, verified: bool) -> None:
    """记录域名验证状态。单机构版无验证流程，空实现。"""
    return None


def status_of(row) -> dict:
    """域名状态摘要（后台展示用）。单机构版不绑域名，返回停用态。"""
    return {"domain": "", "verified": False, "status": "disabled"}
