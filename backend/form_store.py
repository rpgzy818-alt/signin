"""表单 schema 的读写与版本管理。

设计约束（与 form.py 的分工）：form.py 只做纯逻辑（校验、归一化、导出列），
不碰数据库；本模块负责存取、版本号、冻结规则。

## 版本规则

| 情形 | 行为 |
|---|---|
| 活动还没有 published 版本 | 建 version = max+1，直接 published |
| 有 published，但**还没有报名** | 原地改这一版（不升版本号，免得运营调个错字就涨一版） |
| 有 published，**已经有报名** | 冻结：旧版置 archived，新插 version = max+1 并 published |

升版本时「先归档旧的、再插新的」顺序不能反：`idx_form_schema_published`
是 `WHERE status='published'` 的部分唯一索引，同一活动同时只允许一条 published。

## 为什么读的时候不自愈写库

`get_effective()` 在没查到 published 时返回内存里的默认 schema，**不写库**。
读路径（报名页拉表单）如果写库，会把只读请求变成写请求：SQLite 单写者下
并发报名高峰会相互阻塞，PG 下则需要处理事务与 RLS 上下文。宁可让它兜底，
也不要在这里制造写热点。
"""
from __future__ import annotations

import json
from typing import Optional

import form


def _loads(s: Optional[str]) -> list:
    if not s:
        return []
    try:
        data = json.loads(s)
    except (TypeError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _dumps(fields: list) -> str:
    return json.dumps(fields, ensure_ascii=False)


def _row_to_schema(row) -> dict:
    return {
        "id": row["id"],
        "activity_id": row["activity_id"],
        "version": row["version"],
        "status": row["status"],
        "fields": _loads(row["fields"]),
        "note": row["note"],
        "created_at": row["created_at"],
    }


def list_versions(activity_id: int, conn=None) -> list[dict]:
    """该活动的所有版本，新的在前。"""
    import db

    c = conn or db.get_conn()
    rows = c.execute(
        "SELECT id, activity_id, version, status, note, created_at,"
        "       '' AS fields FROM form_schema WHERE activity_id = ?"
        " ORDER BY version DESC",
        (activity_id,),
    ).fetchall()
    out = []
    for r in rows:
        item = _row_to_schema(r)
        item.pop("fields", None)          # 列表里不需要字段明细，省带宽
        out.append(item)
    return out


def get_published(activity_id: int, conn=None) -> Optional[dict]:
    """取当前生效版本，没有则返回 None。"""
    import db

    c = conn or db.get_conn()
    row = c.execute(
        "SELECT id, activity_id, version, status, fields, note, created_at"
        " FROM form_schema WHERE activity_id = ? AND status = 'published'"
        " ORDER BY version DESC LIMIT 1",
        (activity_id,),
    ).fetchone()
    return _row_to_schema(row) if row else None


def get_version(activity_id: int, version: int, conn=None) -> Optional[dict]:
    """取指定版本（老报名按自己那版渲染详情时用）。"""
    import db

    c = conn or db.get_conn()
    row = c.execute(
        "SELECT id, activity_id, version, status, fields, note, created_at"
        " FROM form_schema WHERE activity_id = ? AND version = ?",
        (activity_id, version),
    ).fetchone()
    return _row_to_schema(row) if row else None


def get_effective(activity_id: int, conn=None) -> dict:
    """当前生效 schema；活动还没有任何版本时返回内存里的默认 schema（不写库）。

    返回 `{"version": int, "fields": [...], "self_healed": bool}`——
    `self_healed=True` 表示这是兜底的默认结构，运营还没配过。
    """
    got = get_published(activity_id, conn=conn)
    if got:
        return {"version": got["version"], "fields": got["fields"], "self_healed": False}
    return {
        "version": 1,
        "fields": form.validate_fields_def(form.default_schema()),
        "self_healed": True,
    }


def has_registrations(activity_id: int, conn=None) -> bool:
    """该活动是否已有报名（含已关闭）——有报名就不能再改结构，只能升版本。

    已关闭的报名也算：它同样是「按某一版 schema 填的数据」，结构改了它照样解释不通。
    """
    import db

    c = conn or db.get_conn()
    row = c.execute(
        "SELECT 1 FROM registration WHERE activity_id = ? LIMIT 1", (activity_id,)
    ).fetchone()
    return row is not None


def registration_count(activity_id: int, conn=None) -> int:
    import db

    c = conn or db.get_conn()
    return c.execute(
        "SELECT COUNT(*) FROM registration WHERE activity_id = ?", (activity_id,)
    ).fetchone()[0]


def save_fields(activity_id: int, fields: list, note: str = "",
                created_by: Optional[int] = None) -> dict:
    """保存字段定义，按冻结规则决定原地改还是升版本。

    返回 `{"version", "fields", "frozen", "bumped", "unchanged"}`：
      · `frozen`    该活动已有报名（保存必然升版本）
      · `bumped`    这次真的升了版本
      · `unchanged` 内容与当前版完全一致，什么都没做（也不该提示"已保存"）
    """
    import db

    fields = form.validate_fields_def(fields)
    cur = get_published(activity_id)
    frozen = has_registrations(activity_id)
    now = db.now_iso()

    with db.transaction() as c:
        if cur is None:
            nxt = (c.execute(
                "SELECT COALESCE(MAX(version), 0) FROM form_schema WHERE activity_id = ?",
                (activity_id,),
            ).fetchone()[0] or 0) + 1
            c.execute(
                "INSERT INTO form_schema (activity_id, version, status, fields, note,"
                " created_by, created_at) VALUES (?,?,?,?,?,?,?)",
                (activity_id, nxt, "published", _dumps(fields), note or "", created_by, now),
            )
            return {"version": nxt, "fields": fields, "frozen": frozen,
                    "bumped": False, "unchanged": False, "self_healed": False}

        # 内容没变就不升版本。运营多点一次保存、或者只改了备注，都不该多出一版：
        # 版本历史的价值是「回看哪一版改了什么」，被空版本淹没之后就没人看了。
        # 备注变了仍允许更新到当前版（它描述的是这一版，不是一次编辑动作）。
        if cur["fields"] == fields:
            if note and note != (cur["note"] or ""):
                c.execute("UPDATE form_schema SET note = ? WHERE id = ?", (note, cur["id"]))
            return {"version": cur["version"], "fields": fields, "frozen": frozen,
                    "bumped": False, "unchanged": True, "self_healed": False}

        if not frozen:
            # 没有报名：原地改这一版，版本号不动
            c.execute(
                "UPDATE form_schema SET fields = ?, note = ?, created_at = ? WHERE id = ?",
                (_dumps(fields), note or cur["note"] or "", now, cur["id"]),
            )
            return {"version": cur["version"], "fields": fields, "frozen": False,
                    "bumped": False, "unchanged": False, "self_healed": False}
        # 已冻结：先归档旧的，再插新的（顺序不能反，否则撞部分唯一索引）
        nxt = cur["version"] + 1
        c.execute(
            "UPDATE form_schema SET status = 'archived' WHERE id = ?", (cur["id"],)
        )
        c.execute(
            "INSERT INTO form_schema (activity_id, version, status, fields, note,"
            " created_by, created_at) VALUES (?,?,?,?,?,?,?)",
            (activity_id, nxt, "published", _dumps(fields), note or "", created_by, now),
        )
        return {"version": nxt, "fields": fields, "frozen": True,
                "bumped": True, "unchanged": False, "self_healed": False}


def render(activity_id: int) -> dict:
    """给前端的渲染数据：按 step 分组，附带 version 与是否兜底。"""
    eff = get_effective(activity_id)
    steps = {}
    for f in eff["fields"]:
        steps.setdefault(f["step"], []).append(f)
    return {
        "version": eff["version"],
        "self_healed": eff["self_healed"],
        "steps": [{"step": s, "fields": steps[s]} for s in sorted(steps)],
        "fields": eff["fields"],
    }


def export_spec(activity_id: int) -> list[dict]:
    """导出用：字段定义 + core 标记，供导出代码决定取值来源（列 or answers）。"""
    eff = get_effective(activity_id)
    return [{"key": f["key"], "label": f["label"], "type": f["type"],
             "core": f.get("core"), "visible_when": f.get("visible_when")}
            for f in eff["fields"]]
