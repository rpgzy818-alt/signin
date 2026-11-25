# 签到会 · signin

面向 50–300 人小型活动的开源报名与签到核销工具。一条命令起服务，数据留在自己的服务器，没有订阅费、没有功能墙、没有设备数限制。

An open-source sign-up and on-site check-in tool for small events. Self-hosted, MIT licensed.

---

## 它解决什么问题

办一场两百人的沙龙，常见的情况是这样：

- 用表单收完信息，签到还得靠 Excel 一列列对
- 现场靠纸笔或群里接龙，事后说不清谁到了谁没到
- 商用会务系统按年订阅，一年只办一两场，成本摊不平
- 客户手机号留在第三方平台，想导出还得看人脸色

这个工具把「报名 → 凭证 → 扫码签到 → 现场补录 → 导出台账」做成一条直线：一个容器、一个数据库、一个后台。

不追求千人大会的并发，也不做会员积分体系——那些需求有更专门的工具。

## 适合谁

**适合**：50–300 人的单场活动——沙龙、义诊、家长课堂、客户答谢会、企业内部分享、招生宣讲。需要扫码签到和导出台账，自己有服务器或愿意租一台。

**不适合**：千人以上会展、需要在线售票与分销、长期 CRM 与会员积分、医疗诊断类用途。

## 三分钟跑起来

前提：装了 Docker 与 Docker Compose（[安装说明](https://docs.docker.com/get-docker/)）。

```bash
git clone https://github.com/rpgzy818-alt/signin.git
cd signin

cp backend/.env.example .env
# 打开 .env，改掉 ADMIN_TOKEN 和 STAFF_TOKENS —— 这两项是必须改的

docker compose up -d
```

然后打开：

| 地址 | 是什么 |
|---|---|
| http://localhost:8080 | 参与者页面（活动介绍、报名、签到） |
| http://localhost:8080/admin/ | 主办方后台 |

后台账号 `admin`，密码就是你刚在 `.env` 里填的 `ADMIN_TOKEN`。

查看日志和停止：

```bash
docker compose logs -f          # 看日志
docker compose down             # 停止
docker compose up -d --build    # 改了代码后重建
```

## 必须知道的三件事

**1. `ADMIN_TOKEN` 有两个身份。** 它既是启动时的强口令校验（少于 12 位直接拒绝启动），也是首次启动时创建 `admin` 账号用的初始密码。第一次启动前就要定好，改它只影响新库——已有数据库里存的仍是旧口令。

**2. 签到默认是关的。** 这是刻意的，避免活动还没开始就有人签上。开法有两个：
- 后台 →「时段设置」→ 打开签到开关，并确认时段覆盖当前时间
- 或 `.env` 里设 `CHECKIN_SWITCH=true` 并填好 `WINDOW_START` / `WINDOW_END`

后台改一次就生效，且以数据库为准；`.env` 里的值只是首次启动的默认。

时段默认是**启动当天的 09:00–18:00**。如果在此时段之外做部署验收，扫码会提示「当前不在签到时段」——不是坏了，把时段改成覆盖当前时间即可。不想记这条，就在后台把时段直接设成活动当天全天。

**3. 数据全在 `./data` 里。** 数据库（`signin_prod.db`）、上传的附件、物料图都在这个目录。备份它就等于备份了整个系统：

```bash
tar czf signin-backup-$(date +%F).tar.gz data/
```

## 不用 Docker 怎么跑

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# 改 ADMIN_TOKEN 与 STAFF_TOKENS

uvicorn main:app --host 0.0.0.0 --port 8087
```

前端页面两种方式：

```bash
# A. 让后端一并托管（推荐，单进程）
FRONTEND_DIR=../frontend uvicorn main:app --port 8087

# B. 交给 Nginx / 任何静态服务器
python3 -m http.server 8098 --directory frontend
```

## 配置项

完整清单见 [`backend/.env.example`](backend/.env.example)，每个字段都有注释。最常动的几个：

| 变量 | 说明 |
|---|---|
| `ADMIN_TOKEN` | 【必填】后台密码 + 启动强口令，≥12 位 |
| `STAFF_TOKENS` | 【必填】核销员口令，逗号分隔，≥12 位 |
| `DB_ENV` | 环境标识，库文件名必须含同样字样（防串库），默认 `prod` |
| `CHECKIN_SWITCH` | 签到总开关，默认 `false` |
| `WINDOW_START` / `WINDOW_END` | 签到时间窗，留空 = 启动当天 09:00–18:00 |
| `CORS_ORIGINS` | 允许的来源，同域部署保持 `*` |
| `WEB_ROOT` | 上传与物料落盘的根目录，Docker 下是 `/data` |
| `FRONTEND_DIR` | 填了就让本服务托管页面；留空只提供接口 |

数据库默认 SQLite，单文件、零运维。如需 PostgreSQL，设 `DB_BACKEND=postgres` 与 `PG_DSN`（库名里要含 `DB_ENV` 的值）。

## 功能

| 模块 | 能力 |
|---|---|
| 活动页 | 介绍、议程、定位导航、主题配色，文案与时间全部后台可改 |
| 报名 | 字段自定义、提交后可改、附件上传（图 ≤2、文档 ≤1、单文件 ≤5MB） |
| 凭证 | 报名成功即生成唯一凭证码（8 位），页面展示与二维码同源 |
| 签到 | 凭证号 / 手机号 / 微信 openid 三种身份均可，扫码即签，重复签到幂等 |
| 核销 | 工作人员口令进入，支持扫码核销、手输查询、人工核销 |
| 补录 | 现场临时来人，登记即签到，标记来源为现场补录 |
| 时段闸门 | 签到、补录、核销三个写入口受时间窗控制；报名提交不受限 |
| 后台 | 名单（手机默认脱敏）、签到流水、操作日志、时段设置、表单配置 |
| 导出 | 报名名单与签到明细导出 CSV（UTF-8 BOM，Excel 直接打开不乱码） |
| 风控 | 全站展示文本敏感词拦截，词库可在后台维护 |

**不含**：在线支付、多机构租户、数据看板、讲师管理、伴手礼、自定义域名、短信服务。这些是商业托管版的内容，与开源版代码独立。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | FastAPI + Uvicorn | 单进程，无消息队列，无 Redis |
| 数据库 | SQLite / PostgreSQL | 方言适配层，两者都能跑 |
| 前端 | 原生 HTML / CSS / JS | 无框架、无 npm、无 node_modules |
| 构建 | Python 脚本 | `scripts/build.py` 把骨架与片段拼成产物 |
| 部署 | Docker Compose | 单容器，含接口与页面 |

前端不用框架是刻意的：改一句提示语不需要装 node_modules，也不需要等打包。

## 目录结构

```
backend/                后端
├── routers/
│   ├── public.py       参与者接口：报名、签到、状态查询
│   ├── staff.py        工作人员接口：核销查询与确认
│   ├── admin.py        主办方接口：名单、日志、配置
│   ├── p8.py           批量核销与现场导出
│   ├── material.py     物料（日历、海报、指引）
│   ├── agenda.py       议程
│   └── attachment.py   附件上传
├── main.py             装配：建 app、挂中间件、注册路由
├── db.py               建表与迁移
├── checkin_core.py     核销写入（三条入口共用一套幂等实现）
├── gate.py             时段闸门
├── form.py             动态表单内核
├── riskword.py         敏感词拦截
└── config.py           全部配置项与启动校验

frontend/
├── public/             参与者端骨架与路由
├── admin/              后台骨架与装配
├── flows/              页面片段：signup / checkin / staff / admin
├── core/               共用 JS 与样式
├── img/
└── index.html          构建产物（已入库，clone 即可用）

scripts/build.py        前端构建
Dockerfile
docker-compose.yml
```

改了 `frontend/` 里的源码（`public/`、`admin/`、`flows/`、`core/`）后要重新构建并提交产物：

```bash
python3 scripts/build.py
```

## 部署到公网前

- **上 HTTPS。** 签到要开摄像头扫码，浏览器只在 HTTPS 或 localhost 下允许
- **改掉默认口令。** `ADMIN_TOKEN`、`STAFF_TOKENS` 都要换成长的随机串
- **限制后台入口。** 后台路径可加 Nginx 的 IP 白名单或 basic auth
- **配好备份。** 定时打包 `data/` 目录，异地存一份
- **填真实活动信息。** 活动名称、时间、场地、介绍都在后台改，不需要动代码

## 合规提示

- 本工具只提供信息收集与核销能力，不构成医疗、法律等专业服务，不用于诊断用途
- 部署者是个人信息的处理者，需自行完成隐私告知并取得同意；涉及健康等敏感信息应取得单独同意
- 请勿将境内用户数据部署在境外服务器，以免触发数据出境合规要求
- 建议启用 HTTPS、限制后台访问 IP、定期更换管理员密码

## 许可与品牌

代码采用 [MIT License](LICENSE)：可自由使用、修改、分发与商业使用，保留版权与许可声明即可。

**代码开源不等于品牌授权。** 项目名称与标识不在 MIT 许可范围内：自部署可自行修改页脚、配色与文案；若以本项目名义对外宣传、或在商业服务中保留官方标识，需另行取得书面授权。修改后的版本请勿继续使用官方名称发布，避免使用者混淆。

## 免责

本项目按「现状」提供，不附带任何明示或默示担保。作者不对使用本软件造成的活动事故、数据丢失、合规风险或间接损失承担责任。生产环境使用前请自行完成测试、备份与安全加固。

## 联系

- 问题与建议：[Issues](https://github.com/rpgzy818-alt/signin/issues)
- 安全相关：请勿在 Issue 里贴敏感信息，通过仓库主页联系方式沟通
