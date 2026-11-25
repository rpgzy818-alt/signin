"""演示环境种子：建一个独立的演示机构 + demo 账号 + 非招聘场景的完整数据。

用途：销售演示与官网「看别人怎么用」入口。访客用 demo/demo 登录后台，
前后台功能都能点、能看到真实统计；数据被改乱后运行 `--reset` 复原。

隔离边界（红线）：
- 演示机构固定 id=9001、code='demo'，账号 username='demo'。
- 所有清理只针对 org_id=9001，`--reset` 绝不碰真实机构数据。
- demo 账号 role=org_admin，受 RLS 约束只能看到本机构——即便凭据公开也不会串数据。
- demo 账号 can_full_phone=0 / can_export=0，看不到完整手机号、不能导出。

用法（在项目根目录）：
  backend/.venv/bin/python backend/seed_demo.py           # 播种（已有则跳过）
  backend/.venv/bin/python backend/seed_demo.py --reset   # 清空演示数据并重播
  backend/.venv/bin/python backend/seed_demo.py --status  # 看演示数据状态
"""
import os
import sys
import argparse
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import db
import form
import form_store
from auth import hash_password
from config import DB_ENV, DEMO_ORG_ID

DEMO_ORG_CODE = "demo"
DEMO_ACT_CODE = "demo"
DEMO_USER = "demo"
DEMO_PASS = "demo"
TZ = timezone(timedelta(hours=8))

# 复原周期：超过这个小时数没复原，下次有人登录 demo 时自动重置
RESET_AFTER_HOURS = 4

# 时间戳存在 site_config（通用 KV），不新增表
RESET_KEY = "demo_last_reset"


def _now():
    return datetime.now(TZ).isoformat(timespec="seconds")


def _activity_id(conn):
    r = conn.execute("SELECT id FROM activity WHERE code=?", (DEMO_ACT_CODE,)).fetchone()
    return r["id"] if r else None


# 复位要清的活动级表：**从活动级表全集派生，不手写清单**。
# 手写清单已经漏过两轮（阶段 A/B/B′ 六张表、E 的两张礼品表），漏一张的表现是
# 演示数据越攒越多、访客上传的 PDF 与礼品发放记录长期留存——而「复原」是演示
# 环境对外的承诺。form_schema 虽是活动级但不在 _ACTIVITY_SCOPED_TABLES 里
# （它按活动存版本，不走 insert_row 的注入），单独补上；复位后会被重新播种。
CLEAR_TABLES = tuple(sorted(set(db._ACTIVITY_SCOPED_TABLES) | {"form_schema"}))


def _clear_demo_data(conn):
    """只清演示机构的数据。按 activity_id 精确限定，绝不按全表 DELETE。"""
    aid = _activity_id(conn)
    if aid is None:
        return
    for t in CLEAR_TABLES:
        conn.execute("DELETE FROM %s WHERE activity_id=?" % t, (aid,))
    # 机构级表只删演示机构的行
    for t in ("org_open_log", "sms_package", "payment_order"):
        conn.execute("DELETE FROM %s WHERE org_id=?" % t, (DEMO_ORG_ID,))
    # 活动本身与演示账号保留（否则每次 reset 都要重建账号、会话全失效）
    conn.commit()


def _seed_org_and_account(conn):
    now = _now()
    conn.execute(
        "INSERT INTO organization (id,code,name,status,plan,activity_quota,source,"
        "created_at,note,expires_at) VALUES (?,?,?,'active','basic',5,'manual',?,?,NULL)"
        " ON CONFLICT (id) DO NOTHING",
        (DEMO_ORG_ID, DEMO_ORG_CODE, "演示机构（体验）", now,
         "公开演示环境，数据定时复原，请勿填写真实信息"),
    )
    # 开通全部基础能力位（与默认机构同口径）
    for key, _name, tier, _desc in db.FEATURES:
        if tier != "basic":
            continue
        conn.execute(
            "INSERT INTO org_entitlement (org_id,feature_key,enabled,created_at)"
            " VALUES (?,?,1,?) ON CONFLICT DO NOTHING", (DEMO_ORG_ID, key, now))
    conn.execute(
        "INSERT INTO account (username,pass_hash,role,org_id,can_full_phone,can_export,"
        "enabled,env,created_at) VALUES (?,?,?,?,0,0,1,?,?)"
        " ON CONFLICT (username) DO NOTHING",
        (DEMO_USER, hash_password(DEMO_PASS), "org_admin", DEMO_ORG_ID, DB_ENV, now),
    )
    conn.commit()


def _seed_activity(conn):
    now = _now()
    conn.execute(
        "INSERT INTO activity (id,org_id,code,name,status,theme,start_at,end_at,created_at)"
        " VALUES (?,?,?,?,'active','violet',?,?,?) ON CONFLICT (id) DO NOTHING",
        (DEMO_ORG_ID * 10, DEMO_ORG_ID, DEMO_ACT_CODE,
         "2026 城市服务开放日（演示）", "2026-12-20T09:00:00+08:00",
         "2026-12-20T16:00:00+08:00", now),
    )
    conn.commit()
    return _activity_id(conn)


def _seed_form(conn, aid):
    """通用活动表单：姓名 / 性别 / 手机号 + 单位 / 职务 / 邮箱，全单步。"""
    fields = [
        {"key": "name", "type": "text", "label": "姓名", "core": "name",
         "required": True, "step": 1},
        {"key": "gender", "type": "select", "label": "性别", "core": "gender",
         "options": ["男", "女"], "required": False, "step": 1},
        {"key": "phone", "type": "phone", "label": "手机号", "core": "phone",
         "required": True, "step": 1},
        {"key": "company", "type": "text", "label": "所在单位", "required": False, "step": 1},
        {"key": "title", "type": "text", "label": "职务", "required": False, "step": 1},
        {"key": "email", "type": "email", "label": "邮箱", "required": False, "step": 1},
    ]
    form_store.save_fields(aid, fields, note="演示活动默认表单")


def _seed_intro(conn, aid):
    """介绍页文案覆盖，写 activity.intro（P7-b2 的数据契约）。"""
    import json
    intro = {
        "line1": "2026 城市服务开放日",
        "line2": "让公共服务更近一点",
        "desc": ["一场面向市民与机构的开放交流活动。现场设政策咨询、"
                 "服务体验、伙伴对接三个板块，欢迎报名参与。"],
    }
    conn.execute("UPDATE activity SET intro=? WHERE id=?",
                 (json.dumps(intro, ensure_ascii=False), aid))
    conn.commit()


def _seed_material_codes(conn, aid):
    """三个投放码：复盘页的来源归因要有东西可看。

    只有「未带投放码」一行的话，访客点开复盘会以为这功能是空的——
    而投放码归因恰好是最容易讲清楚价值的一块（哪个渠道来的人真的到场了）。
    """
    for code, name, scene in (("demo-w1", "公众号推文首图", "推文"),
                              ("demo-p1", "社区海报 A 版", "海报"),
                              ("demo-s1", "工作人员朋友圈", "朋友圈")):
        conn.execute(
            "INSERT INTO material_code (activity_id,code,name,kind,scene,enabled,"
            "created_at,env) VALUES (?,?,?,'signup',?,1,?,?)",
            (aid, code, name, scene, _now(), DB_ENV))
    conn.commit()


def _seed_registrations(conn, aid):
    """造 24 条真实感报名，前 15 条签到，覆盖关闭/来源等状态。"""
    names = [
        "王敏", "李强", "张晓宇", "陈静", "刘洋", "赵磊", "孙丽", "周婷",
        "吴昊", "徐帆", "马超", "朱琳", "胡军", "郭倩", "何伟", "高翔",
        "林菲", "罗刚", "郑楠", "梁爽", "谢宇", "宋佳", "唐磊", "韩雪",
    ]
    companies = ["城市服务中心", "社区工作站", "便民服务联盟", "公共事务研究院", "志愿者协会"]
    channels = ["活动链接", "物料扫码", "分享链接"]
    now = datetime.now(TZ)
    for i, name in enumerate(names, 1):
        phone = "139%08d" % (10000000 + i)
        created = (now - timedelta(days=2, hours=i)).isoformat(timespec="seconds")
        status = "closed" if i == 24 else "active"
        answers = {
            "gender": "男" if i % 2 else "女",
            "company": companies[i % len(companies)],
            "title": "专员" if i % 3 else "负责人",
            "email": "demo%d@example.com" % i,
        }
        import json
        # 四分之三带投放码、四分之一不带：复盘页的归因表要同时有渠道对比与
        # 自然流量，只留一种就看不出「哪个渠道来的人真的到场了」
        source = {0: "demo-w1", 1: "demo-p1", 2: "demo-s1"}.get(i % 4)
        conn.execute(
            "INSERT INTO registration (activity_id,name,phone,phone_code,gender,answers,"
            "channel,source_code,status,credential_code,privacy,env,created_at,"
            "schema_version,is_smoke)"
            " VALUES (?,?,?,'86',?,?,?,?,?,?,1,?,?,1,0)",
            (aid, name, phone, answers["gender"], json.dumps(answers, ensure_ascii=False),
             channels[i % 3], source, status, "DEMO%04d" % i, DB_ENV, created),
        )
        # 前 15 条签到（含 1 条人工核销）
        if i <= 15:
            rid = conn.execute(
                "SELECT id FROM registration WHERE activity_id=? AND credential_code=?",
                (aid, "DEMO%04d" % i),
            ).fetchone()["id"]
            checked = (now - timedelta(hours=1, minutes=i * 3)).isoformat(timespec="seconds")
            conn.execute(
                "INSERT INTO checkin (activity_id,registration_id,method,checked_at,"
                "created_at,env,is_smoke) VALUES (?,?,?,?,?,?,0)",
                (aid, rid, "manual" if i == 1 else "self", checked, checked, DB_ENV),
            )
    conn.commit()


def _mark_reset(conn, at):
    """写复位时间戳。

    不用 INSERT ... ON CONFLICT (activity_id,key)：老库 site_config 的主键还是
    单列 (key)，那个冲突目标不存在，SQLite 直接报
    "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"。
    新库有复合主键、老库没有，所以走「先 UPDATE，没命中再 INSERT」——与
    db.site_config_set 同一套写法，两种库都能跑。
    """
    cur = conn.execute(
        "UPDATE site_config SET value=?, updated_at=? WHERE activity_id=0 AND key=?",
        (at, at, RESET_KEY),
    )
    if cur.rowcount == 0:
        conn.execute(
            "INSERT INTO site_config (activity_id, key, value, updated_at) VALUES (?,?,?,?)",
            (0, RESET_KEY, at, at),
        )
    conn.commit()


def _last_reset(conn):
    r = conn.execute(
        "SELECT value FROM site_config WHERE activity_id=0 AND key=?", (RESET_KEY,)
    ).fetchone()
    if not r:
        return None
    try:
        return datetime.fromisoformat(r["value"])
    except (ValueError, TypeError):
        return None


def reset_due(conn):
    """是否到了该复原的时间（供登录时调用）。"""
    last = _last_reset(conn)
    if last is None:
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=TZ)
    return datetime.now(TZ) - last >= timedelta(hours=RESET_AFTER_HOURS)


def _seed_gifts(conn, aid):
    """两条演示礼品 + 一段真实发放记录。

    只配礼品不发一条，复盘页会出现「总量 200、已发放 0、剩余 176」这种对不上的
    数字——访客扫一眼就发现是假数据。所以按签到过的前 15 人发 15 份，
    其中 3 份撤销（复盘页的「礼品撤销」才有数字），剩余 = 200 - 15 = 185。
    """
    now = _now()
    rows = (
        ("定制帆布袋", "帆布 · 单面印", 200, 185, "签到处 · A 台"),
        ("城市纪念徽章", "金属 · 40mm", 100, 100, "签到处 · B 台"),
    )
    for name, spec, total, left, loc in rows:
        conn.execute(
            "INSERT INTO activity_gift (activity_id,name,spec,location,total,"
            "stock_left,per_limit,require_checkin,enabled,env,created_at)"
            " VALUES (?,?,?,?,?,?,1,1,1,?,?)",
            (aid, name, spec, loc, total, left, DB_ENV, now))
    gid = conn.execute(
        "SELECT id FROM activity_gift WHERE activity_id=? ORDER BY id LIMIT 1",
        (aid,)).fetchone()["id"]
    # 前 15 条演示报名都签到过（见 _seed_registrations），所以发给他们是自洽的
    regs = conn.execute(
        "SELECT id, credential_code FROM registration WHERE activity_id=?"
        " AND credential_code LIKE 'DEMO%' ORDER BY id LIMIT 15", (aid,)).fetchall()
    for i, r in enumerate(regs, 1):
        revoked = i > 12                      # 最后 3 份走撤销，原因写清楚
        conn.execute(
            "INSERT INTO gift_claim (activity_id,gift_id,registration_id,openid,qty,"
            "status,claim_key,revoked_reason,operator,issued_at,revoked_at,env)"
            " VALUES (?,?,?,?,1,?,?,?,?,?,?,?)",
            (aid, gid, r["id"], "demo-claim-%d" % r["id"],
             "revoked" if revoked else "issued",
             "demo-key-%d" % r["id"],
             "演示：现场发错台位，退回库存" if revoked else "",
             "演示工作人员",
             now,
             now if revoked else None,
             DB_ENV))
    conn.commit()


def seed(reset=False):
    conn = db.get_conn()
    if reset:
        _clear_demo_data(conn)
    # 账号和机构是常驻的，不是"数据"，reset 不删
    _seed_org_and_account(conn)
    aid = _seed_activity(conn)
    if reset:
        # 幂等：已存在的 schema/intro 在 reset 时会随活动级表被清空
        pass
    # 已有报名就跳过数据播种（避免 reset=False 时重复插）
    existing = conn.execute(
        "SELECT COUNT(*) FROM registration WHERE activity_id=?", (aid,)).fetchone()[0]
    if existing == 0:
        _seed_form(conn, aid)
        _seed_intro(conn, aid)
        _seed_material_codes(conn, aid)
        _seed_registrations(conn, aid)
        _seed_gifts(conn, aid)
    _mark_reset(conn, _now())
    return aid


def status():
    conn = db.get_conn()
    aid = _activity_id(conn)
    if aid is None:
        print("演示环境未播种")
        return
    regs = conn.execute("SELECT COUNT(*) FROM registration WHERE activity_id=?", (aid,)).fetchone()[0]
    checks = conn.execute("SELECT COUNT(*) FROM checkin WHERE activity_id=?", (aid,)).fetchone()[0]
    last = _last_reset(conn)
    print("演示机构: id=%s code=%s" % (DEMO_ORG_ID, DEMO_ORG_CODE))
    print("演示活动: id=%s code=%s" % (aid, DEMO_ACT_CODE))
    print("账号: %s / %s（role=org_admin，机构内可见）" % (DEMO_USER, DEMO_PASS))
    print("报名: %d  签到: %d" % (regs, checks))
    print("上次复原:", last.isoformat() if last else "从未")
    print("复原到期:", "是" if reset_due(conn) else "否")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="清空演示数据并重播")
    ap.add_argument("--status", action="store_true", help="查看演示数据状态")
    args = ap.parse_args()
    if args.status:
        status()
    else:
        aid = seed(reset=args.reset)
        print("演示环境已%s，activity_id=%s" % ("复原" if args.reset else "就绪", aid))


if __name__ == "__main__":
    main()
