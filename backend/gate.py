"""
时段闸门（硬闸门，只罩签到/补录/核销三写入口；报名提交不受限）
- checkin_switch：配置态（运维/发布侧开关）
- in_window：计算态（当前是否在 2026-11-29 09:00–16:00 +08:00 具体窗口内）
- checkin_open = checkin_switch AND in_window（9:00 才 true）
T0 受控例外：由发布侧临时改写 WINDOW_START/END 为当下起止并开 switch，关闸后恢复具体日期。
"""
from datetime import datetime
import zoneinfo
from config import CHECKIN_SWITCH, WINDOW_START, WINDOW_END

TZ = zoneinfo.ZoneInfo("Asia/Shanghai")


def _parse(iso):
    # 支持 "2026-11-29 09:00:00+08:00" 与 ISO 标准格式
    # 无时区的串必须补上海时区：否则 start/end 是 naive，与 now（aware）比较会抛
    # TypeError，届时 gate_state() 全挂，签到/补录/核销三个入口一起 500。
    s = str(iso).strip()
    if " " in s and "T" not in s:
        s = s.replace(" ", "T")
    d = datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=TZ)


def norm_iso(s, field="时间"):
    """把前端传来的时间串规范成带时区的 ISO；空值返回 None，非法值抛 ValueError。

    落库前必须走这里。后台把 `2026-11-29T16:00` 这种没有时区的串写进 gate_config，
    就会毒化整个闸门（见 _parse 注释），而且是「保存成功、之后签到全 500」的隐蔽故障。
    """
    if s is None or str(s).strip() == "":
        return None
    raw = str(s).strip()
    try:
        d = datetime.fromisoformat(raw.replace(" ", "T"))
    except ValueError:
        raise ValueError("%s格式不正确：%s" % (field, raw))
    if d.tzinfo is None:
        d = d.replace(tzinfo=TZ)
    return d.isoformat(timespec="seconds")


def _db_override():
    """运行时闸门覆盖：后台可在不改环境变量、不重启服务的情况下开关签到与调整窗口。

    现场最怕"到点了签到开不了"或"散场了还没关"，故把开关做成数据而非部署配置。
    """
    try:
        import activity as _activity
        from db import get_conn
        row = get_conn().execute(
            "SELECT checkin_switch, window_start, window_end"
            " FROM gate_config WHERE activity_id=?",
            (_activity.current_id(),),
        ).fetchone()
        if row:
            return row
    except Exception:
        pass          # 表不存在/库未就绪时退回环境变量，不影响服务
    return None


def gate_state():
    now = datetime.now(TZ)
    ov = _db_override()
    switch = bool(CHECKIN_SWITCH)
    start, end = _parse(WINDOW_START), _parse(WINDOW_END)
    bad_window = False
    if ov:
        switch = bool(ov["checkin_switch"])
        try:
            start = _parse(ov["window_start"])
            end = _parse(ov["window_end"])
        except (ValueError, TypeError):
            # 库里窗口串坏掉时不能让签到入口整体 500：退回环境变量窗口继续服务，
            # 同时把 window_invalid 报出去，后台能看见「配置坏了」而不是「签到挂了」。
            bad_window = True
    in_window = start <= now <= end
    checkin_open = switch and in_window
    return {
        "checkin_switch": switch,
        "in_window": in_window,
        "checkin_open": checkin_open,
        "window_invalid": bad_window,
        "server_time": now.isoformat(timespec="seconds"),
        "window": {
            "start": start.isoformat(timespec="seconds"),
            "end": end.isoformat(timespec="seconds"),
        },
    }
