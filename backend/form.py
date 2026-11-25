"""动态表单内核：字段类型库、schema 校验、提交校验、导出列生成。

## 为什么字段分 core 与 custom 两类

**core**：值写入 `registration` 的固定列——只有 name / phone / gender 三个通用列。
**custom**：值只写进 `registration.answers`（JSON）——其余所有字段，包括行业字段。

固定内核只留三列，因为它们担着不能丢的职责：

| 列 | 谁在用 |
|---|---|
| `phone` + `phone_code` | 活动内唯一索引（防重号）、签到按手机号匹配、脱敏展示 |
| `name` | 名单、凭证、签到台呼叫 |
| `gender` | 通用统计维度，多数活动都会收 |
| `activity_id` | 租户边界（RLS 靠它） |

2026-11-21 起不再预设任何行业固定列（学历/岗位/海外经历这类全部删除，
历史值按测试数据丢弃）。办什么活动填什么字段，由活动自己的 schema 决定，
值进 answers JSON。**我们正在创造通用规则，不背招聘专场的历史包袱。**

内核字段的**顺序、标签、必填、选项**可配，**存储位置**不变；
新增的自定义字段一律进 JSON。

## 两条必须守住的规则

1. **后端不信前端 schema**：校验一律按库里当前 published 版本做。前端拿到的
   schema 只用于渲染，提交时多传的字段直接丢弃，不可见字段不校验也不入库。
2. **schema 冻结**：活动一旦有报名，字段定义不能再改，只能发布新版本。
   否则老报名的数据无法解释（字段名换了、选项删了，历史值就成了孤儿）。
"""
from __future__ import annotations

import json
import re
from typing import Any, Optional

import textguard

# ---- 字段类型库 ----
# 每种类型声明：能配哪些属性、提交值怎么校验。新增类型必须同时补
# 前端渲染分支（`frontend/flows/signup/form-render.js`）与这里，否则前端不认。
FIELD_TYPES = {
    "text":     {"label": "单行文本", "attrs": ("min_len", "max_len", "pattern")},
    "textarea": {"label": "多行文本", "attrs": ("min_len", "max_len")},
    "phone":    {"label": "手机号（含区号）", "attrs": ()},
    "select":   {"label": "单选（下拉）", "attrs": ("options",)},
    "radio":    {"label": "单选（平铺）", "attrs": ("options",)},
    "checkbox": {"label": "多选", "attrs": ("options", "max_select", "min_select")},
    "date":     {"label": "日期（年月）", "attrs": ("min_year", "max_year")},
    "number":   {"label": "数字", "attrs": ("min", "max")},
    "email":    {"label": "邮箱", "attrs": ()},
}

# 可映射到 registration 固定列的字段 key → 实际列名。
# 不在表里的 key 一律视为 custom，只进 answers JSON。
CORE_KEYS = {
    "name": "name",
    "gender": "gender",
    "phone": "phone",              # 同时写 phone_code
}

# 必须有、不许从 schema 里删掉的 core 字段。这里的 key 是 **core 名**（= 列名），
# 不是字段 key——运营可以把 name 字段改名叫「本人姓名」、key 改成 real_name，
# 只要 core 还是 name 就成立。
#
# 为什么这两个：registration.name / phone 是 NOT NULL 且无默认值，且各自担着
# 不能替代的职责（phone 唯一索引防重号、签到按手机号匹配、凭证按姓名呼叫）。
# gender 是 core 但可空、可删——有的活动不收性别；删掉后值不再落固定列。
REQUIRED_CORE = {"name": "姓名", "phone": "手机号"}

KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# 大陆手机号：与前端、后端既有校验保持一致
CN_MOBILE_RE = re.compile(r"^1[3-9]\d{9}$")

MAX_FIELDS = 40                      # 单活动字段上限，防止 schema 膨胀到无法维护
MAX_OPTIONS = 60                     # 单字段选项上限
MAX_LABEL = 30
STATUS_DRAFT = "draft"
STATUS_PUBLISHED = "published"
STATUS_ARCHIVED = "archived"


class SchemaInvalid(ValueError):
    """schema 定义本身不合法（运营配错字段）。"""


# ---------------------------------------------------------------- 默认 schema

def default_schema() -> list[dict]:
    """默认表单：**通用活动**的最小集合——姓名 / 性别 / 手机号 + 3 项可选补充。

    2026-11-21 Mr.R 拍板：平台要适配大多数活动，不能绑死在单一行业上。
    大多数活动填姓名、性别、手机号就够了，最多再要 3 项别的。
    所以默认 6 个字段、全部 step=1（单步报名），不再有学历/院校/专业/海外经历/
    意向岗位这些招聘专场字段，也不再有第二步。

    三项补充字段故意做成**可空的通用列**（company/title/email），不绑任何行业：
    办招聘会填「现任单位」，办展会填「公司名称」，办培训填「所在机构」，都能用。
    运营要别的字段在后台改 schema 即可，这里的默认值只是「开箱能跑」的起点。

    选项从 db 常量取，保证同一份选项只有一处定义。延迟导入避免 db ↔ form
    循环导入（db 在初始化末尾才需要本函数）。
    """
    import db

    return [
        {"key": "name", "type": "text", "label": "姓名", "required": True,
         "step": 1, "width": "half", "min_len": 2, "max_len": 20, "core": "name",
         "placeholder": "", "hint": ""},
        {"key": "gender", "type": "radio", "label": "性别", "required": True,
         "step": 1, "width": "half", "options": list(db.GENDER_OPTIONS),
         "core": "gender", "display": "pick"},
        {"key": "phone", "type": "phone", "label": "手机号", "required": True,
         "step": 1, "width": "full", "core": "phone", "need_code": True},
        # ---- 三项通用补充：默认开，可删可改；都不绑定具体行业 ----
        {"key": "company", "type": "text", "label": "单位 / 机构", "required": False,
         "step": 1, "width": "full", "max_len": 40, "placeholder": ""},
        {"key": "title", "type": "text", "label": "职务 / 身份", "required": False,
         "step": 1, "width": "half", "max_len": 40, "placeholder": ""},
        {"key": "email", "type": "email", "label": "邮箱", "required": False,
         "step": 1, "width": "half", "max_len": 60, "placeholder": ""},
    ]


# ---------------------------------------------------------------- schema 校验

def validate_fields_def(fields: Any) -> list[dict]:
    """校验并规范化字段定义。配错就抛 SchemaInvalid，宁可在保存时报错，
    也不要等报名提交时才发现某个字段的选项是空的。"""
    if not isinstance(fields, list) or not fields:
        raise SchemaInvalid("字段定义必须是非空数组")
    if len(fields) > MAX_FIELDS:
        raise SchemaInvalid("字段数不能超过 %d" % MAX_FIELDS)

    seen_keys, seen_core, out = set(), set(), []
    for i, raw in enumerate(fields):
        if not isinstance(raw, dict):
            raise SchemaInvalid("第 %d 个字段不是对象" % (i + 1))
        key = (raw.get("key") or "").strip()
        if not KEY_RE.match(key):
            raise SchemaInvalid("字段标识 %r 不合法（小写字母开头，字母数字下划线，≤32 位）" % key)
        if key in seen_keys:
            raise SchemaInvalid("字段标识重复：%s" % key)
        seen_keys.add(key)

        ftype = raw.get("type")
        if ftype not in FIELD_TYPES:
            raise SchemaInvalid("字段 %s 的类型 %r 不在类型库中" % (key, ftype))

        label = (raw.get("label") or "").strip()
        if not label:
            raise SchemaInvalid("字段 %s 缺少标签" % key)
        if len(label) > MAX_LABEL:
            raise SchemaInvalid("字段 %s 的标签超过 %d 字" % (key, MAX_LABEL))

        # RD-22：只在**配置期**审字段文字（名称/说明/提示/选项/标识），
        # 不审用户提交的值——平台的责任边界是「不提供收集能力」。
        # 用 raw 而不是规范化后的 item：hint_link 等原始字段也要过一遍。
        hit = textguard.match_field(raw)
        if hit:
            raise SchemaInvalid(textguard.describe_hit(hit, key))

        item = {
            "key": key,
            "type": ftype,
            "label": label,
            "required": bool(raw.get("required")),
            "step": max(1, int(raw.get("step") or 1)),
            "width": raw.get("width") if raw.get("width") in ("full", "half") else "full",
            "placeholder": (raw.get("placeholder") or "")[:60],
            "hint": (raw.get("hint") or "")[:80],
        }

        # 选项类字段必须有非空选项
        if ftype in ("select", "radio", "checkbox"):
            opts = raw.get("options")
            if not isinstance(opts, list) or not opts:
                raise SchemaInvalid("字段 %s 必须提供选项" % key)
            clean = []
            for o in opts:
                s = str(o).strip()
                if s and s not in clean:
                    clean.append(s)
            if not clean:
                raise SchemaInvalid("字段 %s 的选项全为空" % key)
            if len(clean) > MAX_OPTIONS:
                raise SchemaInvalid("字段 %s 的选项超过 %d 个" % (key, MAX_OPTIONS))
            item["options"] = clean
            if ftype == "checkbox":
                mx = raw.get("max_select")
                item["max_select"] = int(mx) if mx else len(clean)
                if item["max_select"] < 1 or item["max_select"] > len(clean):
                    raise SchemaInvalid("字段 %s 的最多可选数不合法" % key)
                mn = raw.get("min_select")
                if mn is not None:
                    item["min_select"] = max(1, int(mn))

        # 类型专属属性
        if ftype in ("text", "textarea"):
            for k in ("min_len", "max_len"):
                if raw.get(k) is not None:
                    item[k] = int(raw[k])
            if item.get("max_len") and item.get("min_len") and item["min_len"] > item["max_len"]:
                raise SchemaInvalid("字段 %s 的最小长度大于最大长度" % key)
            if raw.get("pattern"):
                pat = str(raw["pattern"])
                try:
                    re.compile(pat)
                except re.error:
                    raise SchemaInvalid("字段 %s 的正则不合法" % key)
                item["pattern"] = pat
        if ftype == "date":
            if raw.get("min_year") is not None:
                item["min_year"] = int(raw["min_year"])
            if raw.get("max_year") is not None:
                item["max_year"] = int(raw["max_year"])
        if ftype == "number":
            for k in ("min", "max"):
                if raw.get(k) is not None:
                    item[k] = float(raw[k])
        if ftype == "phone" and raw.get("need_code") is not None:
            item["need_code"] = bool(raw["need_code"])

        # core 映射：只能是允许的键，且一个列不能被两个字段抢
        core = raw.get("core")
        if core:
            if core not in CORE_KEYS:
                raise SchemaInvalid("字段 %s 的 core 映射 %r 不被允许" % (key, core))
            if core in seen_core:
                raise SchemaInvalid("core 列 %s 被两个字段占用" % core)
            seen_core.add(core)
            item["core"] = core

        # 展示形态（前端渲染用，不影响数据）
        if raw.get("display"):
            item["display"] = str(raw["display"])
        if raw.get("wide_last"):
            item["wide_last"] = True

        # 说明弹层：hint 后面挂一个链接，点了打开指定的 modal。
        # 只接受「文案 + 目标 id」两个字符串，不开放任意 HTML——
        # 运营配进来的内容不该在用户浏览器里有执行能力。
        hl = raw.get("hint_link")
        if isinstance(hl, dict):
            text = str(hl.get("text") or "").strip()[:30]
            modal = str(hl.get("modal") or "").strip()[:40]
            if text and modal:
                item["hint_link"] = {"text": text, "modal": modal}

        # 条件显示：只支持单层比较，不做表达式求值（可预测、不会被注入）
        cond = raw.get("visible_when")
        if cond is not None:
            if not isinstance(cond, dict):
                raise SchemaInvalid("字段 %s 的显示条件格式不对" % key)
            ck = (cond.get("key") or "").strip()
            if ck not in seen_keys or ck == key:
                raise SchemaInvalid("字段 %s 的显示条件引用了不存在或自身的字段" % key)
            op = cond.get("op") or "eq"
            if op not in ("eq", "ne", "in", "nonempty"):
                raise SchemaInvalid("字段 %s 的显示条件运算符 %r 不支持" % (key, op))
            item["visible_when"] = {"key": ck, "op": op, "value": cond.get("value")}

        out.append(item)

    if not out:
        raise SchemaInvalid("字段定义为空")

    # 姓名与手机号是硬约束，不能从 schema 里删掉（原因见 REQUIRED_CORE 的注释）。
    # 允许改名改标签改选项，但不允许没有——这类错误必须在保存 schema 时就拦住，
    # 而不是等第一场报名提交时才 500。
    for need, cn in REQUIRED_CORE.items():
        if need not in seen_core:
            raise SchemaInvalid("必须保留%s字段（core=%s）" % (cn, need))

    return out


# ---------------------------------------------------------------- 提交校验

def _is_empty(v) -> bool:
    return v is None or (isinstance(v, str) and not v.strip()) or (isinstance(v, list) and not v)


def _norm_text(v) -> str:
    return str(v).strip() if v is not None else ""


def is_visible(field: dict, values: dict) -> bool:
    """按已归一化的值判断该字段是否显示。隐藏字段不校验、不入库。"""
    cond = field.get("visible_when")
    if not cond:
        return True
    cur = values.get(cond["key"])
    op = cond.get("op", "eq")
    target = cond.get("value")
    if op == "nonempty":
        return not _is_empty(cur)
    if op == "in":
        opts = target if isinstance(target, list) else [target]
        if isinstance(cur, list):
            return any(x in opts for x in cur)
        return cur in opts
    same = (cur == target) if not isinstance(cur, list) else (target in cur)
    return same if op == "eq" else not same


def validate_submission(fields: list[dict], payload: dict,
                        partial: bool = False) -> tuple[dict, list[dict]]:
    """按 schema 校验一次提交。

    返回 `(values, errors)`：
      · values 只含**通过校验且可见**的字段，key 与 schema 一致；
        custom 字段的值是标量或列表，core 字段的 phone 额外带 `phone_code`
      · errors 是 `[{"key","msg"}]`，调用方取第一条给用户看即可

    未知字段直接丢弃而不是报错：前端多带一个临时参数不该把报名挡下来。

    partial=True 用于「第二步补填」这类增量提交：只校验本次提交里出现的字段，
    未出现的既不校验也不清空。否则第二步会要求用户把第一步的必填项重填一遍。
    """
    if not isinstance(payload, dict):
        payload = {}
    scope = fields if not partial else [
        f for f in fields
        if f["key"] in payload
        or (f["type"] == "phone" and (f["key"] + "_code") in payload)
    ]
    # 可见性判断要读依赖字段的当前值。partial 下依赖字段可能不在本次提交里，
    # 用 payload 的原始值兜住（它已在第一步校验过）。
    ctx = {f["key"]: payload.get(f["key"]) for f in fields}
    values: dict = {}
    errors: list = []

    # 两轮：先把不依赖条件的值收进来，才能判断后续字段可见性。
    # 字段顺序即依赖顺序（schema 由运营按顺序配），可见字段总在条件字段之后。
    for f in scope:
        key, ftype = f["key"], f["type"]
        raw = payload.get(key)

        # phone 的区号是本字段的一部分，归一化时一起带
        if ftype == "phone":
            code = _norm_text(payload.get(key + "_code") or payload.get("phone_code") or "86")
            code = re.sub(r"\D", "", code) or "86"
            num = re.sub(r"\D", "", _norm_text(raw))
            values[key] = num
            values[key + "_code"] = code
            continue

        if ftype == "checkbox":
            if isinstance(raw, list):
                arr = [str(x).strip() for x in raw if str(x).strip()]
            else:
                arr = [x.strip() for x in _norm_text(raw).split("、") if x.strip()]
            dedup = []
            for x in arr:
                if x not in dedup:
                    dedup.append(x)
            values[key] = dedup
        elif ftype == "number":
            t = _norm_text(raw)
            values[key] = float(t) if t else None
        else:
            values[key] = _norm_text(raw)

    # 第二轮：可见性 + 类型/选项/必填校验
    for f in scope:
        key, ftype = f["key"], f["type"]
        val = values.get(key)

        if not is_visible(f, {**ctx, **values}):
            # 隐藏字段一律清空：防止把「选了是又改回否」的残留国家带进库
            values[key] = [] if ftype == "checkbox" else (None if ftype == "number" else "")
            continue

        if f.get("required") and _is_empty(val):
            errors.append({"key": key, "msg": "请填写%s" % f["label"]})
            continue
        if _is_empty(val):
            continue

        if ftype in ("text", "textarea"):
            s = val if isinstance(val, str) else str(val)
            if f.get("min_len") and len(s) < f["min_len"]:
                errors.append({"key": key, "msg": "%s至少 %d 字" % (f["label"], f["min_len"])})
            if f.get("max_len") and len(s) > f["max_len"]:
                errors.append({"key": key, "msg": "%s不能超过 %d 字" % (f["label"], f["max_len"])})
            if f.get("pattern") and not re.match(f["pattern"], s):
                errors.append({"key": key, "msg": "%s格式不正确" % f["label"]})
        elif ftype == "phone":
            num = values.get(key) or ""
            code = values.get(key + "_code") or "86"
            if code == "86" and not CN_MOBILE_RE.match(num):
                errors.append({"key": key, "msg": "请填写 11 位大陆手机号"})
            elif code != "86" and not (4 <= len(num) <= 15):
                errors.append({"key": key, "msg": "请填写有效号码"})
        elif ftype in ("select", "radio"):
            opts = f.get("options") or []
            if val not in opts:
                errors.append({"key": key, "msg": "%s取值不合法" % f["label"]})
        elif ftype == "checkbox":
            opts = f.get("options") or []
            bad = [x for x in (val or []) if x not in opts]
            if bad:
                errors.append({"key": key, "msg": "%s含不合法选项" % f["label"]})
            elif f.get("max_select") and len(val or []) > f["max_select"]:
                errors.append({"key": key, "msg": "%s最多选 %d 个" % (f["label"], f["max_select"])})
            elif f.get("min_select") and len(val or []) < f["min_select"]:
                errors.append({"key": key, "msg": "%s至少选 %d 个" % (f["label"], f["min_select"])})
        elif ftype == "date":
            # 接受「2026 年 11 月」「2026-11」「2026/11」；统一成「YYYY 年 M 月」
            # 分两步找：先在整串里定位 4 位年份，再只在该年份**之后**找月份。
            # 一次性写 `(\d{4})\D{0,2}(\d{1,2})` 会在「2026 年 6 月」上失败
            # （年份与月份之间隔着空格+汉字+空格），退化成只有年份、月份默认成 1 月。
            s = val if isinstance(val, str) else str(val)
            my = re.search(r"(\d{4})", s)
            if not my:
                errors.append({"key": key, "msg": "%s格式不正确" % f["label"]})
            else:
                y = int(my.group(1))
                mm = re.search(r"(\d{1,2})", s[my.end():])
                mo = int(mm.group(1)) if mm else 1
                mo = min(max(mo, 1), 12)
                if f.get("min_year") and y < f["min_year"]:
                    errors.append({"key": key, "msg": "%s不早于 %d 年" % (f["label"], f["min_year"])})
                elif f.get("max_year") and y > f["max_year"]:
                    errors.append({"key": key, "msg": "%s不晚于 %d 年" % (f["label"], f["max_year"])})
                else:
                    values[key] = "%d 年 %d 月" % (y, mo)
        elif ftype == "number":
            v = val
            if f.get("min") is not None and v < f["min"]:
                errors.append({"key": key, "msg": "%s不能小于 %s" % (f["label"], f["min"])})
            if f.get("max") is not None and v > f["max"]:
                errors.append({"key": key, "msg": "%s不能大于 %s" % (f["label"], f["max"])})
        elif ftype == "email":
            if not EMAIL_RE.match(str(val)):
                errors.append({"key": key, "msg": "%s格式不正确" % f["label"]})

    # RD-08 风控禁用词：只在**提交侧**扫用户填的文本，与 RD-22 的配置期词表
    # 分属两侧、规则来源不同，不复用。没有命中时不产生任何额外开销。
    # 延迟 import 避免 form ↔ riskword ↔ db 的初始化环。
    if not errors:
        from riskword import submission_errors as _risk_errors
        errors.extend(_risk_errors(scope, values))

    # 多选在库里以顿号连接存单列（CSV 不必转义，Excel 直接可读），与既有口径一致
    for f in scope:
        if f["type"] == "checkbox" and isinstance(values.get(f["key"]), list):
            values[f["key"]] = "、".join(values[f["key"]])

    return values, errors


def missing_required(fields: list[dict], submitted: dict, existing: dict) -> list[dict]:
    """增量提交后，找出「可见且必填、但既没提交、库里也没有」的字段。

    为什么需要单独一步：partial 校验只看本次提交的字段，会漏掉一种情况——
    用户改了某个条件字段的值（如「参会类型」从个人改成单位），于是原本隐藏的
    「单位名称」变成必填，但这次提交里没有它。前端会显示并要求填写，可接口不能指望前端。
    """
    state = {**existing, **submitted}      # 提交值覆盖存量，才是提交后的最终状态
    out = []
    for f in fields:
        key = f["key"]
        if not f.get("required") or key in submitted:
            continue
        if not is_visible(f, state):
            continue
        if not _is_empty(existing.get(key)):
            continue
        out.append({"key": key, "msg": "请填写%s" % f["label"]})
    return out


# ---------------------------------------------------------------- 导出列

def export_columns(fields: list[dict]) -> list[tuple[str, str, str]]:
    """按 schema 生成导出列：`(key, 表头, 类型)`，类型供取值分支用。

    只出可见字段（隐藏字段在当前活动口径下没有值，出列只会是一列空）。
    """
    out = []
    for f in fields:
        if f.get("visible_when"):
            continue
        out.append((f["key"], f["label"], f["type"]))
    return out


def split_core_custom(fields: list[dict]) -> tuple[dict, list[str]]:
    """拆出 core 映射与 custom 字段列表。写库时分别落列与 answers。"""
    core, custom = {}, []
    for f in fields:
        if f.get("core"):
            core[f["core"]] = f["key"]
        else:
            custom.append(f["key"])
    return core, custom


def custom_values(fields: list[dict], values: dict) -> dict:
    """挑出 custom 字段的最终值，作为 answers JSON 入库。"""
    _, custom = split_core_custom(fields)
    return {k: values.get(k) for k in custom if values.get(k) not in (None, "", [])}


def dumps_answers(fields: list[dict], values: dict) -> Optional[str]:
    """custom 字段值序列化成 JSON；没有自定义字段时返回 None。

    返回 None 而不是 "{}"：空 JSON 在库里和不写是两回事，
    `answers IS NULL` 能直接筛出「这个人没有填过任何自定义字段」。
    """
    data = custom_values(fields, values)
    return json.dumps(data, ensure_ascii=False) if data else None


def core_values(fields: list[dict], values: dict) -> dict:
    """按 core 映射生成「列名 → 值」，调用方直接拿去 INSERT/UPDATE。

    这样调用方不必知道 `phone` 要拆成 `phone_code` + `phone`、
    多选要合成顿号串——schema 里叫什么都行，落库形态由这里统一决定。
    空值统一成 None：库里存 "" 和存 NULL 在统计口径上是两回事。

    **只产出 values 里真实存在的字段**：增量提交（第二步补填）只带一两个字段，
    若按 schema 全量产出，未提交的列会被写成 NULL——`name` 是 NOT NULL，
    一写就 500。这一条是分步提交能成立的前提。
    """
    out = {}
    for f in fields:
        core = f.get("core")
        if not core:
            continue
        key = f["key"]
        if f["type"] == "phone":
            if key not in values and (key + "_code") not in values:
                continue
            out["phone"] = values.get(key) or None
            out["phone_code"] = values.get(key + "_code") or "86"
            continue
        if key not in values:
            continue
        col = CORE_KEYS[core]
        v = values.get(key)
        if isinstance(v, list):
            v = "、".join(v)
        if isinstance(v, str) and not v.strip():
            v = None
        out[col] = v
    return out
