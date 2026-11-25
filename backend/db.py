"""
meeting-h5 数据库层
- SQLite(WAL)
- 表：registration / checkin / staff / events（＋ export_log / gate_config /
  card_claim / card_action / admin_log）
- 时区：一律 Asia/Shanghai 显式生成 ISO 串，禁用 SQLite datetime('now')
- env 列：每一行 INSERT 必须显式写入 DB_ENV（应用层负责，漏写 fail-fast）
- is_smoke：INTEGER NOT NULL DEFAULT 0，仅 T0 会话或人工处置显式置 1，绝不按窗口自动打标
"""
import sqlite3
import threading
import secrets
import zoneinfo
from contextlib import contextmanager
from datetime import datetime

from config import DB_ENV, DB_PATH, STAFF_TOKENS, PG_DSN
from pgcompat import ConnProxy, DB_BACKEND, connect_postgres, ddl_for_backend, insert_and_get_id

TZ = zoneinfo.ZoneInfo("Asia/Shanghai")

# 通用活动的字段选项：只保留跟行业无关的通用维度。
# 学历/专业/海外经历/意向岗位等招聘专场常量已随招聘固定列一并删除（2026-11-21）。
# 来源四类可追溯：
#   物料扫码 —— 海报/桌牌上的报名码，URL 带 from=material
#   活动链接 —— 裸链接直接进来（推文正文、群里发的链接等），无 from 参数
#   分享链接 —— 微信分享 SDK 自动带 from=share
#   现场补录 —— 后端 walkin 直接写入，不经过前端报名
# 前两个旧值保留：历史数据仍要能显示，后台编辑旧记录也不能因为取值不合法而报错。
CHANNEL_OPTIONS = ["物料扫码", "活动链接", "分享链接", "现场补录",
                   "推文物料", "直达(其他)"]
CHECKIN_METHODS = ["self", "verify", "walkin", "manual"]   # manual：后台按手机号手工签到（现场 H5 兜底）
# 性别：选填，只收这两项；空值统一按「未填」统计，不做第三种选项
GENDER_OPTIONS = ["男", "女"]

SCHEMA = """
-- ============ 平台层：机构 / 活动 / 能力开关 ============
-- 租户边界 = 活动（activity）。注意与下面的 events 表区分：
--   activity = 一场需要被承接的活动（招聘会、宣讲会…），是租户
--   events   = 前端埋点流水，一行一次行为上报
-- 两者只差一个 s，读写时务必看清，混用会串数据。

CREATE TABLE IF NOT EXISTS organization (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',   -- active / disabled
    -- 机构级独立域名（增值项，可空）。与 activity.domain 是两个层级：
    --   机构域名 abc.com          → 机构入口（机构首页 / 该机构默认活动）
    --   活动域名 job.abc.com      → 单个活动
    -- 解析顺序见 activity.resolve()：活动域名优先，机构域名兜底。
    -- 域名必须**验证通过**才参与解析（domain_verified=1）：填进来就生效等于
    -- 「谁先把别人家的域名填进自己机构，谁就把那家的访客接走了」。
    domain      TEXT,
    domain_verified     INTEGER NOT NULL DEFAULT 0,
    domain_verified_at  TEXT,
    note        TEXT,
    -- 机构化（A 批）：版本与配额。全部可空/带默认，老库补列后存量行无需回填即能用。
    -- plan：trial / basic / plus；source：manual（超管开）/ self（自助注册）
    plan        TEXT NOT NULL DEFAULT 'trial',
    expires_at  TEXT,                             -- 到期时间 ISO；空＝不做时效约束
    activity_quota INTEGER NOT NULL DEFAULT 1,    -- 可建活动数（含启用中的）
    source      TEXT NOT NULL DEFAULT 'manual',
    frozen_at   TEXT,                             -- 到期冻结起点；解冻时用于顺延短信包有效期
    purged_at   TEXT,                             -- 上次清理时刻，留痕
    -- 机构信息（C 批）：履约联系人。账号与它分开——换人不等于换签约主体，
    -- 联系人写在机构上，平台续费/到期提醒才有稳定的收件人。
    contact_name  TEXT,
    contact_phone TEXT,
    -- 自助注册（D 批）：同意服务条款的时刻。合规留痕，注册接口必写
    agreed_at   TEXT,
    created_at  TEXT NOT NULL
);

-- 活动：code 进 URL 路径 /e/<code>/，一经使用不可改（改了就断旧链接）
CREATE TABLE IF NOT EXISTS activity (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id      INTEGER NOT NULL DEFAULT 1,
    code        TEXT NOT NULL UNIQUE,             -- URL 短码，小写字母数字与 - _
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',   -- draft / active / archived
    domain      TEXT,                             -- 独立域名（增值项，可空）
    domain_verified     INTEGER NOT NULL DEFAULT 0,   -- 见 organization.domain 注释
    domain_verified_at  TEXT,
    theme       TEXT,                             -- 主题标识，P7 用
    intro       TEXT,                             -- 活动级文案覆盖，P7 用
    start_at    TEXT,
    end_at      TEXT,
    -- 进入草稿的时刻（P3-c）。发布时以它划界：只把此刻之后产生的数据当作
    -- 本轮测试数据标记掉，更早的真实报名一条都不碰。
    draft_at    TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_org ON activity(org_id);

-- P5 CTA 配置中心：活动级按钮配置 + 渠道密钥。
-- 两表都带 activity_id，进 _ACTIVITY_SCOPED_TABLES 与 _RLS_TABLES，
-- 跨机构隔离由 RLS 兜底，不靠应用层逐条写 WHERE。
CREATE TABLE IF NOT EXISTS activity_cta (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    cta_key     TEXT NOT NULL,                    -- 稳定标识，按活动唯一
    kind        TEXT NOT NULL,                    -- launch_weapp/follow_qrcode/tel/url/...
    title       TEXT NOT NULL,
    target      TEXT,                             -- 链接/电话/小程序路径，按 kind 校验
    position    TEXT NOT NULL DEFAULT 'success',  -- 渲染位置白名单
    sort        INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    note        TEXT,
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT,
    UNIQUE (activity_id, cta_key)
);

-- 微信渠道密钥：secret 密文入库（cta.encrypt_secret），回显只给末 4 位。
-- 一行一活动，字段用 JSON 存各渠道，避免为每种 appid 建一列。
CREATE TABLE IF NOT EXISTS activity_channel (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    channel     TEXT NOT NULL DEFAULT 'wechat',   -- wechat / weapp，预留多渠道
    config      TEXT NOT NULL DEFAULT '{}',       -- JSON：appid 明文 + secret 密文
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT,
    UNIQUE (activity_id, channel)
);

-- 能力字典：平台提供哪些可开关的能力，basic 为基线（默认开），value 为增值
CREATE TABLE IF NOT EXISTS feature (
    key         TEXT PRIMARY KEY,                 -- basic_exhibition / value_seat …
    name        TEXT NOT NULL,
    tier        TEXT NOT NULL DEFAULT 'basic',    -- basic / value
    description TEXT
);

-- 机构买了哪些能力
CREATE TABLE IF NOT EXISTS org_entitlement (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id      INTEGER NOT NULL,
    feature_key TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    UNIQUE (org_id, feature_key)
);

-- 活动级覆盖：机构有该能力，但这一场可以单独关掉（或缺省跟随机构）
CREATE TABLE IF NOT EXISTS activity_feature (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    feature_key TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    UNIQUE (activity_id, feature_key)
);

-- 活动成员授权（权限快照）。
-- **不运行时继承**：授权那一刻把角色与能力位写死进这一行，之后改账号的全局
-- 属性不会影响已经在进行的活动——正在核对的现场被突然收权是真实事故。
-- 一个账号可以在多个活动各有一行、角色不同（运营常同时管几场）。
CREATE TABLE IF NOT EXISTS activity_member (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    account_id  INTEGER NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member',  -- admin / member
    caps        TEXT NOT NULL DEFAULT '{}',      -- JSON：能力位快照
    status      TEXT NOT NULL DEFAULT 'active',  -- active / disabled；归档时批量置 disabled
    granted_by  INTEGER,                         -- 授权人 account_id
    granted_at  TEXT NOT NULL,
    note        TEXT,
    UNIQUE (activity_id, account_id)
);

-- 表单 schema：活动级、按版本冻结。
-- 一个活动同时只有一个 published 版本在生效（下面那条部分唯一索引保证）；
-- 改字段＝发新版本，老报名留着旧版本号，历史数据永远解释得通。
CREATE TABLE IF NOT EXISTS form_schema (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    version     INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft',   -- draft / published / archived
    fields      TEXT NOT NULL,                   -- JSON 数组，字段定义（见 backend/form.py）
    note        TEXT,                            -- 这一版改了什么
    created_by  INTEGER,
    created_at  TEXT NOT NULL,
    UNIQUE (activity_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_schema_published
    ON form_schema(activity_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS registration (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id     INTEGER NOT NULL DEFAULT 1,   -- 租户边界
    openid          TEXT,    name            TEXT NOT NULL,
    phone_code      TEXT NOT NULL DEFAULT '86',   -- 国际区号纯数字，如 86 / 1 / 852
    phone           TEXT NOT NULL,
    gender          TEXT,              -- 男 / 女；选填，空表示未填（通用字段，保留）
    channel         TEXT NOT NULL DEFAULT '推文物料',
    privacy         INTEGER NOT NULL DEFAULT 1,
    credential_code TEXT UNIQUE,
    source_code     TEXT,              -- 投放物料短码（首次触点），无 m 参数为空
    env             TEXT NOT NULL,
    is_smoke        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    -- 关闭＝软删除：前端当新用户，可重新报名；后台保留原始记录用于核对
    status          TEXT NOT NULL DEFAULT 'active',   -- active / closed
    closed_at       TEXT,
    closed_by       TEXT,
    -- P3 动态表单：除 name/phone/gender 三个通用字段走固定列外，其余全部进 answers JSON。
    -- 通用活动不该预设学历/岗位这类行业字段——办什么会填什么，由活动自己的 schema 决定。
    -- 固定列保留 name/phone 是因为：phone 要唯一索引与查重、name 要脱敏与呼叫凭证。
    answers         TEXT,
    schema_version  INTEGER NOT NULL DEFAULT 1        -- 该报名填写时用的 schema 版本
);

CREATE TABLE IF NOT EXISTS checkin (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id     INTEGER NOT NULL DEFAULT 1,
    openid          TEXT,
    registration_id INTEGER,
    method          TEXT NOT NULL,
    channel         TEXT,
    name            TEXT,
    phone           TEXT,
    staff_id        INTEGER,
    checked_at      TEXT,
    env             TEXT NOT NULL,
    is_smoke        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    username    TEXT NOT NULL UNIQUE,
    token       TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    openid      TEXT,                  -- 绑定后可辅助签到的微信（白名单）
    account_id  INTEGER,               -- 关联的后台账号
    created_at  TEXT,
    deleted_at  TEXT                   -- 软删除：停用后可删，但行要留着——历史核销流水要靠它显示操作人
);

-- 工作人员微信绑定：后台生成一次性票据并出二维码，工作人员扫码回传自己的 openid
CREATE TABLE IF NOT EXISTS staff_bind_ticket (
    nonce       TEXT PRIMARY KEY,
    staff_id    INTEGER NOT NULL,
    expires_at  TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,   -- 埋点流水也按活动隔离，统计要分活动
    openid  TEXT,
    event   TEXT NOT NULL,
    page    TEXT,
    ts      TEXT NOT NULL,
    env     TEXT NOT NULL,
    payload TEXT,
    code    TEXT,              -- 投放物料短码（取自 URL 的 m 参数）
    did     TEXT               -- 设备指纹：按码统计「扫码人数」要去重设备
);

CREATE TABLE IF NOT EXISTS export_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    operator    TEXT,
    row_count   INTEGER,
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- 闸门与报名开关：**每个活动一行**。
-- 历史版本靠 CHECK (id = 1) 限定全库单行；平台化后改为 activity_id 唯一。
-- SQLite 老库的 CHECK 约束改不掉，只能删库重建（本地开发库，数据无价值）；
-- PG 新库直接就是目标形态。
CREATE TABLE IF NOT EXISTS gate_config (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id    INTEGER NOT NULL UNIQUE,
    checkin_switch INTEGER NOT NULL,
    window_start   TEXT NOT NULL,
    window_end     TEXT NOT NULL,
    updated_by     TEXT,
    updated_at     TEXT NOT NULL,
    -- 以下四列历史上由 _migrate 增量添加，新库（PG）直接在基础定义里建好；
    -- SQLite 老库已有这些列，CREATE TABLE IF NOT EXISTS 不会重建，无副作用。
    registration_switch INTEGER NOT NULL DEFAULT 1,
    event_ended         INTEGER NOT NULL DEFAULT 0,
    registration_end    TEXT,
    event_end           TEXT
);

-- 站点级键值配置：背景音乐这类「跟活动绑定、但运营随时会改」的项。
-- 平台化后主键改为 (activity_id, key)：同一份配置键每个活动各有一份值。
CREATE TABLE IF NOT EXISTS site_config (
    activity_id INTEGER NOT NULL DEFAULT 1,
    key         TEXT NOT NULL,
    value       TEXT,
    updated_by  TEXT,
    updated_at  TEXT,
    PRIMARY KEY (activity_id, key)
);

CREATE TABLE IF NOT EXISTS card_claim (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    click_id    TEXT,
    openid      TEXT,
    unionid     TEXT,
    phone       TEXT,
    name        TEXT,
    status      TEXT NOT NULL,     -- claimed / duplicate / invalid
    source      TEXT,              -- H5 跳转来源：signup / checkin
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- 领卡行为：H5 侧「点击领取礼物」「点击开卡」两类点击留痕（含身份与时间，可导出比对）
CREATE TABLE IF NOT EXISTS card_action (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    openid      TEXT,
    name        TEXT,
    phone       TEXT,
    action      TEXT NOT NULL,     -- gift_claim / card_click
    source      TEXT,              -- 触发页：signup / checkin
    visit_id    TEXT,
    identity    TEXT,              -- 去重身份，历史上由 _migrate 添加；新库直接建
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_action_created ON card_action(created_at);

-- 投放物料码：一张海报/一篇推文一个短码，用于归因到具体物料
-- 与老的固定「报名入口码 / 现场核销码」并存：老码不带 m 参数，仍算物料扫码但无法下钻
CREATE TABLE IF NOT EXISTS material_code (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    code        TEXT NOT NULL UNIQUE,  -- 短码，进 URL 的 m 参数（如 p9k2m4），全局唯一
                                       -- 全局唯一是特性：扫到码即知是哪个活动的物料
    name        TEXT NOT NULL,         -- 「9月推文首图」「签到台桌牌A」
    kind        TEXT NOT NULL DEFAULT 'signup',  -- signup 报名 / checkin 现场核销
    scene       TEXT,                  -- 推文 / 海报 / 朋友圈 / 桌牌 / 易拉宝
    note        TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    env         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_material_code_env ON material_code(env);

-- P6 展位/座位（基础类）。增值类（可视化展位图 / SVG 选座）只留 feature key，
-- 不建表、不实现——基础类不依赖任何增值模块。
-- 隐私：座位表只存手机号**后四位**，不存全号；审计里的姓名与后四位都哈希。
CREATE TABLE IF NOT EXISTS activity_booth (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    booth_no    TEXT NOT NULL,                    -- 展位号，活动内唯一
    company     TEXT NOT NULL,                    -- 企业/单位名
    positions   TEXT,                             -- JSON 数组：岗位名称
    contact     TEXT,                             -- 咨询方式（公开信息，运营自填）
    material_code TEXT,                           -- 展位二维码短码，归因用（复用物料码口径）
    enabled     INTEGER NOT NULL DEFAULT 1,
    note        TEXT,
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT,
    UNIQUE (activity_id, booth_no)
);

CREATE TABLE IF NOT EXISTS activity_seat (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    area        TEXT NOT NULL DEFAULT '',         -- 区域（A 区/一楼…）
    row_no      TEXT NOT NULL DEFAULT '',         -- 排
    seat_no     TEXT NOT NULL DEFAULT '',         -- 座
    person      TEXT NOT NULL,                    -- 姓名
    phone_tail  TEXT NOT NULL,                    -- 手机号后四位，仅此，不存全号
    source      TEXT NOT NULL DEFAULT 'import',   -- import / manual / adjust
    note        TEXT,
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT,
    UNIQUE (activity_id, area, row_no, seat_no)
);

-- 自助查询审计：只存哈希，不存明文姓名与后四位。
-- 命中与否都记一条——审计要能看出「谁在枚举」，而不是只记成功的查询。
CREATE TABLE IF NOT EXISTS self_query_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    name_hash   TEXT NOT NULL,                    -- HMAC(姓名)，不可逆、可关联统计
    tail_hash   TEXT NOT NULL,                    -- HMAC(后四位)
    hit         INTEGER NOT NULL DEFAULT 0,       -- 是否命中（不泄露给查询者，仅审计用）
    ip_hash     TEXT,                             -- IP 哈希，不存明文
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_query_audit_time ON self_query_audit(activity_id, created_at);

-- 日程 / 议程（RD-04，基础版承诺项）：一张表两种 kind。
-- schedule＝日程（按天的大块，如「11-29 上午 开幕式」）；
-- agenda＝议程（时段明细，如「09:30-10:00 领导致辞」）。
-- 共用结构是因为两者都是「时间 + 标题 + 地点 + 说明 + 排序」，分两张表
-- 只会让后台多一个 tab、前台多一套渲染，收益为零。
-- 定位导航用 location（地点名）+ map_url（地图链接，运营填，不做地理编码）。
CREATE TABLE IF NOT EXISTS activity_agenda (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    kind        TEXT NOT NULL DEFAULT 'agenda',   -- schedule / agenda
    day         TEXT NOT NULL DEFAULT '',         -- 日期或分组（「11-29」「第一天」），可空
    time_range  TEXT NOT NULL DEFAULT '',         -- 时间（「09:30-10:00」或「全天」）
    title       TEXT NOT NULL,                    -- 事项标题
    location    TEXT NOT NULL DEFAULT '',         -- 地点名
    map_url     TEXT NOT NULL DEFAULT '',         -- 定位链接（http/https，后台校验）
    speaker     TEXT NOT NULL DEFAULT '',         -- 主讲人（嘉宾讲师同类字段，复用）
    note        TEXT NOT NULL DEFAULT '',         -- 说明
    sort_order  INTEGER NOT NULL DEFAULT 0,       -- 展示顺序，小的在前
    enabled     INTEGER NOT NULL DEFAULT 1,
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_agenda_act_kind ON activity_agenda(activity_id, kind, sort_order);

-- 嘉宾/讲师（RD-04 专业版项）：与日程不同结构（人 + 职务 + 简介），
-- 不塞进 activity_agenda 以免一张表长出 guest_* 一堆列。
-- 头像存 URL（外链），不做上传——本项只承诺「展示介绍」，不承诺图片管理。
CREATE TABLE IF NOT EXISTS activity_speaker (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    name        TEXT NOT NULL,                    -- 嘉宾姓名
    title       TEXT NOT NULL DEFAULT '',         -- 职务 / 头衔
    org         TEXT NOT NULL DEFAULT '',         -- 所在机构
    bio         TEXT NOT NULL DEFAULT '',         -- 简介
    avatar_url  TEXT NOT NULL DEFAULT '',         -- 头像外链（http/https）
    sort_order  INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_speaker_act ON activity_speaker(activity_id, sort_order);

-- 报名附件（RD-04，基础版承诺：图≤2、文档≤1、≤5M）。
-- 走成功页上传，关联报名记录而非表单字段——报名提交是 JSON answers，
-- 插 file 类型要动 form 核心两步提交，风险和孤儿文件处理都不划算。
-- 数量限制在服务端按 registration_id 计数，不靠前端。
CREATE TABLE IF NOT EXISTS registration_attachment (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id     INTEGER NOT NULL DEFAULT 1,
    registration_id INTEGER NOT NULL,
    kind            TEXT NOT NULL,                 -- image / document
    ext             TEXT NOT NULL,                 -- 白名单扩展名
    filename        TEXT NOT NULL,                 -- 原名（展示用，截断）
    url             TEXT NOT NULL,                 -- /uploads/attach-...
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    credential_code TEXT NOT NULL,                 -- 冗余存，便于按码查
    status          TEXT NOT NULL DEFAULT 'active',
    env             TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attach_reg ON registration_attachment(registration_id, status);

-- 活动资料下载（2.8，专业版能力位 material_download）：主办方 → 参与者，
-- 每活动一条记录，file 与 link 二选一（由 kind 决定），不同时存两个地址。
-- 与 registration_attachment 方向相反、归属不同（活动 vs 报名），不合并。
CREATE TABLE IF NOT EXISTS activity_material (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    kind        TEXT NOT NULL,                 -- file / link
    title       TEXT NOT NULL DEFAULT '活动资料',
    filename    TEXT NOT NULL DEFAULT '',      -- 上传时原名（展示用）
    url         TEXT NOT NULL DEFAULT '',      -- /uploads/material-... 或网盘链接
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT,
    UNIQUE (activity_id)
);

-- 风控禁用词（RD-08）：平台级词库，运营在「平台设置」维护。
-- 命中时**任何非超管账号的录入文本**整单拒绝并留痕（2026-11-25 起从
-- 「只扫报名提交」扩到机构名/活动信息/议程/嘉宾/礼品/物料等全部展示文本）。
-- 不做活动级词库——同一批违规词对所有客户都适用，拆到活动级只会让漏配的
-- 活动成为洼地。
--
-- category：分类（见 riskword_lexicon.CATEGORIES），后台按类筛选。
-- source  ：builtin 出厂预置 / import 批量导入 / custom 手工新增。
--           出厂词被运营停用后，重启不会自动打开（seed 只补不覆盖）。
CREATE TABLE IF NOT EXISTS risk_word (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    word        TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    env         TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'custom',
    UNIQUE (word, env)
);

-- 伴手礼领用（RD-21，专业版活动级）：礼品定义 + 发放记录。
-- 发放记录不删行：撤销走 status='revoked' + 原因 + 退回库存，审计可回看。
CREATE TABLE IF NOT EXISTS activity_gift (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id     INTEGER NOT NULL DEFAULT 1,
    name            TEXT NOT NULL,
    spec            TEXT NOT NULL DEFAULT '',
    image_url       TEXT NOT NULL DEFAULT '',
    location        TEXT NOT NULL DEFAULT '',
    start_at        TEXT NOT NULL DEFAULT '',   -- 发放窗口（空=不限制）
    end_at          TEXT NOT NULL DEFAULT '',
    total           INTEGER NOT NULL DEFAULT 0,
    stock_left      INTEGER NOT NULL DEFAULT 0,
    per_limit       INTEGER NOT NULL DEFAULT 1,
    require_checkin INTEGER NOT NULL DEFAULT 1,
    enabled         INTEGER NOT NULL DEFAULT 1,
    env             TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_gift_act ON activity_gift(activity_id, enabled);

CREATE TABLE IF NOT EXISTS gift_claim (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id     INTEGER NOT NULL DEFAULT 1,
    gift_id         INTEGER NOT NULL,
    registration_id INTEGER NOT NULL,
    openid          TEXT,
    qty             INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'issued',  -- issued / revoked
    claim_key       TEXT NOT NULL,
    revoked_reason  TEXT NOT NULL DEFAULT '',
    operator        TEXT NOT NULL DEFAULT '',
    issued_at       TEXT NOT NULL,
    revoked_at      TEXT,
    env             TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_claim_key ON gift_claim(claim_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_claim_openid
  ON gift_claim(activity_id, gift_id, openid) WHERE status='issued' AND openid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_claim_reg
  ON gift_claim(activity_id, gift_id, registration_id) WHERE status='issued';

CREATE TABLE IF NOT EXISTS admin_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL DEFAULT 1,
    action      TEXT NOT NULL,      -- export / verify_confirm / walkin
    detail      TEXT,               -- 补充说明（导出行数、核销凭证码等）
    operator    TEXT,               -- admin 或 staff 用户名
    env         TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- 后台账号：口令只存 PBKDF2 摘要；权限按「看全号」「导出」两项分
CREATE TABLE IF NOT EXISTS account (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE,
    pass_hash      TEXT NOT NULL,
    -- admin = 平台超管（保留字面值兼容）；platform_admin/org_owner/org_admin/org_user 为机构化四档
    role           TEXT NOT NULL DEFAULT 'staff',   -- admin / staff / platform_admin / org_owner / org_admin / org_user
    org_id         INTEGER NOT NULL DEFAULT 1,     -- 所属机构；存量账号全部归默认机构 1
    can_full_phone INTEGER NOT NULL DEFAULT 0,
    can_export     INTEGER NOT NULL DEFAULT 0,
    enabled        INTEGER NOT NULL DEFAULT 1,
    env            TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT,
    last_login_at  TEXT
);

-- 登录会话：库里只存 token 的 SHA-256 摘要，默认 30 分钟滑动有效
CREATE TABLE IF NOT EXISTS account_session (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT NOT NULL UNIQUE,
    account_id   INTEGER NOT NULL,
    env          TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_session_hash ON account_session(token_hash);

-- ============ 机构化（A 批）：开通记录 / 短信包 / 支付订单 ============
-- 三张表都是平台层，不带 activity_id（机构级），故不进 _ACTIVITY_SCOPED_TABLES。
-- 金额一律存「分」（INTEGER），不用浮点——对账时一分都不能差。

-- 开通与权限变更留痕：开通、改版本、改配额、延期、功能位增删都记一条
CREATE TABLE IF NOT EXISTS org_open_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id         INTEGER NOT NULL,
    action         TEXT NOT NULL,      -- open / plan_change / quota_change / extend / feature_on / feature_off / purge
    plan           TEXT,
    activity_quota INTEGER,
    expires_at     TEXT,
    source         TEXT,               -- manual / self
    amount_fen     INTEGER NOT NULL DEFAULT 0,
    operator       TEXT,               -- 操作人用户名或 'self'
    note           TEXT,
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_open_log_org ON org_open_log(org_id, created_at);

-- 短信包：包挂机构，余额机构内共用（活动只是用不用的开关）
CREATE TABLE IF NOT EXISTS sms_package (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id        INTEGER NOT NULL,
    qty           INTEGER NOT NULL,       -- 购买条数
    used          INTEGER NOT NULL DEFAULT 0,
    price_fen     INTEGER NOT NULL,       -- 实付金额（分）
    purchased_at  TEXT NOT NULL,
    expires_at    TEXT NOT NULL,          -- 购买 +30 天；冻结期顺延
    frozen_days   INTEGER NOT NULL DEFAULT 0,  -- 累计冻结天数，解冻时一次性顺延
    order_id      INTEGER,               -- 关联 payment_order，手工加包时为空
    source        TEXT NOT NULL DEFAULT 'manual',  -- manual / self
    status        TEXT NOT NULL DEFAULT 'active',  -- active / exhausted / expired / purged
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_package_org ON sms_package(org_id, status, expires_at);

-- 支付订单：F 批启用。callback 幂等靠 out_trade_no 唯一。
CREATE TABLE IF NOT EXISTS payment_order (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id         INTEGER NOT NULL,
    kind           TEXT NOT NULL,       -- plan（版本周期）/ sms（短信包）
    amount_fen     INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'created',  -- created / paid / failed / refunded
    out_trade_no   TEXT NOT NULL UNIQUE,
    transaction_id TEXT,                -- 微信回调的 transaction_id
    ref_id         INTEGER,             -- 支付成功后写的 sms_package.id 或 org_open_log.id
    meta           TEXT,                -- 下单参数 JSON：{plan,months} 或 {qty}（F 批）
    delivered_at   TEXT,                -- 发货时刻；与 status='paid' 同事务写
    paid_at        TEXT,
    raw            TEXT,                -- 回调原文（JSON），对账用
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_order_org ON payment_order(org_id, created_at);
"""

_local = threading.local()
_init_lock = threading.Lock()
_initialized = False


def get_conn():
    """每线程一个连接。

    原先是全局单连接：后台一屏并发发四五个请求时，多线程共用一个 sqlite3 连接会
    互相踩游标，偶发「查不到会话 → 401 被踢回登录页」。SQLite 的 WAL 本就支持多连接，
    改成 thread-local 后既修掉这个偶发，也让现场并发签到更稳。
    """
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    if DB_BACKEND == "postgres":
        real = connect_postgres(PG_DSN)
        proxy = ConnProxy(real)
        # PG_SKIP_INIT=1：库与 RLS 策略已由管理员建好时跳过初始化。
        # 用途：RLS 闸门必须用一个「非 superuser」连接验证，而 ENABLE/FORCE
        # 只能由表 owner 执行——初始化与验证的身份天生不同，需要分开两步。
        # 生产默认不设置，行为完全不变。
        import os as _os
        if _os.environ.get("PG_SKIP_INIT") != "1":
            _init_pg_once(proxy)
        else:
            global _initialized
            _initialized = True
        _local.conn = proxy
        return proxy
    import os
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=10000;")   # 写锁最多等 10s，避免并发扫码直接报 locked
    conn.execute("PRAGMA foreign_keys=ON;")
    _init_once(conn)
    # P1 方言适配：包一层连接代理。sqlite 模式下纯透传（行为零变化），
    # postgres 模式下在 execute 边界转方言，router 业务 SQL 无需改动。
    _local.conn = ConnProxy(conn)
    return _local.conn


def _init_once(conn):
    """建表与播种只做一次（进程内），后续线程连接直接复用已有库结构。"""
    global _initialized
    if _initialized:
        return
    with _init_lock:
        if _initialized:
            return
        conn.executescript(SCHEMA)
        _migrate(conn)
        _ensure_indexes(conn)
        _seed_platform(conn)
        _seed_default_schema(conn)
        _seed_staff(conn)
        _seed_account(conn)
        _seed_riskwords(conn)
        _initialized = True


def _init_pg_once(conn):
    """PG 新库初始化：只建最新结构 + 索引 + 播种。

    与 SQLite 路径的关键差异：不跑任何历史迁移（_migrate / _rebuild_registration /
    _dedup_card_action 都是为「老库升级」服务的，全新库用不到）。
    SQLite 的历史迁移逻辑一行不动，保证 SQLite 模式零回归。
    """
    global _initialized
    if _initialized:
        return
    with _init_lock:
        if _initialized:
            return
        conn.execute(ddl_for_backend(SCHEMA))
        conn.commit()
        _ensure_columns_pg(conn)
        # P8 核销幂等：PG 老库也要先去重再建唯一索引
        dedup_checkin(conn)
        # 部分唯一索引与查询索引（PG 同样支持 WHERE 部分索引）
        for sql in (
            # 手机号/微信号唯一性 = 活动内唯一（平台化核心：同一人可报名多场）
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_act_phone_active ON registration(activity_id, phone) WHERE status='active'",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_act_openid_active ON registration(activity_id, openid) WHERE status='active' AND openid IS NOT NULL",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_openid ON staff(openid) WHERE openid IS NOT NULL AND openid<>''",
            # 领卡点击去重：同一活动同一身份同一行为只记第一次
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_card_action_dedup ON card_action(activity_id, action, identity) WHERE identity IS NOT NULL",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_dedup ON checkin(activity_id, registration_id) WHERE checked_at IS NOT NULL",
            "CREATE INDEX IF NOT EXISTS idx_reg_activity ON registration(activity_id)",
            "CREATE INDEX IF NOT EXISTS idx_checkin_activity ON checkin(activity_id)",
            "CREATE INDEX IF NOT EXISTS idx_events_activity ON events(activity_id)",
            "CREATE INDEX IF NOT EXISTS idx_card_action_activity ON card_action(activity_id)",
            "CREATE INDEX IF NOT EXISTS idx_admin_log_activity ON admin_log(activity_id)",
            "CREATE INDEX IF NOT EXISTS idx_reg_status ON registration(status)",
            "CREATE INDEX IF NOT EXISTS idx_reg_created ON registration(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_reg_source_code ON registration(source_code)",
            "CREATE INDEX IF NOT EXISTS idx_events_code ON events(code)",
            "CREATE INDEX IF NOT EXISTS idx_events_did ON events(did)",
            "CREATE INDEX IF NOT EXISTS idx_checkin_openid ON checkin(openid)",
            "CREATE INDEX IF NOT EXISTS idx_checkin_reg ON checkin(registration_id)",
            "CREATE INDEX IF NOT EXISTS idx_checkin_created ON checkin(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)",
            "CREATE INDEX IF NOT EXISTS idx_events_event ON events(event)",
            "CREATE INDEX IF NOT EXISTS idx_session_expires ON account_session(expires_at)",
        ):
            try:
                conn.execute(sql)
            except Exception as e:
                from logx import ev
                ev("pg_index_failed", level="error", ddl=sql, err=str(e))
        conn.commit()
        _init_rls(conn)
        _seed_platform(conn)
        _seed_default_schema(conn)
        _sync_identity_sequences(conn)
        _seed_staff(conn)
        _seed_account(conn)
        _seed_riskwords(conn)
        _initialized = True


# PG 老库补列清单：凡是在 SCHEMA 里新增的列，都要在这里再登记一次，
# 否则新建库有、已建库没有。与 SCHEMA 是「同一件事的两个入口」，不要只改一边。
_PG_ADDITIONS = [
    # P4：机构级独立域名（增值项，双模并存的前置）。留空 = 不启用。
    ("organization", "domain", "TEXT"),
    # 3.6 自定义域名全链路：验证状态（未验证的域名不参与解析）
    ("organization", "domain_verified", "INTEGER NOT NULL DEFAULT 0"),
    ("organization", "domain_verified_at", "TEXT"),
    ("activity", "domain_verified", "INTEGER NOT NULL DEFAULT 0"),
    ("activity", "domain_verified_at", "TEXT"),
    # P3 动态表单
    ("registration", "answers", "TEXT"),
    ("registration", "schema_version", "INTEGER NOT NULL DEFAULT 1"),
    # P3-c 发布闸门：进入草稿的时刻。发布时用它划界，只把「本轮草稿期」
    # 产生的数据标成 draft，不去动更早的真实报名。
    ("activity", "draft_at", "TEXT"),
    # 机构化 A 批：版本 / 配额 / 机构归属，与 SQLite additions 一一对应
    ("organization", "plan", "TEXT NOT NULL DEFAULT 'trial'"),
    ("organization", "expires_at", "TEXT"),
    ("organization", "activity_quota", "INTEGER NOT NULL DEFAULT 1"),
    ("organization", "source", "TEXT NOT NULL DEFAULT 'manual'"),
    ("organization", "frozen_at", "TEXT"),
    ("organization", "purged_at", "TEXT"),
    # 机构化 C 批：机构信息（履约联系人），与 SQLite additions 一一对应
    ("organization", "contact_name", "TEXT"),
    ("organization", "contact_phone", "TEXT"),
    # 机构化 D/F 批：自助注册协议留痕 + 支付订单发货信息
    ("organization", "agreed_at", "TEXT"),
    ("payment_order", "meta", "TEXT"),
    ("payment_order", "delivered_at", "TEXT"),
    ("account", "org_id", "INTEGER NOT NULL DEFAULT 1"),
    # 风控词库扩面（2026-11-25）：分类 / 备注 / 来源，与 SQLite additions 一一对应
    ("risk_word", "category", "TEXT NOT NULL DEFAULT ''"),
    ("risk_word", "note", "TEXT NOT NULL DEFAULT ''"),
    ("risk_word", "source", "TEXT NOT NULL DEFAULT 'custom'"),
]


def _ensure_columns_pg(conn):
    """给**已存在**的 PG 库补新列。

    为什么必须有这一步：SCHEMA 走的是 `CREATE TABLE IF NOT EXISTS`，表已经在了
    就整段跳过 —— 也就是说「改 SCHEMA 加一列」对已建好的库完全无效。服务照常
    启动、健康检查照常绿，只在第一次读写那列时抛 UndefinedColumn。P1 阶段就
    因为 gate_config 少四列踩过一次，症状是某个后台开关一保存就 500。

    每次初始化都幂等补一遍：PG 9.6+ 支持 `ADD COLUMN IF NOT EXISTS`，列已存在
    时是空操作。新增列请同时写进 SCHEMA（新库）和这里（老库）。
    """
    for table, column, coltype in _PG_ADDITIONS:
        try:
            conn.execute(
                "ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s" % (table, column, coltype)
            )
        except Exception as e:                       # 补列失败不阻断启动
            from logx import ev
            ev("pg_add_column_failed", level="error", table=table, col=column, err=str(e))
    conn.commit()


def _sync_identity_sequences(conn):
    """把 identity 序列推到当前最大 id，避免播种后的下一次自增撞主键。

    `_seed_platform` 为了稳定拿到默认机构/默认活动的 id=1，是显式写 id 插进去的。
    PG 的 GENERATED BY DEFAULT AS IDENTITY 序列**不会**因为显式插入而前进，
    所以下一次不带 id 的 INSERT 仍然从 1 开始 → duplicate key on *_pkey。
    SQLite 的 AUTOINCREMENT 取 max(id)+1，没这个坑，故只在 PG 路径处理。

    这个坑很隐蔽：播种本身成功，服务正常启动，只有在「建第二个活动」时才炸。
    """
    for tbl in ("organization", "activity"):
        try:
            conn.execute(
                "SELECT setval(pg_get_serial_sequence('%s', 'id'),"
                " COALESCE((SELECT MAX(id) FROM %s), 1))" % (tbl, tbl)
            )
        except Exception as e:
            from logx import ev
            ev("seq_sync_failed", level="error", table=tbl, err=str(e))
    conn.commit()


# 启用行级安全的表：所有带租户边界的业务表。
# staff_bind_ticket 不在内：它靠 nonce（一次性随机串）定位，且通过 staff_id
# 关联到已受限的 staff，单独再套一层收益很小。
_RLS_TABLES = (
    "registration", "checkin", "staff", "gate_config", "site_config",
    "card_claim", "card_action", "material_code", "admin_log",
    "export_log", "events", "activity_member", "form_schema",
    "activity_cta", "activity_channel",
    "activity_booth", "activity_seat", "self_query_audit",
    "activity_agenda", "activity_speaker", "registration_attachment",
    "activity_material", "activity_gift", "gift_claim",
)


def _init_rls(conn):
    """PG 行级安全：机构隔离的最后一道保险。

    **为什么必须有这一层**：应用层有 123 处 SQL 引用业务表，逐条加
    `WHERE activity_id=?` 完全靠人眼，漏一处就是跨机构串数据，而且不报错、
    测试也未必发现。RLS 把过滤下沉到数据库——任何 SQL（包括将来新写的、
    忘了加条件的）都被自动限制在当前机构内。漏了应用层过滤，这里还有网。

    **A 批改判：从活动级改为机构级**（决策清单 D14）。机构的多个活动
    本该互通（负责人跨活动看本机构总账），所以边界从 activity_id 提到 org_id。
    业务表没有 org_id 列，策略里 join activity 表判断：
        activity_id IN (SELECT id FROM activity WHERE org_id = app.org_id)
    代价是每行一次子查询，activity(org_id, id) 必须有索引（SCHEMA 已建 idx_activity_org）。

    **活动级过滤留在应用层**（各接口的 WHERE activity_id=?），不写进策略——
    否则机构管理员跨活动看总账会被 RLS 挡住，且策略难读。

    **fail-closed 是刻意的**：`app.org_id` 没设时 current_setting 返回 NULL，
    `activity_id IN (空集)` 恒为假 → 一行都查不到。宁可页面变空（立刻能发现），
    也不要悄悄串数据（上线后才发现）。

    **必须 FORCE**：platform_stg 是这些表的 owner，而表 owner 默认绕过 RLS。
    """
    for table in _RLS_TABLES:
        conn.execute("ALTER TABLE %s ENABLE ROW LEVEL SECURITY" % table)
        conn.execute("ALTER TABLE %s FORCE ROW LEVEL SECURITY" % table)
        conn.execute("DROP POLICY IF EXISTS %s_act_iso ON %s" % (table, table))
        conn.execute(
            "CREATE POLICY %s_act_iso ON %s"
            " USING (activity_id IN (SELECT id FROM activity"
            " WHERE org_id = NULLIF(current_setting('app.org_id', true), '')::int))"
            " WITH CHECK (activity_id IN (SELECT id FROM activity"
            " WHERE org_id = NULLIF(current_setting('app.org_id', true), '')::int))"
            % (table, table)
        )
    conn.commit()


def _migrate(conn):
    """给已有库补新列。

    `CREATE TABLE IF NOT EXISTS` 只管新库；老库已存在时会原样保留，
    新加的列必须显式 ALTER。这里逐条判重后添加，重复启动也不会报错。
    """
    additions = [
        ("registration", "gender", "TEXT"),
        ("registration", "status", "TEXT NOT NULL DEFAULT 'active'"),
        ("registration", "closed_at", "TEXT"),
        ("registration", "closed_by", "TEXT"),
        # v67：国际区号（通用活动字段；第二步的招聘字段已随本次通用化删除）
        ("registration", "phone_code", "TEXT NOT NULL DEFAULT '86'"),
        ("staff", "openid", "TEXT"),
        ("staff", "account_id", "INTEGER"),
        ("staff", "created_at", "TEXT"),
        # v146：现场核销人员支持「停用后删除」——软删除，行留着给历史核销流水认操作人
        ("staff", "deleted_at", "TEXT"),
        ("card_action", "identity", "TEXT"),
        ("gate_config", "registration_switch", "INTEGER NOT NULL DEFAULT 1"),
        ("gate_config", "event_ended", "INTEGER NOT NULL DEFAULT 0"),
        # 时效约束：到点自动截止/自动结束，留空表示不做时间限制
        ("gate_config", "registration_end", "TEXT"),
        ("gate_config", "event_end", "TEXT"),
        # v138：投放归因——报名记来源码，事件也记一份（扫码数按 code 聚合）
        ("registration", "source_code", "TEXT"),
        ("events", "code", "TEXT"),
        ("events", "did", "TEXT"),
        # ---- P1 平台化：租户边界 ----
        # 老库补列后能正常启动，存量数据全部归到默认活动 1（DEFAULT 1）。
        # 注意：gate_config 的 CHECK (id=1) 与 site_config 的主键约束 SQLite
        # 改不掉——单活动兼容期不受影响，多活动必须用 PG 新库（既定决策：数据不保留）。
        ("registration", "activity_id", "INTEGER NOT NULL DEFAULT 1"),
        ("checkin", "activity_id", "INTEGER NOT NULL DEFAULT 1"),
        ("staff", "activity_id", "INTEGER NOT NULL DEFAULT 1"),
        ("export_log", "activity_id", "INTEGER NOT NULL DEFAULT 1"),
        ("events", "activity_id", "INTEGER NOT NULL DEFAULT 1"),
        ("gate_config", "activity_id", "INTEGER NOT NULL DEFAULT 1"),
        ("card_claim", "activity_id", "INTEGER NOT NULL DEFAULT 1"),
        ("card_action", "activity_id", "INTEGER NOT NULL DEFAULT 1"),
        ("material_code", "activity_id", "INTEGER NOT NULL DEFAULT 1"),
        ("admin_log", "activity_id", "INTEGER NOT NULL DEFAULT 1"),
        ("site_config", "activity_id", "INTEGER NOT NULL DEFAULT 1"),
        # ---- P4：机构级独立域名（增值项，双模并存的前置）----
        # 只加字段不动解析链之外的任何东西：留空 = 不启用，行为与之前完全一致。
        ("organization", "domain", "TEXT"),
        # ---- 3.6 自定义域名全链路：验证状态 ----
        # 存量已填的域名默认 0（未验证）——它们本来也没验证过，且解析链从今天起
        # 只认 verified=1，等于把「填了就能用」的历史行为收回来，交给客户按流程验。
        ("organization", "domain_verified", "INTEGER NOT NULL DEFAULT 0"),
        ("organization", "domain_verified_at", "TEXT"),
        ("activity", "domain_verified", "INTEGER NOT NULL DEFAULT 0"),
        ("activity", "domain_verified_at", "TEXT"),
        # ---- P3 动态表单：自定义字段值（JSON）+ 填写时用的 schema 版本 ----
        # 存量报名按版本 1（默认活动的默认 schema）解释，字段值仍在原列里，数据无损。
        ("registration", "answers", "TEXT"),
        ("registration", "schema_version", "INTEGER NOT NULL DEFAULT 1"),
        # ---- P3-c 发布闸门：进入草稿的时刻（发布时按它划界标测试数据）----
        ("activity", "draft_at", "TEXT"),
        # ---- 机构化 A 批：版本 / 配额 / 机构归属 ----
        # 全部带默认值，存量行无需回填即可用：默认机构仍是 trial + 1 场，
        # 存量账号仍是 org_id=1（默认机构）。expires_at 空＝不启用时效约束。
        ("organization", "plan", "TEXT NOT NULL DEFAULT 'trial'"),
        ("organization", "expires_at", "TEXT"),
        ("organization", "activity_quota", "INTEGER NOT NULL DEFAULT 1"),
        ("organization", "source", "TEXT NOT NULL DEFAULT 'manual'"),
        ("organization", "frozen_at", "TEXT"),
        ("organization", "purged_at", "TEXT"),
        # ---- 机构化 C 批：机构信息（履约联系人）----
        ("organization", "contact_name", "TEXT"),
        ("organization", "contact_phone", "TEXT"),
        # ---- 机构化 D/F 批：自助注册协议留痕 + 支付订单发货信息 ----
        ("organization", "agreed_at", "TEXT"),
        ("payment_order", "meta", "TEXT"),
        ("payment_order", "delivered_at", "TEXT"),
        # ---- 风控词库扩面（2026-11-25）：分类 / 备注 / 来源 ----
        # 老库里的词全是运营手加的，source 默认 custom 正好；
        # category 留空表示「未分类」，后台仍列在全部分类下。
        ("risk_word", "category", "TEXT NOT NULL DEFAULT ''"),
        ("risk_word", "note", "TEXT NOT NULL DEFAULT ''"),
        ("risk_word", "source", "TEXT NOT NULL DEFAULT 'custom'"),
        ("account", "org_id", "INTEGER NOT NULL DEFAULT 1"),
    ]
    # P2：活动成员表在 SQLite 老库上不存在，建它（PG 新库已在 SCHEMA 建好）
    conn.execute("""CREATE TABLE IF NOT EXISTS activity_member (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER NOT NULL DEFAULT 1,
        account_id  INTEGER NOT NULL,
        role        TEXT NOT NULL DEFAULT 'member',
        caps        TEXT NOT NULL DEFAULT '{}',
        status      TEXT NOT NULL DEFAULT 'active',
        granted_by  INTEGER,
        granted_at  TEXT NOT NULL,
        note        TEXT,
        UNIQUE (activity_id, account_id)
    )""")
    for table, column, coltype in additions:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table).fetchall()}
        if column not in cols:
            conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, coltype))
    conn.commit()
    _rebuild_registration(conn)
    _dedup_card_action(conn)


# 通用活动平台：报名表只保留通用列，行业字段一律进 answers JSON。
# 该列清单同时用于重建迁移的数据搬运——只搬通用列，旧招聘列的值随之丢弃。
REG_COLS = ["id", "activity_id", "openid", "name", "phone", "phone_code", "gender",
            "channel", "privacy", "credential_code", "env", "is_smoke", "created_at",
            "status", "closed_at", "closed_by", "source_code", "answers", "schema_version"]


def _rebuild_registration(conn):
    """重建报名表：**去掉 UNIQUE(openid) + 去掉八列招聘专用字段**。

    2026-11-21 起平台按通用活动规则建表，education/school/major/grad_time/
    current_status/overseas/overseas_country/intent 八列全部移除，值随重建丢弃
    （Mr.R 明确：存量按测试数据，不留历史包袱）。

    关闭是软删除：人留着，但要在同一个 openid 下新建一条报名。
    SQLite 删不掉表内 UNIQUE、也不支持 DROP COLUMN，只能整表重建。
    checkin 对 registration 没有外键约束，重建不影响关联；id 原样搬过去，
    历史引用的 registration_id 依然有效。
    幂等：通用表（无 UNIQUE(OPENID)、无 education 列）直接跳过。
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='registration'"
    ).fetchone()
    if not row:
        return
    ddl = "".join((row["sql"] or "").split()).upper()
    # UNIQUE(OPENID) 或任一招聘列还在 → 都要重建
    if "UNIQUE(OPENID)" not in ddl and "EDUCATION" not in ddl:
        return

    # 老库可能缺 activity_id/phone_code/answers/schema_version，只搬实际存在的列；
    # 缺的列落 DDL 默认值（activity_id=1、phone_code=86、其余 NULL），不影响通用化。
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(registration)").fetchall()}
    cols = [c for c in REG_COLS if c in existing]
    collist = ", ".join(cols)
    # NOT NULL 列必须有值才能搬进新表。老数据可能缺 channel/phone_code/privacy/status
    # 等列，这里统一给默认值兜底，避免迁移中途撞约束失败。
    # name/phone 是业务必填，真缺说明数据是坏的，不兜底（让它报错暴露问题）。
    defaults = {
        "channel": "'推文物料'", "phone_code": "'86'", "privacy": "1",
        "activity_id": "1", "env": "'staging'", "is_smoke": "0",
        "status": "'active'", "created_at": "'%s'" % now_iso(),
        "schema_version": "1",
    }
    selectlist = ", ".join(
        "COALESCE(%s, %s)" % (c, defaults[c]) if c in defaults else c for c in cols
    )
    conn.commit()
    try:
        conn.executescript("""
BEGIN;
CREATE TABLE registration_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id     INTEGER NOT NULL DEFAULT 1,
    openid          TEXT,
    name            TEXT NOT NULL,
    phone           TEXT NOT NULL,
    phone_code      TEXT NOT NULL DEFAULT '86',
    gender          TEXT,
    channel         TEXT NOT NULL DEFAULT '推文物料',
    privacy         INTEGER NOT NULL DEFAULT 1,
    credential_code TEXT UNIQUE,
    source_code     TEXT,
    env             TEXT NOT NULL,
    is_smoke        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    closed_at       TEXT,
    closed_by       TEXT,
    answers         TEXT,
    schema_version  INTEGER NOT NULL DEFAULT 1
);
INSERT INTO registration_new (%s) SELECT %s FROM registration;
DROP TABLE registration;
ALTER TABLE registration_new RENAME TO registration;
COMMIT;
""" % (collist, selectlist))
    except Exception:
        conn.rollback()
        raise


def _dedup_card_action(conn):
    """领卡行为去重迁移：回填 identity + 建部分唯一索引。全程幂等，不删任何历史数据。

    - identity 口径与统计一致：COALESCE(NULLIF(phone,''), NULLIF(openid,''), NULLIF(name,''))；
    - 生产库里历史上已有的重复点击是既成事实，删除属于不可逆的数据操作，未经确认不做。
      因此用「水位线 + 部分索引」：只对本次上线之后新增的行 (id > watermark) 施加
      UNIQUE(action, identity)，历史行原样保留、仍可在后台查到；
    - 写入侧同时用 INSERT OR IGNORE，从今往后同一用户同一行为只落第一次；
    - identity 为 NULL 的行不受唯一约束（SQLite 里 NULL 互不相等），即「无身份不拦」；
    - 索引名固定，IF NOT EXISTS 保证重复启动不会把水位线往后推、也不会重建表。
    """
    conn.execute(
        "UPDATE card_action SET identity = "
        "COALESCE(NULLIF(phone,''), NULLIF(openid,''), NULLIF(name,'')) "
        "WHERE identity IS NULL"
    )
    watermark = conn.execute("SELECT COALESCE(MAX(id), 0) FROM card_action").fetchone()[0]
    # 去重口径改成「同一活动内」：同一个人在 A 活动点了「领卡」，
    # 到 B 活动再点属于新行为，不该被 A 活动的记录挡掉。
    conn.execute("DROP INDEX IF EXISTS idx_card_action_dedup")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_card_action_dedup "
        "ON card_action(activity_id, action, identity) "
        "WHERE identity IS NOT NULL AND id > %d" % int(watermark)
    )
    conn.commit()


def dedup_checkin(conn):
    """核销去重：给「同一场同一人多次核销」的历史脏数据保留最早一条。

    必须在加 idx_checkin_dedup 唯一索引**之前**跑——老库若有并发留下的
    重复行，直接建唯一索引会失败、服务起不来。幂等，重复跑无副作用。
    """
    conn.execute(
        "DELETE FROM checkin WHERE id IN ("
        "  SELECT id FROM ("
        "    SELECT id, ROW_NUMBER() OVER ("
        "      PARTITION BY activity_id, registration_id ORDER BY id"
        "    ) AS rn FROM checkin"
        "    WHERE checked_at IS NOT NULL AND registration_id IS NOT NULL"
        "  ) WHERE rn > 1"
        ")"
    )
    conn.commit()


def _ensure_indexes(conn):
    """报名唯一性只在「有效报名」范围内成立。

    关闭后的记录保留原手机号，不能挡住同一个人重新报名，所以旧的全表唯一索引
    换成带 WHERE status='active' 的部分索引。历史数据若有重复，容错跳过不阻启动。
    """
    try:
        conn.execute("DROP INDEX IF EXISTS idx_registration_phone")
        # 平台化：手机号/微信号唯一性从「全局唯一」改成「活动内唯一」。
        # 旧索引必须显式 DROP——CREATE INDEX IF NOT EXISTS 见到同名索引会直接跳过，
        # 旧的全局唯一约束会留下来继续挡第二场活动的报名。
        conn.execute("DROP INDEX IF EXISTS idx_reg_phone_active")
        conn.execute("DROP INDEX IF EXISTS idx_reg_openid_active")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_act_phone_active "
            "ON registration(activity_id, phone) WHERE status='active'"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_act_openid_active "
            "ON registration(activity_id, openid) "
            "WHERE status='active' AND openid IS NOT NULL"
        )
        # 一个微信只能绑定一名工作人员（身份约束，跨活动仍全局唯一）；
        # 未绑定的空值不参与唯一约束
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_openid "
            "ON staff(openid) WHERE openid IS NOT NULL AND openid<>''"
        )
        # P8 核销幂等兜底：同一场同一报名人只能有一条有效核销。
        # 并发先 SELECT 再 INSERT 会漏，唯一索引才是最后一道；建之前先清历史重复。
        dedup_checkin(conn)
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_dedup "
            "ON checkin(activity_id, registration_id) WHERE checked_at IS NOT NULL"
        )
        # ---- 查询路径索引 ----
        # 上面三个是唯一性约束（业务规则），下面这批纯粹为查询速度。
        # 现在库里只有个位数行，加不加都快；建它们是为活动当天：
        # 现场几百人集中签到 + 埋点写入，同时后台在刷名单和统计。
        # 全部 IF NOT EXISTS，重复启动无副作用。
        for sql in (
            # 租户边界列的索引：平台化后每个查询都带 activity_id，没索引等于全表扫
            "CREATE INDEX IF NOT EXISTS idx_reg_activity ON registration(activity_id)",
            "CREATE INDEX IF NOT EXISTS idx_checkin_activity ON checkin(activity_id)",
            "CREATE INDEX IF NOT EXISTS idx_events_activity ON events(activity_id)",
            "CREATE INDEX IF NOT EXISTS idx_card_action_activity ON card_action(activity_id)",
            "CREATE INDEX IF NOT EXISTS idx_admin_log_activity ON admin_log(activity_id)",
            # 名单默认按 status='active' 过滤、按时间倒序
            "CREATE INDEX IF NOT EXISTS idx_reg_status ON registration(status)",
            "CREATE INDEX IF NOT EXISTS idx_reg_created ON registration(created_at)",
            # 投放归因：按码统计报名数、按码统计扫码数
            "CREATE INDEX IF NOT EXISTS idx_reg_source_code ON registration(source_code)",
            "CREATE INDEX IF NOT EXISTS idx_events_code ON events(code)",
            "CREATE INDEX IF NOT EXISTS idx_events_did ON events(did)",
            # 签到查重与流水都是 where openid / registration_id + order by id desc
            "CREATE INDEX IF NOT EXISTS idx_checkin_openid ON checkin(openid)",
            "CREATE INDEX IF NOT EXISTS idx_checkin_reg ON checkin(registration_id)",
            "CREATE INDEX IF NOT EXISTS idx_checkin_created ON checkin(created_at)",
            # 埋点是写入最频繁的表（当前 537 行），按时间与事件名统计
            # 注意 events 表的时间列叫 ts，不是 created_at（其它表才是）
            "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)",
            "CREATE INDEX IF NOT EXISTS idx_events_event ON events(event)",
            # 会话表：过期清理按 expires_at 扫
            "CREATE INDEX IF NOT EXISTS idx_session_expires ON account_session(expires_at)",
        ):
            try:
                conn.execute(sql)
            except sqlite3.OperationalError as e:
                # 索引建不出来不能拖垮服务：活动当天宁可慢一点，也不能整个起不来。
                # 打 error 级日志，让运维在 journal 里能看见。
                from logx import ev
                ev("index_failed", level="error", ddl=sql, err=str(e))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()


# 能力字典：平台提供哪些可开关能力。basic = 基线（默认开），value = 增值项。
# P1 只立开关地基，具体功能在 P5-P7 落地；key 一经使用不要改名（活动级开关要引用）。
FEATURES = [
    ("signup",         "在线报名",   "basic", "表单报名与凭证码"),
    ("checkin",        "现场签到",   "basic", "扫码签到、核销、现场补录"),
    ("export",         "名单导出",   "basic", "CSV 导出与导出审计"),
    ("material",       "物料短码",   "basic", "投放物料归因"),
    ("card",           "权益卡领取", "basic", "领卡跳转与点击留痕"),
    ("exhibition",     "基础展位",   "basic", "岗位导入、检索、二维码"),
    ("seat",           "基础座位",   "basic", "座位导入、查座、调座"),
    ("self_query",     "自助查询",   "basic", "姓名+手机后四位查展位座位"),
    ("dashboard",      "平台看板",   "value", "跨活动汇总与活动健康度"),
    ("speaker",        "嘉宾讲师",   "value", "嘉宾姓名、职务与简介展示"),
    ("checkin_multi",  "多通道核销", "value", "按入口生成多个核销码，分场贴码与入口归因"),
    ("material_download", "资料下载", "value", "主办方上传 PDF 或发布网盘链接供参与者下载"),
    ("gift",           "伴手礼领用", "value", "礼品库存、发放与撤销记录"),
    ("custom_domain",  "自定义域名", "value", "绑定机构或活动独立域名，访客用自己域名访问"),
    ("exhibition_plus", "增值展位",  "value", "预留，方案未定不做"),
    ("seat_plus",      "增值座位",   "value", "预留，方案未定不做"),
]


def _seed_platform(conn):
    """播种平台层基础数据：默认机构、默认活动、能力字典。

    幂等：全部 ON CONFLICT DO NOTHING，重复启动不会插重。

    默认活动的 code 固定为 'default'——单活动兼容期，所有不带活动标识的请求
    都落到它身上，行为与平台化之前完全一致。这就是「加租户边界但不改变现状」
    的实现方式：老前端不加请求头，数据全部落进 activity_id=1。
    """
    import activity as _activity
    now = now_iso()
    conn.execute(
        "INSERT INTO organization (id, code, name, status, plan, activity_quota, source, created_at)"
        " VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        (1, "default", "默认机构", "active", "basic", 1, "manual", now),
    )
    conn.execute(
        "INSERT INTO activity (id, org_id, code, name, status, created_at)"
        " VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        (1, 1, _activity.DEFAULT_CODE, "默认活动", "active", now),
    )
    for key, name, tier, desc in FEATURES:
        conn.execute(
            "INSERT INTO feature (key, name, tier, description) VALUES (?,?,?,?)"
            " ON CONFLICT DO NOTHING",
            (key, name, tier, desc),
        )
    # 默认机构开通全部基线能力（增值项默认不开，等真实售卖再开）
    for key, _name, tier, _desc in FEATURES:
        if tier != "basic":
            continue
        conn.execute(
            "INSERT INTO org_entitlement (org_id, feature_key, enabled, created_at)"
            " VALUES (?,?,1,?) ON CONFLICT DO NOTHING",
            (1, key, now),
        )
    conn.commit()


def _seed_default_schema(conn):
    """给每个还没有表单 schema 的活动补一份默认版本（version 1 / published）。

    幂等：该活动已有任一版本就跳过——绝不能用「版本 1 不存在」当条件，
    否则运营删掉旧版本后重启会把默认 schema 又插回来，覆盖掉人家配好的表单。

    **存量数据无损**：默认 schema 的 11 个字段全部是 core 映射，值仍在
    registration 的原列里。老报名只需 `schema_version = 1` 就能被正确解释，
    不需要回填 answers。
    """
    import json
    import form

    fields = json.dumps(
        form.validate_fields_def(form.default_schema()), ensure_ascii=False
    )
    now = now_iso()
    for r in conn.execute("SELECT id FROM activity").fetchall():
        aid = r["id"]
        if conn.execute(
            "SELECT id FROM form_schema WHERE activity_id = ? LIMIT 1", (aid,)
        ).fetchone():
            continue
        conn.execute(
            "INSERT INTO form_schema (activity_id, version, status, fields, note, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (aid, 1, "published", fields, "默认表单：由现有字段迁移", now),
        )
    conn.commit()


def _seed_staff(conn):
    for i, tok in enumerate(STAFF_TOKENS):
        username = f"staff{i+1}"
        conn.execute(
            "INSERT OR IGNORE INTO staff (username, token, enabled) VALUES (?,?,1)",
            (username, tok),
        )
    conn.commit()


def _seed_riskwords(conn):
    """出厂风控词表补水（只补不删，规则见 riskword.seed_builtin）。

    放在每次启动而不是「仅首次建库」：老库升级上来同样要有出厂词表，
    否则新装的有一百多条、老库零条，同一个版本两种行为——这类差异
    在测试机上看不出来，到客户现场才发现风控是空的。
    """
    from logx import ev

    try:
        import riskword

        added = riskword.seed_builtin(conn)
        if added:
            ev("riskword_seeded", count=added)
    except Exception as e:
        # 种词失败不能让服务起不来：降级为空词库，业务照常，日志留痕
        ev("riskword_seed_failed", level="error", err=str(e))


def _seed_account(conn):
    """首次启动建一个管理员账号：用户名 admin，初始口令＝ADMIN_TOKEN。

    这样既保留原来的应急口令，又让后台从「单 token」过渡到「账号＋口令」。
    之后改过的口令不会被再次覆盖（只在账号表为空时播种）。
    """
    if conn.execute("SELECT COUNT(*) FROM account").fetchone()[0]:
        return
    from auth import hash_password
    from config import ADMIN_TOKEN
    try:
        conn.execute(
            "INSERT INTO account (username, pass_hash, role, org_id, can_full_phone, can_export, enabled, env, created_at) "
            "VALUES (?,?,?,?,?,?,1,?,?)",
            ("admin", hash_password(ADMIN_TOKEN), "admin", 1, 1, 1, DB_ENV, now_iso()),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        pass


@contextmanager
def transaction():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
def now_iso():
    return datetime.now(TZ).isoformat(timespec="seconds")


def gen_code():
    return secrets.token_hex(4).upper()


# 投放物料短码：32 字符集，剔除 0/1/l/i/o 等易混字符——码是要印在海报上的，
# 人工核对、电话里念都要不出错。
MAT_CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"


def gen_material_code(n=6):
    return "".join(secrets.choice(MAT_CODE_ALPHABET) for _ in range(n))


# 需要租户边界的业务表。写这些表时自动补 activity_id，**不依赖调用方记得传**：
# 漏传就是孤儿数据（activity_id 落到默认值或空），而漏传根本不会报错。
# 自动注入是唯一不会漏的机制——前提是这张清单要跟 SCHEMA 保持一致。
_ACTIVITY_SCOPED_TABLES = frozenset({
    "registration", "checkin", "staff", "export_log", "gate_config",
    "site_config", "card_claim", "card_action", "material_code",
    "admin_log", "events", "activity_member",
    "activity_cta", "activity_channel",
    "activity_booth", "activity_seat", "self_query_audit",
    "activity_agenda", "activity_speaker", "registration_attachment",
    "activity_material", "activity_gift", "gift_claim",
})


# 平台层表：机构维度，不带 env 也不带 activity_id（跨环境、跨活动的实体）。
# insert_row 对它们不注入 env——注入会报 "table X has no column named env"。
_PLATFORM_TABLES = frozenset({
    "organization", "org_entitlement", "org_open_log",
    "sms_package", "payment_order",
})


def insert_row(conn, table, data: dict):
    """统一写入：业务表强制注入 env 与 activity_id，平台表不注入。

    env / activity_id 是**业务行**的归属标记；organization 这类平台实体
    是跨环境、跨活动的，表里根本没这两列，盲注会直接 SQL 报错。
    """
    data = dict(data)
    if table not in _PLATFORM_TABLES:
        if "env" not in data:
            data["env"] = DB_ENV
        if "activity_id" not in data and table in _ACTIVITY_SCOPED_TABLES:
            import activity as _activity
            data["activity_id"] = _activity.current_id()
    if DB_BACKEND == "postgres":
        return insert_and_get_id(conn, table, list(data.keys()), list(data.values()))
    cols = ", ".join(data.keys())
    placeholders = ", ".join(["?"] * len(data))
    sql = f"INSERT INTO {table} ({cols}) VALUES ({placeholders})"
    cur = conn.execute(sql, list(data.values()))
    return cur.lastrowid



# ---------------- 站点级键值配置 ----------------
def gate_config_get(conn=None):
    """读**本活动**的闸门配置行（每活动一行）。没有行返回 None。

    收成单点函数：闸门配置有三处读取，各自写一遍 activity_id 过滤就迟早漏一处，
    漏的那处会读到别的活动的开关。
    """
    import activity as _activity
    c = conn or get_conn()
    return c.execute(
        "SELECT * FROM gate_config WHERE activity_id=?",
        (_activity.current_id(),),
    ).fetchone()


def site_config_get(conn=None, defaults=None):
    """读本活动的站点配置为 dict；缺表或某个键没写过时回落 defaults。"""
    import activity as _activity
    c = conn or get_conn()
    out = dict(defaults or {})
    try:
        rows = c.execute(
            "SELECT key, value FROM site_config WHERE activity_id = ?",
            (_activity.current_id(),),
        ).fetchall()
        for row in rows:
            out[row["key"]] = row["value"]
    except sqlite3.OperationalError:
        pass          # 老库还没建表：按默认值走，不让接口整体 500
    return out


def site_config_set(pairs, operator=None):
    """写本活动的站点配置：只 upsert 传入的键，其他键原样保留。

    刻意不用 INSERT ... ON CONFLICT(activity_id, key)：SQLite 老库的主键还是
    (key)，那个冲突目标不存在，会直接报错。改成「先 UPDATE，没命中再 INSERT」，
    两种库、新旧结构都能跑。
    """
    import activity as _activity
    now = now_iso()
    aid = _activity.current_id()
    with transaction() as c:
        for k, v in pairs.items():
            val = None if v is None else str(v)
            cur = c.execute(
                "UPDATE site_config SET value=?, updated_by=?, updated_at=?"
                " WHERE activity_id=? AND key=?",
                (val, operator, now, aid, k),
            )
            if cur.rowcount == 0:
                c.execute(
                    "INSERT INTO site_config(activity_id, key, value, updated_by, updated_at)"
                    " VALUES(?,?,?,?,?)",
                    (aid, k, val, operator, now),
                )


def init_db():
    get_conn()
    return DB_PATH
