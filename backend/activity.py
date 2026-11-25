"""活动上下文（租户边界）。

一个「活动」= 一个租户。请求进来自第一步就确定它属于哪个活动，之后所有
数据读写都挂这个活动，跨活动互不可见。

识别优先级（**路径是主干，域名是增值项**，按此顺序取，先命中先用）：

1. `X-Activity-Code` 请求头
   前端从页面 URL 路径 `/<平台前缀>/<机构>/<活动>/` 提取活动短码后，附加到每个
   API 请求上。这是主通道——同一份前端产物靠它切换活动。

2. `Host` 匹配域名，**两级**：
   a. `activity.domain` —— 该域名只服务一个活动（如 `jobfair2026.example.com`）
   b. `organization.domain` —— 机构级域名（如 `abc.com`），取该机构下第一个
      已上线活动兜底。机构首页/活动列表要等 P7 才有，这之前机构域名只会落到
      它的主活动上。

3. 都没有 → 默认活动（`code = 'default'`）
   单活动兼容期：老前端不带请求头，全部落到默认活动，行为与平台化之前一致。

**两种增值模式共用这一条链，不需要两套代码**：
   · 全量跳转：机构域名不落到本机，DNS/静态页把用户送到主域路径，走第 1 层
   · 反向代理：机构域名 `proxy_pass` 到同一份产物，Host 带过来，走第 2 层
   差别只在 nginx 与 DNS，代码不分叉。取舍与硬限制见技术决策清单 D7。

**为什么不用路径段做后端标识**：nginx 把 `/platform-staging/api/` 重写到
`/api/`，活动短码在前端页面路径里，到了后端已被抹掉。所以后端只认
请求头和 Host，路径解析在前端做一次就够。

租户解析结果放进 contextvar，数据层（db.insert_row / 查询过滤）直接读，
不用把 activity_id 一路当参数传——传参总有漏掉的地方，contextvar 不会漏。
"""
from __future__ import annotations

import contextvars
import threading
from typing import Optional

import domain as domx        # 只用它算「托管子域」的父域，不碰库，无循环依赖

# 当前请求的活动上下文。中间件负责 set/reset，业务代码只读。
_current: contextvars.ContextVar[Optional["Activity"]] = contextvars.ContextVar(
    "activity_ctx", default=None
)

# 活动短码 → Activity 的进程内缓存。活动数量小、变更低频，
# 每个请求都查库没有必要；后台改动活动时调 invalidate() 清掉。
_cache: dict[str, "Activity"] = {}
_cache_lock = threading.Lock()

# 域名 → 活动短码（活动域名与机构域名共用）。刻意**不缓存查不到**：
# 域名是运营随时可能新配的，缓存「无」会让新配的域名一直不生效直到进程重启，
# 现场表现就是「域名配好了却打不开」，很难判断是配置问题还是代码问题。
_domain_cache: dict[str, str] = {}

DEFAULT_CODE = "default"
HEADER_NAME = "x-activity-code"

# 机构首页（RD-13）相关的只读接口：机构域名可能属于一家**还没有活动**的机构，
# 而机构首页恰恰是这种机构唯一的对外页面。这几条路径在「域名绑了机构但解析不到
# 可用活动」时不返回 404，放行给接口自己处理；其余路径照旧 404——整站放行等于让
# activity_id 落到默认活动，那才是真正的跨租户串数据。
ORG_HOME_PATHS = (
    "/api/config",      # 前端第一跳，据此决定进机构首页还是活动流
    "/api/org/portal",  # 机构首页数据（?org= 显式指定时也走这条）
    "/api/health",      # 健康检查不该因为「机构还没建活动」而报红
)


class Activity:
    """一个活动的只读快照。"""

    __slots__ = ("id", "code", "name", "org_id", "status", "domain", "theme", "intro")

    def __init__(self, id, code, name, org_id=None, status="active", domain=None,
                 theme=None, intro=None):
        self.id = int(id)
        self.code = code
        self.name = name
        self.org_id = org_id
        self.status = status
        self.domain = domain
        self.theme = theme
        self.intro = intro

    def __repr__(self):
        return f"<Activity {self.id} {self.code!r}>"


class ActivityNotFound(Exception):
    """请求指向了一个不存在或已停用的活动。"""


def _row_to_activity(row) -> Activity:
    """兼容 dict-like 行（sqlite3.Row / CompatRow 都支持 r['col']）。"""
    return Activity(
        id=row["id"],
        code=row["code"],
        name=row["name"],
        org_id=row["org_id"],
        status=row["status"] if "status" in _keys(row) else "active",
        domain=row["domain"] if "domain" in _keys(row) else None,
        theme=row["theme"] if "theme" in _keys(row) else None,
        intro=row["intro"] if "intro" in _keys(row) else None,
    )


def _keys(row):
    try:
        return row.keys()
    except AttributeError:
        return []


def load(code: str) -> Optional[Activity]:
    """按短码取活动，带进程内缓存。查不到返回 None。"""
    code = (code or "").strip().lower()
    if not code:
        return None
    with _cache_lock:
        hit = _cache.get(code)
    if hit is not None:
        return hit

    import db  # 延迟导入：db 在 insert_row 里要读本模块的上下文，避免循环导入

    conn = db.get_conn()
    row = conn.execute(
        "SELECT id, code, name, org_id, status, domain, theme, intro"
        " FROM activity WHERE code = ?",
        (code,),
    ).fetchone()
    if row is None:
        return None
    act = _row_to_activity(row)
    with _cache_lock:
        _cache[code] = act
    return act


def _norm_host(host: str) -> str:
    """去掉端口与大小写差异。Host 头可能带 :443，库里的域名不带。"""
    return (host or "").split(":")[0].strip().lower()


def load_by_domain(host: str) -> Optional[Activity]:
    """按 Host 反查**活动级**独立域名（一域名一活动）。"""
    host = _norm_host(host)
    if not host:
        return None
    with _cache_lock:
        code = _domain_cache.get(host)
        if code:
            hit = _cache.get(code)
            if hit is not None:
                return hit

    import db

    conn = db.get_conn()
    # 只认已验证的域名：填进来就生效等于「谁先填别人家域名，谁接走那家访客」，
    # 验证动作在后台由客户自己点（见 domain.points_to_us）。
    row = conn.execute(
        "SELECT code FROM activity WHERE lower(domain) = ? AND domain_verified = 1",
        (host,),
    ).fetchone()
    if row is None:
        return None
    code = row["code"]
    with _cache_lock:
        _domain_cache[host] = code
    return load(code)


def load_org_default(host: str, include_inactive: bool = False):
    """按 Host 反查**机构级**域名，取该机构下第一个活动。

    返回 `(Activity | None, 该域名是否绑定到某个机构)`。
    第二个值必须返回：机构域名确实绑了、但这个机构下一个能访问的活动都没有时，
    该 404 而不是静默回落到默认活动——回落到默认活动等于把 A 机构的访客
    送进 B 机构的活动，是跨租户串数据，比打不开严重得多。

    include_inactive 供后台接口用（运营要能用机构域名打开草稿活动），
    参与者端一律只认 active。
    """
    host = _norm_host(host)
    if not host:
        return None, False

    if not include_inactive:
        with _cache_lock:
            code = _domain_cache.get(host)
            if code:
                hit = _cache.get(code)
                if hit is not None:
                    return hit, True

    import db
    import portal as _portal

    conn = db.get_conn()
    # 先确认这个域名确实是某机构的（哪怕它下面还没有线上活动）。
    # **必须走 portal.find_org**：它同时认「客户自带已验证域名」与「平台托管子域」，
    # 两处各写一遍必然分叉——漏掉派生那条路径的后果不是少个功能，而是这家机构
    # 名下任何不带 header 的请求都认不出机构，静默回落到默认活动（跨租户）。
    org = _portal.find_org(conn, host=host)
    if org is None:
        return None, False


    sql = ("SELECT code FROM activity WHERE org_id = ?"
           + ("" if include_inactive else " AND status = 'active'")
           + " ORDER BY id LIMIT 1")
    row = conn.execute(sql, (org["id"],)).fetchone()
    if row is None:
        return None, True          # 域名绑了机构，但机构下没有可用活动

    code = row["code"]
    if not include_inactive:       # 放宽状态的结果不进缓存，免得把草稿当正式
        with _cache_lock:
            _domain_cache[host] = code
    return load(code), True


def under_org_suffix(host: str) -> bool:
    """Host 是否落在托管子域的父域之下（含保留标签，不含父域本身）。

    与 domain.org_label_of 的区别：那个回答「这是哪家机构」，认不出返回空；
    这个回答「这是不是我们托管子域的地盘」，只要尾巴对上就算。
    两者不可互换——用 org_label_of 判断会漏掉 www / 非法标签这类本该 404 的子域。
    """
    suf = domx.org_suffix()
    if not suf:
        return False
    h = _norm_host(host)
    return bool(h) and h.endswith("." + suf)


def resolve(header_value: Optional[str], host: Optional[str],
            allow_inactive: bool = False) -> Activity:
    """按优先级解析请求所属活动。什么都没带则回落到默认活动。

    **只拦 archived**（活动已结束，链接不该再用）。draft 放行：草稿态是运营的
    配置与测试期，一律 404 就没法测——报名、签到、导出都得在发布前验一遍。
    草稿的风险用前端「预览模式」角标提示，数据在发布时整体归档
    （见 admin_activity_publish），不进正式统计。

    allow_inactive=True 供后台接口用：归档后仍要能查历史数据。
    """
    act = None
    if header_value:
        act = load(header_value)
        if act is None:
            raise ActivityNotFound(f"活动不存在: {header_value!r}")
    elif host:
        act = load_by_domain(host)
        if act is None:
            act, org_hit = load_org_default(host, include_inactive=allow_inactive)
            if org_hit and act is None:
                # 域名绑了机构，但该机构下一个能访问的活动都没有。
                # 这里必须 404：回落默认活动会把这家机构的访客送进别家活动。
                raise ActivityNotFound("该域名已绑定机构，但该机构下暂无可用活动")
            if act is None and under_org_suffix(host):
                # 请求落在托管子域下，但这家机构不存在、已停用，或标签是保留词。
                # 托管子域靠泛解析接住所有 *.<父域>，任何乱写的子域都会到我们这儿；
                # 这里一旦回落默认活动，等于「随便一个子域都能看到默认活动」——
                # 比打不开严重，和上一条同性质。
                raise ActivityNotFound("该站点不存在")

    if act is None:
        act = load(DEFAULT_CODE)
    if act is None:
        # 默认活动还没播种（首次启动的极短窗口），退化成 id=1 的隐式活动，
        # 保证任何情况下都有租户边界，不会写出 activity_id=NULL 的孤儿数据。
        return Activity(id=1, code=DEFAULT_CODE, name="默认活动")

    if act.status == "archived" and not allow_inactive:
        raise ActivityNotFound(
            f"活动已结束: {act.code}"
        )
    return act


def invalidate(code: Optional[str] = None):
    """活动信息变更后清缓存。传 None 清全部。

    域名缓存必须一起清：改了 `activity.domain` 或 `organization.domain` 之后，
    只清活动缓存的话，旧域名继续指向旧活动、新域名不生效。
    """
    with _cache_lock:
        if code is None:
            _cache.clear()
            _domain_cache.clear()
        else:
            key = (code or "").strip().lower()
            _cache.pop(key, None)
            for host in [h for h, c in _domain_cache.items() if c == key]:
                _domain_cache.pop(host, None)


# ---- contextvar 读写 ----

def set_current(act: Optional[Activity]):
    return _current.set(act)


def reset(token):
    _current.reset(token)


def current() -> Optional[Activity]:
    return _current.get()


def current_id() -> int:
    """当前活动 id。没有上下文时返回默认活动 id=1，绝不返回 None——
    写库时 activity_id 为 NULL 就是孤儿数据，宁可错归到默认活动。"""
    act = _current.get()
    return act.id if act is not None else 1


def current_code() -> str:
    act = _current.get()
    return act.code if act is not None else DEFAULT_CODE


# ---- ASGI 中间件 ----

class ActivityMiddleware:
    """每个 HTTP 请求解析一次活动，塞进 contextvar，请求结束复位。

    刻意用纯 ASGI 而不是 BaseHTTPMiddleware：后者基于 anyio task group，
    contextvar 在部分路径上不会传到下游路由，租户上下文会静默退化成默认活动
    ——那种失效没有任何报错，只会表现为"数据莫名落到默认活动"，极难排查。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        raw = {k.decode("latin-1").lower(): v for k, v in scope.get("headers") or []}
        code = raw.get(HEADER_NAME, b"").decode("utf-8", "replace").strip() or None
        host = raw.get("host", b"").decode("latin-1").strip() or None

        try:
            # 后台接口要能配置草稿活动、查归档数据；参与者端一律只认 active。
            # 这里只放宽活动状态，账号权限由各后台接口的 require_* 负责。
            path = scope.get("path", "")
            admin_api = path.startswith("/api/admin/")
            # /config 与 /health 也放行：前端要能区分「活动还没发布」和「活动不存在」，
            # 否则草稿态只能给访客一个 404。这两个接口只回开关与状态，不含任何业务数据。
            public_probe = path in ("/api/config", "/api/health")
            act = resolve(code, host, allow_inactive=admin_api or public_probe)
        except ActivityNotFound as exc:
            # 机构域名 + 该机构暂无可用活动：只有机构首页那几条只读路径放行。
            # 判定放在这里而不是 resolve 里，是因为 resolve 的语义是「这个请求
            # 属于哪个活动」——它答不上来就该报错；能不能放行是这个路径的性质。
            if path in ORG_HOME_PATHS and not code:
                import db as _db
                try:
                    import portal as _portal
                    org = _portal.find_org(_db.get_conn(), host=host)
                except Exception:
                    org = None
                if org is not None:
                    # current 置空等于「本次请求没有活动上下文」。这几条接口都不写库，
                    # 也不碰活动级数据；真要用 current_id 时会拿到默认活动 id=1，
                    # 所以上面那份白名单必须保持极小，不能顺手往里加业务接口。
                    token = set_current(None)
                    try:
                        await self.app(scope, receive, send)
                    finally:
                        reset(token)
                    return
            body = ('{"detail":%s}' % _json_str(str(exc))).encode()
            await send({
                "type": "http.response.start",
                "status": 404,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                ],
            })
            await send({"type": "http.response.body", "body": body})
            return

        token = set_current(act)
        try:
            await self.app(scope, receive, send)
        finally:
            reset(token)


def _json_str(s: str) -> str:
    import json
    return json.dumps(s, ensure_ascii=False)
