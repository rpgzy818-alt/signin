"""
账号口令与会话凭据（不依赖 db，避免循环引用）。
- 口令：PBKDF2-HMAC-SHA256，120k 轮，随机盐，存 "pbkdf2_sha256$轮数$盐$摘要"
- 会话：随机 token 交给前端，库里只存 SHA-256 摘要（库泄露也拿不到可用凭据）
"""
import hashlib
import hmac
import secrets

_ALGO = "pbkdf2_sha256"
_ITER = 120_000
PASSWORD_MIN = 8


def hash_password(pw: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt.encode("utf-8"), _ITER)
    return "%s$%d$%s$%s" % (_ALGO, _ITER, salt, dk.hex())


def verify_password(pw: str, stored: str) -> bool:
    try:
        algo, it, salt, digest = (stored or "").split("$")
        if algo != _ALGO:
            return False
        dk = hashlib.pbkdf2_hmac("sha256", (pw or "").encode("utf-8"),
                                 salt.encode("utf-8"), int(it))
        return hmac.compare_digest(dk.hex(), digest)
    except (ValueError, TypeError):
        return False


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()
