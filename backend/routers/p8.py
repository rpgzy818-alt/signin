"""P8-c 批量核销与现场最小数据集导出。

**批量核销**：凭证码列表逐条走 checkin_core.record()（P8-a 幂等核心），
  返回 checked / already / not_found 三类统计。不因为一条失败中断整批。

**最小数据集导出**：方案要求「脱敏、不含证件号与照片」。
  现场工作人员拿到的只是一张核对名单：凭证码 + 姓名（脱敏）+ 手机后四位
  + 状态 + 核销时间。**不导出**完整手机号、answers（可能含证件号/照片）、
  openid、学历等。导出行为写 export_log 审计（沿用现有口径）。
"""
from __future__ import annotations

import csv
import io
import re
from typing import List

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict

from deps import get_conn, transaction, insert_row, now_iso, require_admin, write_admin_log
import activity as actx
import checkin_core
import perm as _perm

router = APIRouter()

_CODE_RE = re.compile(r"^[0-9A-F]{8}$")


class BatchVerifyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    codes: List[str] = []
    max_items: int = 200


def _assert_manage(acc, aid):
    ids = _perm.accessible_activity_ids(acc)
    if ids is not None and aid not in ids:
        raise HTTPException(403, "没有该活动的管理权限")


@router.post("/api/admin/activity/{aid}/batch-verify")
def batch_verify(aid: int, body: BatchVerifyIn, token: str = ""):
    """批量一键核销。逐条走幂等核心，重复码返回 already 不报错。"""
    acc = require_admin(token)
    _assert_manage(acc, aid)
    codes = [str(c or "").strip().upper() for c in body.codes if c]
    if not codes or len(codes) > body.max_items:
        raise HTTPException(400, "凭证码数量必须在 1 到 %d 之间" % body.max_items)
    bad = [c for c in codes if not _CODE_RE.match(c)]
    if bad:
        raise HTTPException(400, "凭证码必须是 8 位十六进制：%s" % bad[0])

    conn = get_conn()
    rows = []
    ph = ",".join("?" for _ in codes)
    found = {r["credential_code"]: r for r in conn.execute(
        "SELECT id, credential_code, name FROM registration"
        " WHERE activity_id=? AND status='active' AND credential_code IN (" + ph + ")",
        [aid] + codes,
    ).fetchall()}
    for code in codes:   # 保持提交顺序，运营要按导入表逐行对账
        reg = found.get(code)
        if not reg:
            rows.append({"code": code, "status": "not_found"})
            continue
        try:
            when = checkin_core.record(
                reg["id"], method="batch", channel="批量核销", name=reg["name"])
            rows.append({"code": code, "status": "checked", "checked_at": when})
        except checkin_core.AlreadyChecked as e:
            rows.append({"code": code, "status": "already", "checked_at": e.checked_at})
        except Exception:
            rows.append({"code": code, "status": "error"})
    import activity as actx2
    actx2.invalidate()
    summary = {k: sum(1 for r in rows if r["status"] == k)
               for k in ("checked", "already", "not_found", "error")}
    write_admin_log("batch_verify",
                    "活动 #%d 批量核销 %d 条（成功 %d/已核销 %d/未找到 %d）" %
                    (aid, len(codes), summary["checked"], summary["already"], summary["not_found"]),
                    acc["username"])
    return {"ok": True, "rows": rows, "summary": summary}


@router.get("/api/admin/activity/{aid}/minimal-export")
def minimal_export(aid: int, token: str = ""):
    """现场最小数据集：脱敏、无证件号、无照片、无完整手机号。"""
    acc = require_admin(token)
    _assert_manage(acc, aid)
    conn = get_conn()

    def mask_name(n):
        n = n or ""
        return n[0] + "*" * max(1, len(n) - 1) if n else ""

    regs = conn.execute(
        "SELECT r.credential_code, r.name, r.phone, r.status,"
        " (SELECT checked_at FROM checkin WHERE registration_id=r.id AND checked_at IS NOT NULL"
        "  ORDER BY id LIMIT 1) AS checked_at"
        " FROM registration r WHERE r.activity_id=? ORDER BY r.id", (aid,)
    ).fetchall()

    def cell(v):
        s = "" if v is None else str(v)
        return '"' + s.replace('"', '""') + '"' if any(ch in s for ch in ',"\n') else s

    lines = ["凭证码,姓名,手机后四位,状态,核销时间"]
    for r in regs:
        phone = r["phone"] or ""
        tail = phone[-4:] if len(phone) >= 4 else phone
        lines.append(",".join(cell(x) for x in (
            r["credential_code"] or "", mask_name(r["name"]), tail,
            "已核销" if r["checked_at"] else "未核销", r["checked_at"] or "")))
    csv_text = "\ufeff" + "\n".join(lines) + "\n"

    with transaction() as c:
        insert_row(c, "export_log", {
            "operator": acc["username"], "row_count": len(regs),
            "created_at": now_iso(),
        })
    write_admin_log("minimal_export",
                    "活动 #%d 导出最小数据集 %d 行（脱敏）" % (aid, len(regs)),
                    acc["username"])
    return PlainTextResponse(
        csv_text, media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="minimal_field_dataset.csv"'},
    )
