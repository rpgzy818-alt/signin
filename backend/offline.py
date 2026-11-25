"""离线核销签名（P8-b）：短时签名凭证 + 补传验签。

**为什么需要签名而不是直接传 registration_id**：
  现场工作人员断网时把「核销意图」存在手机本地，联网后补传。
  若直接传 registration_id，任何人都能伪造一个 id 来核销别人。
  签名凭证由后端在**联网时**签发，证明「这个工作人员在有效时间内查过这个人」。

**凭证格式**（不透明串，前端只看作字符串）：
  base64url(activity_id.registration_id.expires_ts.signature)
  signature = HMAC-SHA256(secret, "活动|报名|到期|工作人员token哈希")

**安全约束**：
  · 短时有效（默认 30 分钟）——杜绝明天拿今天的凭证补传
  · 绑定 staff token 哈希——A 工作人员签发的凭证 B 不能用
  · 一凭证一核销——补传去重靠 registration_id 唯一索引（P8-a 已建）

**密钥**：复用 `QUERY_SECRET`？不——那是自助查询哈希专用。
  用 `OFFLINE_SECRET` 环境变量；未配时从 CTA_SECRET 或 DB_ENV 派生，
  但会记 warning 日志提醒生产要配。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time
from typing import Optional, Tuple

import config
import logx

DEFAULT_TTL = 1800          # 30 分钟
MAX_TTL = 7200              # 签发时不允许超过 2 小时


class BadToken(ValueError):
    """签名无效 / 过期 / 篡改。"""


def _secret() -> bytes:
    raw = os.environ.get("OFFLINE_SECRET") or os.environ.get("CTA_SECRET") or config.DB_ENV
    if not os.environ.get("OFFLINE_SECRET"):
        logx.ev("offline_secret_fallback", level="warning",
                msg="OFFLINE_SECRET 未配，用派生密钥；生产建议单独配置")
    return raw.encode("utf-8")


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(aid: int, rid: int, exp: int, staff_hash: str) -> str:
    msg = "%s|%s|%s|%s" % (aid, rid, exp, staff_hash)
    return hmac.new(_secret(), msg.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def staff_hash(token: str) -> str:
    """工作人员凭据只以哈希进签名，签名串里不出现明文 token。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


def issue(aid: int, registration_id: int, staff_token: str, ttl: int = DEFAULT_TTL) -> str:
    ttl = max(60, min(int(ttl), MAX_TTL))
    exp = int(time.time()) + ttl
    sig = _sign(aid, registration_id, exp, staff_hash(staff_token))
    payload = "%s.%s.%s.%s" % (aid, registration_id, exp, sig)
    return _b64(payload.encode("ascii"))


def verify(token_str: str, staff_token: str, aid: int) -> Tuple[int, int]:
    """验签并返回 (registration_id, expires_ts)；任何异常抛 BadToken。"""
    try:
        payload = _unb64(token_str).decode("ascii")
        parts = payload.split(".")
        if len(parts) != 4:
            raise BadToken("格式错误")
        a, r, e, sig = parts
        if int(a) != aid:
            raise BadToken("活动不匹配")
        exp = int(e)
        if exp < int(time.time()):
            raise BadToken("凭证已过期")
        expect = _sign(int(a), int(r), exp, staff_hash(staff_token))
        if not hmac.compare_digest(sig, expect):
            raise BadToken("签名无效")
        return int(r), exp
    except BadToken:
        raise
    except Exception:
        raise BadToken("凭证无效")
