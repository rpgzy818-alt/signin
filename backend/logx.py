"""结构化日志：单行 KV 写 stderr，由 systemd 收进 journal。

为什么不用第三方日志库：
    本项目单进程、日志只给运维看，多一个依赖就多一处版本对不上的风险
    （本地 fastapi 0.141 与 requirements 0.162 不一致的坑刚踩过）。
    标准库 logging + 一个 Formatter 足够。

输出样例：
    2026-11-17T10:20:31+0800 INFO  reg      register_ok openid=o***yz phone=****8000 ch=推文物料
    2026-11-17T10:20:44+0800 WARN  req       req m=POST p=/api/register s=429 ms=1.2 ip=1.2.3.4

约定：
    · 一行一个事件，`journalctl -u signin | grep register_fail` 直接能捞
    · 只在「有信息量」时打：写操作成功/失败、被拒绝、慢请求、异常。
      读接口（/me、/config、/health）不打，否则后台轮询会把 journal 刷满。
    · 手机号一律掩码、openid 只留首尾。日志不能成为第二份个人信息库。
"""
import logging
import os
import sys
import time

# 触发日志的耗时阈值（毫秒）。低于此值且状态码正常的请求不留痕。
SLOW_MS = float(os.getenv("LOG_SLOW_MS", "800"))

_LOGGER_NAME = "signin"
_configured = False


class KVFormatter(logging.Formatter):
    """把 extra={"kv": {...}} 里的字段展开成 key=value 追加在行尾。"""

    def format(self, record):
        line = (
            f"{self.formatTime(record, '%Y-%m-%dT%H:%M:%S%z')} "
            f"{record.levelname:<5} {record.name:<8} {record.getMessage()}"
        )
        kv = getattr(record, "kv", None)
        if kv:
            line += " " + " ".join(f"{k}={v}" for k, v in kv.items() if v is not None)
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def setup():
    """进程启动时调一次。重复调用无副作用。"""
    global _configured
    if _configured:
        return logging.getLogger(_LOGGER_NAME)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(KVFormatter())
    log = logging.getLogger(_LOGGER_NAME)
    log.handlers = [handler]
    log.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    log.propagate = False
    _configured = True
    return log


def ev(event, level="info", **fields):
    """打一个业务事件。level 取 info / warning / error。"""
    log = logging.getLogger(_LOGGER_NAME)
    if not _configured:
        setup()
    getattr(log, level)(event, extra={"kv": fields})


# ---------------- 脱敏 ----------------
def mask_phone(phone):
    """13800138000 -> ****8000。只留后四位，够定位人、不够还原号。"""
    if not phone:
        return None
    s = str(phone)
    return "****" + s[-4:] if len(s) >= 4 else "****"


def mask_openid(openid):
    """oABC123defGHI -> oAB***GHI。留首尾各 3 位，能对上人又不可复用。"""
    if not openid:
        return None
    s = str(openid)
    if len(s) <= 8:
        return s[:2] + "***"
    return s[:3] + "***" + s[-3:]


# ---------------- 请求上下文 ----------------
def client_ip(request):
    """取真实来源 IP。

    nginx 侧对 /api/ 已设 X-Real-IP=$remote_addr（覆盖式，客户端伪造不了），
    而 uvicorn 未开 --proxy-headers，所以 request.client.host 恒为 127.0.0.1，
    必须读头。XFF 作为兜底，取最后一个（nginx 追加在尾部，前面的可能是客户端自带）。
    """
    ip = request.headers.get("x-real-ip")
    if ip:
        return ip.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else "-"


async def middleware(request, call_next):
    """请求级打点：只记「异常 + 慢」两类，正常快请求不留痕。

    全量 access log 由 uvicorn 自己出（也在 journal 里），这里补的是
    uvicorn 没有的东西：耗时、真实 IP、以及 4xx/5xx 在同一行里的业务上下文。
    """
    t0 = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        ev(
            "req_crash",
            level="error",
            m=request.method,
            p=request.url.path,
            ms=round((time.perf_counter() - t0) * 1000, 1),
            ip=client_ip(request),
        )
        raise
    elapsed = (time.perf_counter() - t0) * 1000
    if response.status_code >= 400 or elapsed >= SLOW_MS:
        ev(
            "req",
            level="warning" if response.status_code >= 400 else "info",
            m=request.method,
            p=request.url.path,
            s=response.status_code,
            ms=round(elapsed, 1),
            ip=client_ip(request),
        )
    return response
