"""风控禁用词（RD-08，2026-11-25 扩展为全站文本风控）。

## 这个模块管什么

平台级禁用词库 + **所有非平台超管录入、且会展示到前端的文本**的统一拦截。

扩展前只有一处：报名提交的 answers。结果是机构名可以叫「XX博彩平台」、
活动介绍可以写满违规内容、议程嘉宾礼品物料全裸奔——它们都直接渲染在
参与者页面和分享卡片上，出事的是平台自己的域名。

## 拦截点为什么不是一个函数就够

没有统一写库收口（`db.insert_row` 只管 INSERT，UPDATE 全是各路由手写），
所以只能在写接口逐个调用。为了让"下一个新接口"也不容易漏，这里只暴露
两个东西：`guard()`（写接口用）和 `submission_errors()`（表单提交用），
两边共用同一份词库与同一套匹配规则。

## 命中后怎么办

**整单拒绝**，不做"敏感词打码放行"：
- 打码只挡住了展示，数据里还是违规内容，导出、复盘、分享卡片照旧带出去；
- 报错不告诉你命中了哪个词——回显等于把词库交出去，试探几十次就能逆出全表。
  想知道具体是哪个词，看后台操作日志（`riskword_blocked` 事件只记字段与词，
  不记用户原文，日志本身也是泄露面）。

## 豁免

平台超管（platform_admin）不拦：他要建演示数据、要给客户做问题排查，
被自己的词库挡住会逼他去改库。判断走 `orgctx.is_platform_admin`，不认字面量。
"""
from __future__ import annotations

import contextlib
import sqlite3
from typing import Iterable

import logx
import riskword_lexicon as lexicon

# 只扫用户能自由输入的文本类字段；手机号/邮箱/日期不扫，避免误伤。
SCAN_TYPES = ("text", "textarea", "select", "radio", "checkbox")
MAX_WORD = 30

# 词库进程内缓存。词条少、变更低频，每次写接口都查一遍库没有必要；
# 增删改时置空，下一次请求重建。None = 还没加载，[] = 加载过但没有启用词。
_cache: dict = {"words": None}

FIELD_LABELS = "包含平台不允许的内容，请修改后再提交"


class Blocked(Exception):
    """命中禁用词。由 main.py 的异常处理器统一转 400。

    刻意不继承 HTTPException：业务模块不该知道 HTTP 状态码，
    而且这样闸门直接调函数也能 catch 到。
    """

    def __init__(self, where: str = "", field: str = "", word: str = ""):
        self.where = where
        self.field = field
        self.word = word
        super().__init__(self.message)

    @property
    def message(self) -> str:
        # 不回显命中词：回显等于把词库交出去（见模块头）。
        tail = "「%s」" % self.field if self.field else ""
        return tail + FIELD_LABELS


def _conn(conn=None):
    import db

    return conn or db.get_conn()


@contextlib.contextmanager
def _tx(conn=None):
    """有外部连接就借用（结束时提交），没有就自己开事务。

    `db.get_conn()` 返回的是 ConnProxy，它不支持 `with`——写成
    `with (conn or db.transaction())` 在传连接时必炸 TypeError，
    而这条路径只有闸门和内部调用会走，线上看不出来。
    """
    if conn is not None:
        yield conn
        conn.commit()
        return
    import db

    with db.transaction() as w:
        yield w


def _columns(conn):
    """返回 risk_word 现有列名集合；查不到（PG）返回 None。

    返回 None 不是错误：PG 新库按 SCHEMA 建表，列一定齐；只有 SQLite
    老库才需要探测。区分 None 与空集合，否则 PG 下会被当成"没有列"，
    内置词表永远种不进去——这种错在 SQLite 上完全看不出来。
    """
    try:
        return {r[1] for r in conn.execute("PRAGMA table_info(risk_word)").fetchall()}
    except Exception:
        return None


def list_words(conn=None) -> list[dict]:
    import db

    c = _conn(conn)
    try:
        rows = c.execute(
            "SELECT * FROM risk_word WHERE env=? ORDER BY id DESC", (db.DB_ENV,)
        ).fetchall()
    except sqlite3.OperationalError:
        return []                    # 老库还没建表：降级为空词库，不拖垮报名
    cols = _columns(c) or set()
    out = []
    for r in rows:
        item = dict(r)
        for k, default in (("category", ""), ("source", "custom"), ("note", "")):
            if k not in cols:
                item[k] = default
        item["category_label"] = lexicon.CATEGORIES.get(item.get("category") or "", "")
        out.append(item)
    return out


def categories() -> list[dict]:
    """分类清单，后台下拉用。含计数，便于运营看哪类还没配。"""
    counts: dict = {}
    for r in list_words():
        key = r.get("category") or ""
        counts[key] = counts.get(key, 0) + 1
    return [{"key": k, "label": v, "count": counts.get(k, 0)}
            for k, v in lexicon.CATEGORIES.items()]


def add_word(word: str, created_by: str = "", conn=None, category: str = "",
             note: str = "", source: str = "custom") -> int:
    import db

    word = (word or "").strip()[:MAX_WORD]
    if not word:
        raise ValueError("禁用词不能为空")
    if category and category not in lexicon.CATEGORIES:
        raise ValueError("未知分类: %s" % category)
    c = _conn(conn)
    existed = c.execute("SELECT id FROM risk_word WHERE word=? AND env=?",
                        (word, db.DB_ENV)).fetchone()
    if existed:
        return int(existed["id"])
    sql = ("INSERT INTO risk_word(word, enabled, created_by, created_at, env, category, note, source)"
           " VALUES(?,?,?,?,?,?,?,?)")
    args = (word, 1, created_by[:40], db.now_iso(), db.DB_ENV, category, note[:80], source)
    with _tx(conn) as w:
        cur = w.execute(sql, args)
    invalidate()
    return int(cur.lastrowid)


def delete_word(word_id: int, conn=None) -> bool:
    import db

    c = _conn(conn)
    with _tx(conn) as w:
        cur = w.execute("DELETE FROM risk_word WHERE id=?", (word_id,))
    invalidate()
    return cur.rowcount > 0


def set_enabled(word_id: int, enabled: bool, conn=None) -> bool:
    """启停。内置词被运营停用后，重启**不会**再被 seed 打开（见 seed_builtin）。"""
    import db

    c = _conn(conn)
    with _tx(conn) as w:
        cur = w.execute("UPDATE risk_word SET enabled=? WHERE id=?",
                        (1 if enabled else 0, word_id))
    invalidate()
    return cur.rowcount > 0


def import_words(text: str, created_by: str = "", category: str = "", conn=None) -> dict:
    """批量导入：一行一个词，`#` 开头为注释，空行忽略。

    为什么要有这个入口：涉政类词条平台不内置（见 riskword_lexicon 文件头），
    只能由超管从可信来源导入；一次几十上百条，逐个点不现实。
    """
    import db

    c = _conn(conn)
    added = skipped = 0
    for line in (text or "").splitlines():
        word = line.strip()
        if not word or word.startswith("#"):
            continue
        existed = c.execute("SELECT id FROM risk_word WHERE word=? AND env=?",
                            (word[:MAX_WORD], db.DB_ENV)).fetchone()
        if existed:
            skipped += 1
            continue
        add_word(word, created_by, conn=c, category=category, source="import")
        added += 1
    return {"added": added, "skipped": skipped}


def seed_builtin(conn=None) -> int:
    """把内置词表补齐到库里，返回新增条数。

    **只补不删、不覆盖**：
    - 运营删掉的词不回来——删除是明确的意思表示，回来等于跟他对着干；
    - 已存在的同名词不覆盖 enabled，否则他停用过的词重启又活了。

    `ON CONFLICT DO NOTHING` 是 SQLite 与 PG 都认的写法（`INSERT OR IGNORE`
    PG 不认，这条路以前踩过）。
    """
    import db

    c = _conn(conn)
    cols = _columns(c)
    if cols is not None and not cols:
        return 0                     # 老库还没建表，等建完再种
    # cols is None（PG）按"列齐"处理；老 SQLite 库经过 _migrate 也已补齐
    has_meta = cols is None or {"category", "note", "source"} <= cols
    added = 0
    sql_full = ("INSERT INTO risk_word(word, enabled, created_by, created_at, env,"
                " category, note, source) VALUES(?,?,?,?,?,?,?,?)"
                " ON CONFLICT (word, env) DO NOTHING")
    sql_old = ("INSERT INTO risk_word(word, enabled, created_by, created_at, env)"
               " VALUES(?,?,?,?,?) ON CONFLICT (word, env) DO NOTHING")
    with _tx(conn) as w:
        for word, category, enabled, note in lexicon.WORDS:
            existed = w.execute(
                "SELECT 1 FROM risk_word WHERE word=? AND env=?", (word, db.DB_ENV)
            ).fetchone()
            if existed:
                continue             # 已存在（含运营停用过的）一律不动
            if has_meta:
                w.execute(sql_full, (word, enabled, "system", db.now_iso(),
                                     db.DB_ENV, category, note, "builtin"))
            else:
                w.execute(sql_old, (word, enabled, "system", db.now_iso(), db.DB_ENV))
            added += 1
    invalidate()
    return added


def invalidate() -> None:
    _cache["words"] = None


def active_words(conn=None) -> list[str]:
    """当前启用的词，小写化后返回（匹配一律小写比较）。"""
    if _cache["words"] is not None:
        return _cache["words"]
    try:
        rows = [r for r in list_words(conn) if r.get("enabled")]
    except Exception:
        return []
    words = [str(r["word"]).strip().lower() for r in rows if str(r["word"]).strip()]
    # 长词优先：命中「六合彩平台」时报「六合彩平台」比报「六合彩」更贴近原文
    words.sort(key=len, reverse=True)
    _cache["words"] = words
    return words


def _is_exempt(acc) -> bool:
    """平台超管豁免。acc 可能是 dict / sqlite3.Row / None。"""
    if not acc:
        return False
    try:
        import orgctx

        return orgctx.is_platform_admin(acc)
    except Exception:
        return False


def find_hit(text: str, words: Iterable[str] | None = None) -> str:
    """返回命中的词，干净返回空串。"""
    if not text:
        return ""
    low = str(text).lower()
    pool = active_words() if words is None else list(words)
    for w in pool:
        if w and w in low:
            return w
    return ""


def guard(items, where: str = "", acc=None, conn=None) -> None:
    """写接口的统一入口：命中即抛 Blocked。

        riskword.guard({"机构名称": name, "备注": note}, where="org_info", acc=acc)

    `items` 可以是 dict（字段名→文本）或 (字段名, 文本) 的可迭代。
    值为 None / 空串自动跳过；列表会逐项扫。
    """
    if _is_exempt(acc):
        return
    words = active_words(conn)
    if not words:
        return
    pairs = items.items() if hasattr(items, "items") else items
    for field, value in pairs:
        if value is None:
            continue
        values = value if isinstance(value, (list, tuple)) else [value]
        for v in values:
            if v is None or v == "":
                continue
            hit = find_hit(v, words)
            if hit:
                logx.ev("riskword_blocked", level="warning",
                        where=where or "-", field=field, word=hit)
                raise Blocked(where=where, field=field, word=hit)


def check_values(fields: Iterable[dict], values: dict, words: Iterable[str]) -> list[dict]:
    """按当前 schema 扫本次提交的值；返回 validate_submission 同构的 errors。"""
    pool = [w.strip().lower() for w in words if w and w.strip()]
    if not pool:
        return []
    errors = []
    for f in fields:
        if f.get("type") not in SCAN_TYPES:
            continue
        key = f["key"]
        raw = values.get(key)
        texts = [str(x) for x in raw] if isinstance(raw, list) else [str(raw or "")]
        for text in texts:
            if not text:
                continue
            hit = find_hit(text, pool)
            if hit:
                logx.ev("riskword_blocked", level="warning",
                        field=key, word=hit)
                errors.append({"key": key,
                               "msg": "「%s」包含不允许提交的内容，请修改后再报名" % f.get("label", key)})
                break
    return errors


def submission_errors(fields: Iterable[dict], values: dict) -> list[dict]:
    """给 form.validate_submission 用的入口；老库没表时返回空。"""
    try:
        words = active_words()
    except Exception:
        return []
    return check_values(fields, values, words)
