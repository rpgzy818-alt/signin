"""
meeting-platform 后端配置（自 meeting-h5 v151 复制，环境标识已换）
从环境变量读取，并可选加载同目录 .env（简单 KEY=VALUE 解析，避免额外依赖）。
"""
import datetime as _dt
import os
import re

_DOTENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")


def _load_dotenv(path=_DOTENV_PATH):
    """极简 .env 解析：忽略空行与 # 注释，支持 KEY=VALUE。"""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
            if not m:
                continue
            key, val = m.group(1), m.group(2)
            # 去掉可选的引号
            if len(val) >= 2 and val[0] in ("'", '"') and val[-1] == val[0]:
                val = val[1:-1]
            os.environ.setdefault(key, val)


_load_dotenv()


def _get(name, default=None):
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v


def _as_bool(v, default=False):
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


# ---- 环境与数据库 ----
# DB_ENV：本模块环境标识，写入每一行 env 列；启动时校验与库文件名一致（fail-fast）。
# 自部署通常只有一套环境，默认 prod 即可；若你另起一套测试环境，把它设成 staging
# 并让库文件名带上同样字样，能防住「拿测试库跑正式站」这种事故。
DB_ENV = _get("DB_ENV", "prod")

# 演示机构 id：seed_demo 播种与权限解析共用。可用 DEMO_ORG_ID 覆盖，
# 换环境（比如另开一套演示库）不用改代码。
DEMO_ORG_ID = int(_get("DEMO_ORG_ID", "9001") or 9001)

# 主站域名：部署时用环境变量注入自己的域名（如 meeting.example.com）。
# 开源版不预置任何域名，留空即按请求 Host 处理，不影响本地与自建部署。
SITE_HOST = _get("SITE_HOST", "").strip().lower().strip(".")

# 机构托管子域父域：开源版只服务单机构，默认留空即可。
# 若你的部署确实要按子域区分，再填 `<短码>.<父域>` 中的父域部分。
ORG_DOMAIN_SUFFIX = _get("ORG_DOMAIN_SUFFIX", "").strip().lower().strip(".")

# 时间闸门配置
# 签到只在窗口内开放。默认「今天 09:00–18:00」，让第一次部署的人当天就能测通；
# 正式使用时在 .env 里按活动时间改，或在后台「时段设置」里改（后台优先）。
CHECKIN_SWITCH = _as_bool(_get("CHECKIN_SWITCH", "false"), False)
_TODAY = _dt.date.today().isoformat()
WINDOW_START = _get("WINDOW_START", f"{_TODAY} 09:00:00+08:00")
WINDOW_END = _get("WINDOW_END", f"{_TODAY} 18:00:00+08:00")

# 开卡回传共享密钥（备用通道）：小程序侧本期不配合，默认不启用；
# 配置了才允许 /card/claim 写入，未配置时该接口直接 503。
CARD_CLAIM_SECRET = _get("CARD_CLAIM_SECRET", "")

# 后台登录会话时长（分钟）：默认 30，按访问滑动续期；刷新页面不必重登
SESSION_MINUTES = int(_get("SESSION_MINUTES", "30"))

# 管理/核销凭据
ADMIN_TOKEN = _get("ADMIN_TOKEN", "change-me-admin")
# staff 预置在 db.py 中写入；此处仅读取是否校验 token
STAFF_TOKENS = [t for t in _get("STAFF_TOKENS", "change-me-staff").split(",") if t]

CORS_ORIGINS = [o for o in _get("CORS_ORIGINS", "*").split(",") if o]

# 本地 SQLite 路径：默认放在项目 data 目录
DEFAULT_DB = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "data",
    f"signin_{DB_ENV}.db",
)
DB_PATH = _get("DB_PATH", os.path.abspath(DEFAULT_DB))

# ---- 数据库后端切换（P1）----
# DB_BACKEND: sqlite（默认，行为与历史完全一致）/ postgres
# PG_DSN: postgres 模式必填，形如 postgresql://user:pass@host:5432/dbname
# 切库不动业务 SQL：方言差异由 pgcompat 在连接边界转换。
DB_BACKEND = _get("DB_BACKEND", "sqlite").lower()
PG_DSN = _get("PG_DSN", "")

# ---- 静态资源与上传 ----
# 背景音乐要落到前端能直接访问的目录，后端才知道往哪写。
# 默认 /var/www/signin（Docker 部署时由环境变量 WEB_ROOT 指向挂载卷），可用 WEB_ROOT / AUDIO_DIR 覆盖。
WEB_ROOT = _get("WEB_ROOT", "/var/www/signin")
AUDIO_DIR = _get("AUDIO_DIR", os.path.join(WEB_ROOT, "audio"))
BGM_URL_PREFIX = "/audio"          # 前端引用的相对路径前缀（站点根下）
BGM_MAX_BYTES = int(_get("BGM_MAX_BYTES", str(5 * 1024 * 1024)))   # 5MB 上限

# 报名附件上传（RD-04）：图片≤2、文档≤1，单文件≤5M。
# 目录在站点根下，nginx 已服务静态文件；注意 deploy.sh 必须排除它，
# 否则 rsync --delete 会把参与者传的文件全清掉。
UPLOAD_DIR = _get("UPLOAD_DIR", os.path.join(WEB_ROOT, "uploads"))
UPLOAD_URL_PREFIX = "/uploads"
UPLOAD_MAX_BYTES = int(_get("UPLOAD_MAX_BYTES", str(5 * 1024 * 1024)))
UPLOAD_MAX_IMAGES = 2
UPLOAD_MAX_DOCS = 1
# 魔数白名单：不靠扩展名（可伪造），按文件头判。PDF / PNG / JPEG / GIF / DOC / DOCX / XLS / XLSX
UPLOAD_SIGS = {
    "pdf": (b"%PDF-",),
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpeg": (b"\xff\xd8\xff",),
    "gif": (b"GIF87a", b"GIF89a"),
    "doc": (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",),   # OLE2，doc/xls 共用
    "docx": (b"PK\x03\x04",),                          # ZIP，docx/xlsx 共用
}


# ---- 短信认证服务（阿里云 PNVS）----
# 凭据留空即影子模式：发送/校验走本地模拟，不产生真实扣费与外呼。
# 拿到 AccessKey 后填入即可切真实通道，业务代码一行不改。
# 注意：阿里云短信认证服务的验证码校验是托管的（SendSmsVerifyCode +
# CheckSmsVerifyCode），平台只管调用与按条扣减余额，不自建验证码表。
SMS_ENABLED = _as_bool(_get("SMS_ENABLED", "false"), False)
SMS_ACCESS_KEY_ID = _get("SMS_ACCESS_KEY_ID", "")
SMS_ACCESS_KEY_SECRET = _get("SMS_ACCESS_KEY_SECRET", "")
SMS_REGION = _get("SMS_REGION", "cn-hangzhou")
SMS_SIGN_NAME = _get("SMS_SIGN_NAME", "")       # 仅真实通道需要
SMS_TTL_SECONDS = int(_get("SMS_TTL_SECONDS", "300"))

# ---- 微信支付 ----
# 凭据留空即影子模式：下单返回模拟 prepay 参数，回调可手工触发对账，不入真实资金。
PAY_ENABLED = _as_bool(_get("PAY_ENABLED", "false"), False)
WXPAY_APPID = _get("WXPAY_APPID", "")
WXPAY_MCHID = _get("WXPAY_MCHID", "")
WXPAY_API_V3_KEY = _get("WXPAY_API_V3_KEY", "")
WXPAY_SERIAL_NO = _get("WXPAY_SERIAL_NO", "")
WXPAY_PRIVATE_KEY_PATH = _get("WXPAY_PRIVATE_KEY_PATH", "")
WXPAY_NOTIFY_URL = _get("WXPAY_NOTIFY_URL", "")


def validate():
    """启动校验：env 必填、库文件名须含 env（防串库）、凭据不得为弱口令。"""
    if DB_ENV not in ("prod", "staging"):
        raise RuntimeError(f"DB_ENV 必须为 prod 或 staging，当前为: {DB_ENV!r}")
    if DB_BACKEND not in ("sqlite", "postgres"):
        raise RuntimeError(f"DB_BACKEND 必须为 sqlite 或 postgres，当前为: {DB_BACKEND!r}")
    if DB_BACKEND == "postgres":
        if not PG_DSN:
            raise RuntimeError("DB_BACKEND=postgres 时必须配置 PG_DSN")
        # 防串库：DSN 里的库名必须含环境标识（与 SQLite 的老校验同口径）
        dbname = PG_DSN.rstrip("/").rsplit("/", 1)[-1].split("?")[0]
        if DB_ENV not in dbname:
            raise RuntimeError(
                f"PG_DSN 库名 {dbname!r} 不含环境标识 {DB_ENV!r}，禁止启动（防串库）"
            )
    else:
        base = os.path.basename(DB_PATH)
        if DB_ENV not in base:
            raise RuntimeError(
                f"数据库文件名 {base!r} 不含环境标识 {DB_ENV!r}，禁止启动（防串库）"
            )
    # 弱口令拦截：与 DB_ENV 同一套 fail-fast 思路，避免拿默认口令上生产
    if _as_bool(_get("ALLOW_WEAK_TOKEN", "false"), False):
        return True
    weak = {"change-me-admin", "change-me-staff"}
    if ADMIN_TOKEN in weak or len(ADMIN_TOKEN) < 12:
        raise RuntimeError("ADMIN_TOKEN 为默认值或长度不足 12 位，禁止启动（可用 ALLOW_WEAK_TOKEN=1 临时放行）")
    for t in STAFF_TOKENS:
        if t in weak or len(t) < 12:
            raise RuntimeError("STAFF_TOKENS 含默认值或长度不足 12 位，禁止启动（可用 ALLOW_WEAK_TOKEN=1 临时放行）")
    # 开卡回传通道本期为备用：不配 CARD_CLAIM_SECRET 即视为未启用，不再拦启动
    return True

# 超级管理员账号：仅本人可修改自己的密码；其他管理员不可变更其角色/权限/启停，也不可删除
SUPER_ADMIN_USERNAME = _get("SUPER_ADMIN_USERNAME", "admin")
