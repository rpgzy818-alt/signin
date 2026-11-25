"""敏感信息禁收：后台配置字段时的文字审核（RD-22）。

## 责任边界

平台的责任是**不提供收集能力**，不是替主办方审查用户输入。所以这里只拦
「运营在后台能写出来的字段文字」——名称/说明/提示/选项/标识。用户提交什么、
附件传什么，都不在这儿管，由前台《个人信息处理说明》划清责任。

## 为什么词表要三种写法

运营配字段时可能写「身份证号」，也可能写 `sfz` 或 `id_card`；三者指向同一件事，
漏掉任一种就等于开了个后门。中文按子串匹配，拉丁字母统一转小写后按子串匹配。

## 为什么按词不按字

「银行行业峰会」是合法活动名——只因含「银行」就拒绝属于误伤。命中项必须是
「银行卡」这类完整词，不在表里的单字一律放行。

## 新增规则

往 TERMS_CN / TERMS_LATIN 加一条即可；`verify_pii_guard.py` 会自动覆盖新词。
护照、驾驶证等目前不收：需求只点名三项，扩大词表会放大误伤面。
"""
from __future__ import annotations

# 后台配置页与保存报错共用同一句文案，避免两处说法不一致
PII_NOTICE = (
    "平台不支持收集身份证号、银行卡号及证件照片；"
    "字段名称/说明/提示/选项/标识含此类字眼将无法保存。"
)

# 扫描位置 → 报错里给人看的称呼
SCAN_FIELDS = (
    ("label", "字段名称"),
    ("hint", "字段说明"),
    ("hint_link", "说明链接"),
    ("placeholder", "提示文字"),
    ("options", "选项"),
    ("key", "字段标识"),
)

# 中文词：按子串匹配。不含「银行」「证件」这类单字（会误伤合法活动名）。
TERMS_CN = (
    "身份证", "身份号码", "公民身份号码",
    "证件号", "证件号码",
    "银行卡", "银行账号", "卡号", "信用卡", "储蓄卡", "借记卡",
    "开户行", "联行号",
    "照片", "证件照", "免冠", "人像",
)

# 拼音 / 英文：统一小写后按子串匹配。
TERMS_LATIN = (
    "shenfenzheng", "sfz", "shenfen",
    "yinhangkahao", "yhkh", "yinhang",
    "zhaopian", "zhengjianzhao",
    "idcard", "id_card", "idnumber",
    "bankcard", "bank_card", "cardno", "card_no", "account_no",
    "photo", "avatar", "passport_photo",
)


def match_field(raw: dict) -> tuple[str, str] | None:
    """返回 `(位置称呼, 命中词)`，干净则返回 None。

    只吃原始字段定义（未规范化的 raw）——运营写了什么就审什么，
    规范化后的 item 丢掉了 hint_link 等字段，反而会漏。
    """
    if not isinstance(raw, dict):
        return None
    for name, where in SCAN_FIELDS:
        value = raw.get(name)
        if not value:
            continue
        if isinstance(value, (list, tuple)):
            texts = [str(x) for x in value]
        elif isinstance(value, dict):
            # hint_link = {"text": ..., "modal": ...}，两处都是运营可写的文字
            texts = [str(value.get("text") or ""), str(value.get("modal") or "")]
        else:
            texts = [str(value)]
        for text in texts:
            if any(term in text for term in TERMS_CN):
                return where, next(t for t in TERMS_CN if t in text)
            low = text.lower()
            if any(term in low for term in TERMS_LATIN):
                return where, next(t for t in TERMS_LATIN if t in low)
    return None


def describe_hit(hit: tuple[str, str], key: str) -> str:
    """给运营看的可执行报错：哪个字段、哪一处、命中了什么、该怎么改。"""
    where, term = hit
    return "字段「%s」的%s包含「%s」。%s" % (key, where, term, PII_NOTICE)
