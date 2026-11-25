"""轻量限流：进程内滑动窗口，零依赖。

为什么不用 slowapi / redis：
    单进程 uvicorn、单机部署，只需挡住「脚本刷」和「口令爆破」。
    引 redis 要多一个服务和一份运维成本，引 slowapi 要在几十个路由上加装饰器。

两层设计（关键，别简化成一层）：
    ① 中间件按 IP —— 只挡「极高频」。阈值必须放得很宽（默认 600 次/分钟/IP）。
       原因：活动当天现场几百人连同一个 WiFi，出口 IP 相同，按 IP 收紧会误杀
       正常签到的人。所以 IP 层只负责挡明显的机器流量。
    ② 业务按 openid —— 才是精确限流。同一个人反复提交才拦，与他人无关。
       由路由在处理到 openid 后显式调用 guard()。

已知限制（写清楚，避免以后误判）：
    · 计数在本进程内存里。若将来改多 worker，实际额度 = 阈值 × worker 数。
    · 重启即清零。对防刷场景可接受（重启本身极少，且不影响正常用户）。
"""
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException

from logx import client_ip, ev

# ---- IP 层阈值（次 / 窗口秒）----
IP_GLOBAL = (600, 60)          # 全站兜底：正常用户远远够，机器刷必撞
IP_RULES = {
    # 登录：2 次/分钟的量，人力输错也很难连撞 10 次
    "/api/admin/login": (10, 300),
    # 自助注册：全站唯一无需登录就能写库的入口。5 次/小时够正常用户试错，
    # 机器刷注册必撞。业务层还有「同 IP 24h 3 个机构」兜第二层。
    "/api/console/signup": (5, 3600),
    # 埋点：单页多切几次就会打，给宽一点
    "/api/track": (120, 60),
}
# 不参与 IP 限流：健康检查会被守护脚本每分钟打，鉴权接口本身有 token
IP_EXEMPT_PREFIX = ("/api/health", "/docs", "/openapi.json")


class _Window:
    """一个 key 一条时间戳队列。加锁粒度是全局，但临界区只有 deque 操作。"""

    def __init__(self):
        self._d = defaultdict(deque)
        self._lock = threading.Lock()
        self._hits = 0

    def hit(self, key, limit, window):
        """返回 (是否放行, 建议等待秒数)。"""
        now = time.monotonic()
        cutoff = now - window
        with self._lock:
            dq = self._d[key]
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= limit:
                retry = int(window - (now - dq[0])) + 1
                return False, retry
            dq.append(now)
            self._hits += 1
            # 惰性清理：每 5000 次请求扫一遍，把整条队列都过期的 key 删掉，
            # 防止「一次性访客」把字典越撑越大（活动当天会有大量新 IP）
            if self._hits % 5000 == 0:
                self._sweep(now)
            return True, 0

    def _sweep(self, now):
        dead = [k for k, dq in self._d.items() if not dq or dq[-1] < now - 600]
        for k in dead:
            self._d.pop(k, None)

    def reset(self):
        with self._lock:
            self._d.clear()


_win = _Window()


def reset():
    """清空全部计数。测试环境一键清数时一并调用。"""
    _win.reset()


def guard(scope, key, limit, window=60):
    """业务层限流。超限直接抛 429，调用方不用写分支。

    scope 用来隔离命名空间（如 "reg" / "checkin"），避免不同接口的 key 撞车。
    """
    if not key:
        return
    ok, retry = _win.hit(f"{scope}:{key}", limit, window)
    if not ok:
        ev("rate_limited", level="warning", scope=scope, key=str(key)[:12],
           limit=limit, window=window, retry=retry)
        raise HTTPException(
            429, "操作过于频繁，请稍后再试", headers={"Retry-After": str(retry)}
        )


async def middleware(request, call_next):
    """IP 层兜底。挂在 CORS 内、日志中间件外。"""
    path = request.url.path
    if path.startswith(IP_EXEMPT_PREFIX):
        return await call_next(request)

    ip = client_ip(request)
    rule = IP_RULES.get(path, IP_GLOBAL)
    # 不同规则必须用不同桶：共用 ip 作 key 会让全站兜底额度吃掉登录的额度，
    # 表现为「前面正常点了几下，一进登录就 429」。
    bucket = path if path in IP_RULES else "*"
    ok, retry = _win.hit(f"ip:{bucket}:{ip}", rule[0], rule[1])
    if not ok:
        ev("ip_blocked", level="warning", ip=ip, p=path, limit=rule[0], retry=retry)
        from fastapi.responses import JSONResponse

        return JSONResponse(
            {"detail": "请求过于频繁，请稍后再试"},
            status_code=429,
            headers={"Retry-After": str(retry)},
        )
    return await call_next(request)
