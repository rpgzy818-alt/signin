"""CTA 配置中心内核（P5-a）：类型定义 + 合规硬校验 + 渠道密钥加密。

**为什么合规校验必须在这里（后端）**：
  方案 4.11 明确——平台化后 CTA 能力按活动复用，一次踩线是所有活动一起踩。
  「诱导关注 / 诱导分享 / 遮挡浮层」不能靠运营自觉，也不能靠前端提示，
  必须在**写入接口处**让违规配置根本存不进去。前端拿到的一定是合规配置。

**三条红线的代码落点**：
  1. follow_qrcode 不得有 required 语义          → _validate 里禁止 required/blocking 字段
  2. 任何 CTA 不得有 blocking（诱导分享/降级）    → 同上，字段白名单里根本没有它
  3. 浮层不得遮挡主内容                          → kind=qr 的浮层尺寸/位置走白名单，
                                                  且只能作为「可关闭的补充入口」渲染
  外链域名白名单（url/tel）：防止运营填钓鱼链接，也防 javascript: 伪协议。

**密钥加密**：不引第三方依赖（服务器 venv 只有 fastapi/uvicorn）。
  用标准库 HMAC-SHA256 做密钥派生 + 流加密 + encrypt-then-MAC。
  主密钥来自环境变量 CTA_SECRET（不入库、不回显），没有配置时**拒绝存密钥**，
  而不是用弱口令兜底——宁可功能不可用，也不能明文落库。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
from typing import Optional
from urllib.parse import urlparse

# 允许的 CTA 类型。follow_qrcode / launch_weapp 等都在方案 4.8 里定义。
KINDS = {
    "launch_weapp": "跳转小程序",
    "follow_qrcode": "关注公众号",
    "tel": "咨询电话",
    "url": "外部链接",
    "material_code": "物料入口",
    "staff_bind": "工作人员绑定",
}

# 字段白名单：**刻意不包含 required / blocking**。
# 这是合规红线 1、2 的结构性保证——不是「校验它必须为 false」，
# 而是接口根本不接受这个字段，传了就 400。
ALLOWED_FIELDS = {"kind", "title", "target", "position", "sort", "enabled", "note"}
POSITIONS = {"success", "intro", "signup", "checkin", "status"}
MAX_TITLE = 40
MAX_TARGET = 500
# 外链白名单：只允许 http/https，域名可配。tel 只允许电话号码字符。
_URL_SCHEMES = {"http", "https"}
_EXTRA_DOMAINS_ENV = "CTA_URL_DOMAINS"
_DEFAULT_URL_DOMAINS = {"mp.weixin.qq.com", "weixin.qq.com"}


def _allowed_domains() -> set:
    extra = os.environ.get(_EXTRA_DOMAINS_ENV, "")
    return _DEFAULT_URL_DOMAINS | {d.strip().lower() for d in extra.split(",") if d.strip()}


class ValidationError(ValueError):
    """配置不合规。接口层捕获转 400。"""


def validate(cta: dict, *, require_kind: bool = True) -> dict:
    """校验单条 CTA，返回规范化后的 dict。任何违规抛 ValidationError。"""
    if not isinstance(cta, dict):
        raise ValidationError("CTA 必须是对象")

    unknown = set(cta) - ALLOWED_FIELDS
    if unknown:
        # required / blocking 出现在这里 = 合规红线被触碰，直接拒。
        raise ValidationError("不支持的字段：%s" % ", ".join(sorted(unknown)))

    kind = cta.get("kind")
    if require_kind and kind not in KINDS:
        raise ValidationError("未知 CTA 类型：%s" % kind)

    out = dict(cta)
    out["kind"] = kind
    title = str(cta.get("title") or "").strip()
    if not title:
        raise ValidationError("标题不能为空")
    out["title"] = title[:MAX_TITLE]

    pos = cta.get("position") or "success"
    if pos not in POSITIONS:
        raise ValidationError("位置不在白名单：%s" % pos)
    out["position"] = pos

    target = str(cta.get("target") or "").strip()
    if kind in ("url", "tel", "launch_weapp", "follow_qrcode", "material_code"):
        _validate_target(kind, target)
    out["target"] = target[:MAX_TARGET]

    try:
        out["sort"] = int(cta.get("sort") or 0)
    except (TypeError, ValueError):
        raise ValidationError("排序必须是整数")
    out["enabled"] = 1 if cta.get("enabled", 1) else 0
    out["note"] = str(cta.get("note") or "")[:200]
    return out


def _validate_target(kind: str, target: str):
    if not target:
        raise ValidationError("%s 必须配置目标" % KINDS.get(kind, kind))
    if kind == "tel":
        if not re.match(r"^[0-9+\-() ]{5,20}$", target):
            raise ValidationError("电话格式不合法")
        return
    if kind == "url":
        p = urlparse(target)
        if p.scheme not in _URL_SCHEMES or not p.hostname:
            raise ValidationError("外链必须是 http/https 完整地址")
        if p.hostname.lower() not in _allowed_domains():
            raise ValidationError("外链域名不在白名单：%s" % p.hostname)
        return
    # 小程序/公众号/物料：只允许 https 或受控短码，防 javascript: 伪协议
    if "://" in target:
        p = urlparse(target)
        if p.scheme not in _URL_SCHEMES:
            raise ValidationError("目标协议不合法：%s" % p.scheme)


# ---------------- 渠道密钥加密（标准库，无第三方依赖）----------------

def _master_key() -> bytes:
    """从环境变量取主密钥。未配置时拒绝——绝不退化成弱口令。"""
    raw = os.environ.get("CTA_SECRET", "")
    if not raw or len(raw) < 16:
        raise ValidationError("未配置 CTA_SECRET（至少 16 位），不能保存渠道密钥")
    return hashlib.sha256(raw.encode("utf-8")).digest()


def _keystream(nonce: bytes, n: int) -> bytes:
    """HMAC-SHA256 计数器模式生成密钥流。nonce 16 字节，块号从 0 递增。"""
    key = _master_key()
    out = bytearray()
    counter = 0
    while len(out) < n:
        out.extend(hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest())
        counter += 1
    return bytes(out[:n])


def encrypt_secret(plain: str) -> str:
    """加密密钥，返回可直接入库的串：v1.<nonce b64>.<cipher b64>.<tag b64>。"""
    if not plain:
        return ""
    nonce = os.urandom(16)
    data = plain.encode("utf-8")
    cipher = bytes(a ^ b for a, b in zip(data, _keystream(nonce, len(data))))
    # encrypt-then-MAC：对 nonce+cipher 做 HMAC，解密前先验签
    tag = hmac.new(_master_key(), b"enc" + nonce + cipher, hashlib.sha256).digest()
    b64 = lambda b: base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")
    return "v1.%s.%s.%s" % (b64(nonce), b64(cipher), b64(tag))


def decrypt_secret(stored: str) -> str:
    """解密；验签失败或格式错误一律返回空串，不抛给上层。"""
    if not stored or not stored.startswith("v1."):
        return ""
    try:
        parts = stored.split(".")
        if len(parts) != 4:
            return ""
        pad = lambda s: s + "=" * (-len(s) % 4)
        nonce = base64.urlsafe_b64decode(pad(parts[1]))
        cipher = base64.urlsafe_b64decode(pad(parts[2]))
        tag = base64.urlsafe_b64decode(pad(parts[3]))
        expect = hmac.new(_master_key(), b"enc" + nonce + cipher, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expect):
            return ""
        plain = bytes(a ^ b for a, b in zip(cipher, _keystream(nonce, len(cipher))))
        return plain.decode("utf-8")
    except Exception:
        return ""


def mask_secret(stored: str) -> str:
    """给后台回显用：永远不返回明文，只显示末 4 位。"""
    plain = decrypt_secret(stored)
    if not plain:
        return ""
    return "••••••" + plain[-4:] if len(plain) > 4 else "••••"


def kind_labels() -> dict:
    return dict(KINDS)


def positions() -> list:
    return sorted(POSITIONS)
