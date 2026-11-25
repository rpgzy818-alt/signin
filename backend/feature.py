"""能力开关（单机构版）。

原项目是三档版本（体验 / 基础 / 专业），每个功能位按机构授权 + 活动覆盖两层
合并出实际开关，后台「功能设置」页可以对单个活动调整。

单机构版没有档位、没有计费、没有授权表。这里改成**一份静态清单**：
清单内的能力恒开，清单外的一律不存在。

为什么保留这个模块而不是删掉调用点：调用点散在 `public.py`、`admin.py`、
`agenda.py` 里，删一次要改十几处，改错一处就是 500。留同名接口、换掉实现，
风险最低，也让以后想加开关的人有地方加。

**清单的取舍标准**：报名、签到、核销、导出、物料、领卡——这是一场活动从头走到尾
必需的东西，全都留着。展位、座位、讲者、数据看板、礼品、多场次核销属于专业版，
不在此列。
"""
from __future__ import annotations

from typing import Dict, Optional

# 开源版提供的全部能力。加新功能就往这里加一行，别在业务代码里写死判断。
KEYS = (
    "signup",         # 在线报名
    "checkin",        # 扫码/自助签到
    "checkin_multi",  # 多通道核销（工作人员端 + 批量核销）
    "export",         # 名单与签到流水导出
    "material",       # 物料（海报、日历、指引）
    "card",           # 权益卡领取（可关，关了只是不显示入口）
)


def enabled_map(activity_id: Optional[int] = None) -> Dict[str, bool]:
    """当前活动的全部能力开关快照。

    参数保留是为了兼容既有调用点（它们会传 activity_id）。
    单机构版所有活动一致，传什么都一样。
    """
    return {k: True for k in KEYS}


def enabled(key: str, activity_id: Optional[int] = None) -> bool:
    """某个能力是否可用。未知 key 一律 False（与原来一致，fail-closed）。"""
    return key in KEYS


def require_feature(key: str) -> None:
    """接口护栏：能力不在清单内直接 403，业务代码不用各自判断。"""
    from fastapi import HTTPException

    if not enabled(key):
        raise HTTPException(403, "本活动未开通该功能")


def invalidate(activity_id: Optional[int] = None) -> None:
    """清缓存。静态清单没有缓存，空实现——保留是为了调用点不改。"""
    return None
