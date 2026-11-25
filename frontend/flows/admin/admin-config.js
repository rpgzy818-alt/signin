  // 角色下拉：选项由后端下发（/admin/org/members 的 roles），前端不写死四档字面量。
  // 机构负责人只能由平台授予，所以机构后台这里不出现 org_owner 选项。
  var ACCT_ROLES = null;
  var ACCT_ACTS = [];        // 本机构活动，供授权弹窗
  var ACCT_GRANTS = {};      // account_id -> [activity_id]

  function loadAccounts() {
    if (!isAdmin()) return;
    // 账号页现在要两样东西：账号本身 + 每个账号被授权的活动。
    // 一次并行拉，比先出表格再补一列更不容易让人误以为「没授权」。
    Promise.all([apiAdmin("/admin/accounts"), apiAdmin("/admin/org/members")])
      .then(function (rs) {
        var res = rs[0], mem = rs[1];
        if (!res.body || !res.body.ok) return;
        var mb = (mem && mem.body && mem.body.ok) ? mem.body : null;
        if (mb) {
          ACCT_ROLES = mb.roles || [];
          ACCT_ACTS = mb.activities || [];
          ACCT_GRANTS = {};
          (mb.rows || []).forEach(function (r) { ACCT_GRANTS[r.id] = r.activity_ids || []; });
        }
        var sup = !!res.body.viewer_is_super;
        var sc = $("#acct-scope");
        if (sc) sc.textContent = sup
          ? "平台超管视角：可见全部账号。改角色/权限即时生效；停用与重置密码会踢掉该账号在线会话"
          : "本机构视角：只显示本机构账号。机构负责人与管理员默认可进本机构全部活动，普通用户按活动逐场授权";
        var tb = $("#acct-rows"), html = "";
        (res.body.rows || []).forEach(function (a) {
          var self = ACCOUNT && a.id === ACCOUNT.id;
          // 超级管理员只归本人管：其他管理员连选择器都锁死
          var locked = a.is_super && !self;
          var ro = (self || locked) ? " disabled" : "";
          var role = a.org_role || "org_user";
          var isOwnerRow = role === "org_owner" || role === "platform_admin";

          // 角色选择器：自己那一行不给改（降级自己等于把自己锁在门外）
          var roleSel = '<select class="acct-role" data-id="' + a.id + '"' +
            (self || locked ? " disabled" : "") + ">";
          var opts = (ACCT_ROLES || []).filter(function (r) {
            return role === "org_owner" ? true : r.value !== "org_owner";
          });
          if (!opts.length) opts = [{ value: role, label: ORG_ROLE_LABEL[role] || role }];
          opts.forEach(function (r) {
            roleSel += '<option value="' + r.value + '"' +
              (r.value === role ? " selected" : "") + ">" + esc(r.label) + "</option>";
          });
          // 已有的档位不在下拉里（如平台超管），补一项占位，免得显示成别人的档
          if (!opts.some(function (r) { return r.value === role; })) {
            roleSel += '<option value="' + role + '" selected>' +
              esc(ORG_ROLE_LABEL[role] || role) + "</option>";
          }
          roleSel += "</select>";

          // 授权列：负责人/管理员吃本机构全部活动，不列逐场授权
          var n = (ACCT_GRANTS[a.id] || []).length;
          var grantCell = isOwnerRow
            ? '<span class="td-sub">全部活动（默认）</span>'
            : '<span class="acct-grant">' + n + " / " + ACCT_ACTS.length + " 场</span> " +
              '<button class="btn-ghost acct-btn" data-act="grant" data-id="' + a.id +
              '" data-name="' + esc(a.username) + '">设置</button>';

          var ops;
          if (locked) {
            ops = '<span class="td-sub">仅本人可改</span>';
          } else {
            ops = '<button class="btn-ghost acct-btn" data-act="toggle" data-id="' + a.id + '"' +
                (self ? " disabled" : "") + ">" + (a.enabled ? "停用" : "启用") + "</button>" +
              '<button class="btn-ghost acct-btn" data-act="reset" data-id="' + a.id + '">重置密码</button>' +
              (a.enabled ? "" :
                '<button class="btn-ghost acct-btn is-danger" data-act="del" data-id="' + a.id + '">删除</button>');
          }
          html += "<tr>" +
            '<td class="td-name">' + esc(a.username) +
              (self ? ' <span class="td-sub">（我）</span>' : "") +
              (a.is_super ? ' <span class="td-sub">（超管）</span>' : "") + "</td>" +
            "<td>" + roleSel + "</td>" +
            "<td>" + grantCell + "</td>" +
            '<td><input type="checkbox" class="acct-perm" data-id="' + a.id + '" data-field="can_full_phone"' +
              (a.can_full_phone ? " checked" : "") + ro + " /></td>" +
            '<td><input type="checkbox" class="acct-perm" data-id="' + a.id + '" data-field="can_export"' +
              (a.can_export ? " checked" : "") + ro + " /></td>" +
            "<td>" + (a.enabled ? '<span class="td-ok">启用</span>' : '<span class="td-no">停用</span>') + "</td>" +
            '<td class="td-mono">' + esc(fmtTime(a.last_login_at) || "—") + "</td>" +
            '<td class="acct-ops">' + ops + "</td></tr>";
        });
        if (!(res.body.rows || []).length) html = '<tr><td colspan="8" class="td-empty">暂无账号</td></tr>';
        if (tb) tb.innerHTML = html;
      });
  }
  function updateAccount(id, payload) {
    payload.token = ADMIN_TOKEN;
    payload.id = id;
    return postJ("/admin/accounts/update", payload).then(function (res) {
      if (res.body.ok) { toast("已更新"); loadAccounts(); }
      else toast(res.body.detail || "更新失败");
      return res;
    });
  }
  function bindAccountRows() {
    var tb = $("#acct-rows");
    if (!tb) return;
    tb.addEventListener("change", function (e) {
      var el = e.target;
      if (el.classList.contains("acct-role")) {
        updateAccount(parseInt(el.getAttribute("data-id"), 10), { role: el.value });
        return;
      }
      if (!el.classList.contains("acct-perm")) return;
      var payload = {};
      payload[el.getAttribute("data-field")] = el.checked;
      updateAccount(parseInt(el.getAttribute("data-id"), 10), payload);
    });
    tb.addEventListener("click", function (e) {
      var b = e.target.closest(".acct-btn");
      if (!b) return;
      var id = parseInt(b.getAttribute("data-id"), 10);
      var act = b.getAttribute("data-act");
      if (act === "grant") {
        openGrantModal(id, b.getAttribute("data-name") || "", ACCT_GRANTS[id] || [],
          ACCT_ACTS, loadAccounts);
      } else if (act === "toggle") {
        var on = b.textContent.indexOf("停用") >= 0;
        updateAccount(id, { enabled: !on });
      } else if (act === "reset") {
        var np = window.prompt("输入新密码（至少 8 位）");
        if (np) updateAccount(id, { password: np });
      } else if (act === "del") {
        var tr = b.closest("tr");
        var nm = tr ? (tr.querySelector(".td-name").textContent || "").replace(/（我）|（超管）/g, "").trim() : "";
        if (!window.confirm("确定删除账号「" + nm + "」？\n删除后不可恢复，该账号的登录会话与核销凭证会同时失效。")) return;
        postJ("/admin/accounts/delete", { token: ADMIN_TOKEN, id: id }).then(function (res) {
          if (res.body && res.body.ok) { toast("已删除"); loadAccounts(); }
          else toast((res.body && res.body.detail) || "删除失败");
        });
      }
    });
  }

  function renderGate(d) {
    var box = $("#gate-panel");
    if (!box) return;
    var g = d.gate || {}, ov = d.override || {};
    var fmt = function (x) { return String(x || "").replace("T", " ").slice(0, 16); };
    var regOpen = ov.registration_switch !== 0 && ov.registration_switch !== false;
    var ended = ov.event_ended === 1 || ov.event_ended === true;

    // 三个开关用同一种卡片：名称 / 状态 / 说明 / 操作。
    // 状态点与文字同色，绿=正常态、琥珀=待时段、灰=关闭态，不看字也能扫出哪个被关了。
    var card = function (name, cls, state, note, ops, corner) {
      return '<div class="sw-card ' + cls + '">' +
        (corner || "") +
        '<div class="sw-name">' + name + '</div>' +
        '<div class="sw-state"><i></i>' + state + '</div>' +
        '<div class="sw-note">' + note + '</div>' +
        '<div class="sw-ops">' + ops + '</div></div>';
    };

    // 签到闸门 = 人工开关 AND 时间窗口（后端 gate.py 就这么算的）。
    // 之前三项全用合成值 checkin_open 驱动，于是窗口外怎么点「开启签到」都还是「已关闭」、
    // 窗口内「开启签到」又被禁用 —— 两种情况下点按钮都没反应，v133 改为分开表达：
    // 文案与按钮跟人工开关走，窗口只作补充说明，并给出「已开启·未到时段」中间态。
    var sw = (g.checkin_switch == null) ? !!g.checkin_open : !!g.checkin_switch;
    var inWin = !!g.in_window;
    var winTxt = esc(fmt(g.window && g.window.start)) + " ~ " + esc(fmt(g.window && g.window.end));
    var gateCls = !sw ? "is-off" : (inWin ? "is-on" : "is-hold");
    var gateState = !sw ? "签到已关闭" : (inWin ? "签到开放中" : "已开启 · 未到时段");
    var gateNote = !sw
      ? "人工关闭中，扫码会提示签到未开放 · 窗口 " + winTxt
      : (inWin
        ? "扫码即可签到 · 窗口 " + winTxt
        : "人工已开启，当前不在窗口内，到点自动放行 · 窗口 " + winTxt + "，需提前开放请点「编辑」改时间");

    box.innerHTML = '<div class="sw-grid">' +
      card("签到闸门", gateCls,
        gateState, gateNote,
        '<button class="btn-ghost" id="gate-on"' + (sw ? " disabled" : "") + '>开启签到</button>' +
        '<button class="btn-ghost" id="gate-off"' + (sw ? "" : " disabled") + '>关闭签到</button>',
        '<button type="button" class="sw-edit" id="gate-win-edit" title="修改签到开放时间">编辑</button>') +
      card("线上报名", regOpen ? "is-on" : "is-off",
        regOpen ? "开放中" : "已截止",
        regOpen
          ? ("用户可正常提交报名" + (ov.registration_end ? " · 截至 " + esc(fmtTime(ov.registration_end)) : ""))
          : "报名入口已关闭，用户看到截止提示",
        '<button class="btn-ghost" id="reg-switch">' + (regOpen ? "关闭报名" : "重新开放") + '</button>',
        '<button type="button" class="sw-edit" id="reg-time-edit">编辑</button>') +
      card("活动状态", ended ? "is-off" : "is-on",
        ended ? "已结束" : "进行中",
        ended
          ? "活动已结束，用户端进入回顾态"
          : ("活动正常进行" + (ov.event_end ? " · " + esc(fmtTime(ov.event_end)) + " 自动结束" : "，到点自动切换")),
        '<button class="btn-ghost" id="ended-switch">' + (ended ? "恢复进行中" : "标记活动结束") + '</button>',
        '<button type="button" class="sw-edit" id="event-time-edit">编辑</button>') +
      '</div>';

    var on = $("#gate-on"); if (on) on.addEventListener("click", function () { setGate(true); });
    var off = $("#gate-off"); if (off) off.addEventListener("click", function () { setGate(false); });
    var rs = $("#reg-switch"); if (rs) rs.onclick = function () { setConfigSwitch({ registration_switch: !regOpen }); };
    var es = $("#ended-switch"); if (es) es.onclick = function () { setConfigSwitch({ event_ended: !ended }); };

    var gwEdit = $("#gate-win-edit");
    if (gwEdit) gwEdit.onclick = function () { openGateWindow(d); };
    var regEdit = $("#reg-time-edit");
    if (regEdit) regEdit.onclick = function () { openSwitchTime("reg", d); };
    var evEdit = $("#event-time-edit");
    if (evEdit) evEdit.onclick = function () { openSwitchTime("event", d); };

    var extra = $("#gate-extra");
    if (extra) extra.innerHTML = "";     // 旧的散排两行已并入上面三列
  }

  // ---- 时间选择组件：日期用日历，时分用下拉 ----
  // 原生 datetime-local 的时分是个能无限滚的小滚轮，桌面端极难对准，
  // 这里拆成 date + 两个 select，选项有限、点选即中，也不会循环。
  function fillDtSelects() {
    var hs = document.querySelectorAll(".dt-h");
    for (var i = 0; i < hs.length; i++) {
      var sel = hs[i];
      if (sel.options.length) continue;
      for (var h = 0; h < 24; h++) {
        var v = ("0" + h).slice(-2);
        sel.add(new Option(v, v));
      }
    }
    var ms = document.querySelectorAll(".dt-m");
    for (var k = 0; k < ms.length; k++) {
      var m = ms[k];
      if (m.options.length) continue;
      for (var mm = 0; mm < 60; mm += 5) {
        var t = ("0" + mm).slice(-2);
        m.add(new Option(t, t));
      }
    }
  }
  // 分钟不在 5 的步进里（如 23:59）时补一个选项，不让原值被悄悄改掉
  function setDtMinute(sel, val) {
    if (!sel) return;
    if (val == null || val === "") { sel.selectedIndex = 0; return; }
    if (!sel.querySelector('option[value="' + val + '"]')) {
      var o = new Option(val, val);
      var opts = [].slice.call(sel.options).concat([o]);
      opts.sort(function (a, b) { return a.value.localeCompare(b.value); });
      sel.innerHTML = "";
      opts.forEach(function (x) { sel.add(new Option(x.value, x.value)); });
    }
    sel.value = val;
  }
  function readDt(prefix) {
    var d = ($("#" + prefix + "-date") || {}).value || "";
    var h = ($("#" + prefix + "-h") || {}).value || "00";
    var m = ($("#" + prefix + "-m") || {}).value || "00";
    if (!d) return "";
    return toIsoLocal(d + "T" + h + ":" + m);
  }
  function writeDt(prefix, iso) {
    var s = String(iso || "");
    var dEl = $("#" + prefix + "-date"), hEl = $("#" + prefix + "-h"), mEl = $("#" + prefix + "-m");
    if (!s) {
      if (dEl) dEl.value = "";
      if (hEl) hEl.value = "08";
      if (mEl) mEl.value = "00";
      return;
    }
    if (dEl) dEl.value = s.slice(0, 10);
    if (hEl) hEl.value = s.slice(11, 13) || "08";
    setDtMinute(mEl, s.slice(14, 16) || "00");
  }

  // 签到窗口编辑：datetime-local 交出来的是无时区的本地时间，
  // 后端按带时区的 ISO 解析，所以提交前补上本地时区偏移，避免 naive/aware 比较报错。
  function toIsoLocal(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d.getTime())) return "";
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? "+" : "-";
    var hh = ("0" + Math.floor(Math.abs(off) / 60)).slice(-2);
    var mm = ("0" + (Math.abs(off) % 60)).slice(-2);
    return v.length === 16 ? v + ":00" + sign + hh + ":" + mm : v;
  }
  function openGateWindow(d) {
    var m = $("#gw-modal"); if (!m) return;
    var w = (d && d.gate && d.gate.window) || {};
    var msg = $("#gw-msg");
    fillDtSelects();
    writeDt("gw-start", w.start);
    writeDt("gw-end", w.end);
    if (msg) msg.textContent = "";
    m.style.display = "flex";
  }
  var SWT_KIND = null;          // "reg" 报名截止 / "event" 活动结束
  var SWT_DATA = null;
  function openSwitchTime(kind, d) {
    var m = $("#swt-modal"); if (!m) return;
    SWT_KIND = kind; SWT_DATA = d;
    var ov = (d && d.override) || {};
    var v = kind === "reg" ? ov.registration_end : ov.event_end;
    var t = $("#swt-title"), tip = $("#swt-tip"), msg = $("#swt-msg");
    if (t) t.textContent = kind === "reg" ? "报名截止时间" : "活动结束时间";
    if (tip) tip.textContent = kind === "reg"
      ? "到点后线上报名自动关闭（用户点报名直接看到「报名已截止」）。留空则只能靠上面的开关手动关。"
      : "到点后活动自动进入结束态（用户端显示「本次活动已结束」）。留空则只能靠上面的按钮手动标记。";
    fillDtSelects();
    writeDt("swt", v);
    if (msg) msg.textContent = "";
    m.style.display = "flex";
  }
  function bindSwitchTime() {
    var m = $("#swt-modal"); if (!m) return;
    var close = function () { m.style.display = "none"; };
    var mask = $("#swt-mask"), cancel = $("#swt-cancel");
    if (mask) mask.onclick = close;
    if (cancel) cancel.onclick = close;

    function submit(val) {
      var msg = $("#swt-msg");
      var payload = {};
      if (SWT_KIND === "reg") payload.registration_end = val; else payload.event_end = val;
      if (msg) msg.textContent = "正在保存…";
      postJ("/admin/gate?token=" + encodeURIComponent(ADMIN_TOKEN), payload).then(function (res) {
        if (res.body && res.body.ok) {
          close(); toast(val ? "时效已设置" : "时效限制已取消");
          loadGate(); loadConfig();
        } else if (msg) msg.textContent = (res.body && res.body.detail) || "保存失败";
      }).catch(function () { if (msg) msg.textContent = "网络异常，请重试"; });
    }

    var save = $("#swt-save");
    if (save) save.onclick = function () {
      var raw = readDt("swt");
      var msg = $("#swt-msg");
      if (!raw) { if (msg) msg.textContent = "请选择日期，或用下面的「取消时效限制」"; return; }
      submit(raw);
    };
    var clr = $("#swt-clear");
    if (clr) clr.onclick = function () { submit(""); };
  }

  function bindGateWindow() {
    var m = $("#gw-modal"); if (!m) return;
    var close = function () { m.style.display = "none"; };
    var mask = $("#gw-mask"), cancel = $("#gw-cancel");
    if (mask) mask.onclick = close;
    if (cancel) cancel.onclick = close;
    var save = $("#gw-save");
    if (save) save.onclick = function () {
      var s = readDt("gw-start");
      var e = readDt("gw-end");
      var msg = $("#gw-msg");
      if (!s || !e) { if (msg) msg.textContent = "开始与结束时间都要填"; return; }
      if (new Date(s) >= new Date(e)) { if (msg) msg.textContent = "结束时间要晚于开始时间"; return; }
      if (msg) msg.textContent = "正在保存…";
      postJ("/admin/gate?token=" + encodeURIComponent(ADMIN_TOKEN),
        { window_start: s, window_end: e }).then(function (res) {
        if (res.body && res.body.ok) {
          close(); toast("签到时间已更新"); loadGate();
        } else if (msg) msg.textContent = (res.body && res.body.detail) || "保存失败";
      }).catch(function () { if (msg) msg.textContent = "网络异常，请重试"; });
    };
  }
  function setGate(on) {
    postJ("/admin/gate?token=" + encodeURIComponent(ADMIN_TOKEN), { switch: on }).then(function (res) {
      var b = res.body || {};
      if (!b.ok) { toast(b.detail || "操作失败，请重试"); return; }
      var ng = b.gate || {};
      // 接口成功 ≠ 实际放行：开关打开但还在窗口外时要说清楚，不然用户以为没生效
      if (!on) toast("签到已关闭");
      else if (ng.in_window === false) toast("开关已打开，但当前不在签到时段，到点自动放行");
      else toast("签到已开启");
      loadStats(); loadGate();
    }).catch(function () { toast("网络异常，操作未生效"); });
  }
  function setConfigSwitch(payload) {
    postJ("/admin/gate?token=" + encodeURIComponent(ADMIN_TOKEN), payload).then(function (res) {
      var b = res.body || {};
      if (b.ok) { toast("已更新"); loadGate(); loadConfig(); }
      else toast(b.detail || "操作失败，请重试");
    }).catch(function () { toast("网络异常，操作未生效"); });
  }

  // 现场异常兜底：H5 不可用或签到未开闸时，工作人员按手机号先登记
  function bindManualCheckin() {
    var btn = $("#manual-checkin"), input = $("#manual-phone"), msg = $("#manual-msg");
    if (!btn || !input) return;
    btn.onclick = function () {
      var phone = (input.value || "").trim();
      if (!/^1[3-9]\d{9}$/.test(phone)) { if (msg) msg.textContent = "请填写 11 位手机号"; return; }
      if (msg) msg.textContent = "正在登记…";
      postJ("/admin/manual-checkin?token=" + encodeURIComponent(ADMIN_TOKEN), { phone: phone }).then(function (r) {
        if (!msg) return;
        if (r.body && r.body.ok) {
          msg.textContent = r.body.status === "already" ? "该用户已签到，无需重复登记" : "登记成功，已计入到场";
          loadStats(); loadCheckins();
        } else msg.textContent = (r.body && r.body.detail) || "登记失败，请核对手机号";
      }).catch(function () { if (msg) msg.textContent = "网络异常，请重试"; });
    };
  }

  // ================= 统一状态路由：只认扫码者自己的 OpenID =================
  var ME_STATE = null;      // { state, registered, checked_in, checked_at, is_staff, ... }
  var STAFF_INFO = null;    // { is_staff, username, token }

  // 三份领取的数据与渲染见 giftRowsHTML()（签到页、成功页、状态页共用）

  // ================= 日程 / 议程（RD-04）=================
  // 一张表两种 kind；活动从请求上下文取，前端不带 aid。
  // 列表事件用委托绑在 tbody 上——重绘后按钮是新的，逐行绑会全哑。
  var AGENDA_ROWS = [];
  var AGENDA_BOUND = false;

  function loadAgenda() {
    if (!ADMIN_TOKEN) return;
    apiAdmin("/admin/activity/agenda").then(function (res) {
      var rows = (res.body && res.body.rows) || [];
      AGENDA_ROWS = rows;
      var tb = document.getElementById("admin-agenda");
      if (!tb) return;
      if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#68808e">还没配日程议程，参与者端保留默认时间线</td></tr>';
        return;
      }
      tb.innerHTML = rows.map(function (r) {
        var kind = r.kind === "schedule" ? "日程" : "议程";
        var when = (r.day || "") + (r.time_range ? " " + r.time_range : "");
        var maplink = r.map_url
          ? ' <a href="' + esc(r.map_url) + '" target="_blank" rel="noopener noreferrer">定位</a>' : "";
        return '<tr data-id="' + r.id + '">' +
          '<td>' + esc(kind) + '</td>' +
          '<td>' + esc(when || "—") + '</td>' +
          '<td>' + esc(r.title) + (r.speaker ? '<br><small>' + esc(r.speaker) + '</small>' : '') + '</td>' +
          '<td>' + esc(r.location || "—") + maplink + '</td>' +
          '<td>' + Number(r.sort_order || 0) + '</td>' +
          '<td>' + (r.enabled ? '启用' : '<span style="color:#b4453a">停用</span>') + '</td>' +
          '<td><button type="button" class="btn-ghost ag-toggle" data-op="toggle">' +
            (r.enabled ? '停用' : '启用') + '</button> ' +
          '<button type="button" class="btn-ghost is-danger ag-del" data-op="del">删除</button></td>' +
        '</tr>';
      }).join("");
    });
  }

  function bindAgendaPage() {
    if (AGENDA_BOUND) { loadAgenda(); return; }
    var addBtn = document.getElementById("ag-add");
    if (!addBtn) return;
    AGENDA_BOUND = true;

    addBtn.addEventListener("click", function () {
      var val = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ""; };
      var payload = {
        kind: val("ag-kind"), day: val("ag-day"), time_range: val("ag-time"),
        title: val("ag-title"), location: val("ag-loc"), map_url: val("ag-map"),
        speaker: val("ag-speaker"), note: val("ag-note"),
        sort_order: Number(val("ag-sort") || 0), enabled: 1
      };
      if (!payload.title) { toast("请填标题"); return; }
      var btn = addBtn; btn.disabled = true;
      sendAdmin("POST", "/admin/activity/agenda", payload).then(function (res) {
        btn.disabled = false;
        if (!res.body || !res.body.ok) {
          toast((res.body && res.body.detail) || "添加失败，请重试"); return;
        }
        ["ag-day", "ag-time", "ag-title", "ag-loc", "ag-map", "ag-speaker", "ag-note"].forEach(function (id) {
          var e = document.getElementById(id); if (e) e.value = "";
        });
        toast("已添加");
        loadAgenda();
      }).catch(function () { btn.disabled = false; toast("网络异常，请重试"); });
    });

    var tb = document.getElementById("admin-agenda");
    if (tb) tb.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button[data-op]") : null;
      if (!btn) return;
      var tr = btn.closest("tr");
      if (!tr) return;
      var id = tr.getAttribute("data-id");
      var op = btn.getAttribute("data-op");
      if (op === "toggle") {
        var row = AGENDA_ROWS.filter(function (r) { return String(r.id) === id; })[0];
        if (!row) return;
        sendAdmin("PATCH", "/admin/activity/agenda/" + id, { enabled: row.enabled ? 0 : 1 })
          .then(function (res) {
            if (!res.body || !res.body.ok) { toast("操作失败"); return; }
            loadAgenda();
          });
      } else if (op === "del") {
        askConfirm({ title: "删除条目", text: "确认删除这条日程/议程？", okText: "删除", danger: true })
          .then(function (yes) {
            if (!yes) return;
            sendAdmin("DELETE", "/admin/activity/agenda/" + id).then(function (res) {
              if (!res.body || !res.body.ok) { toast("删除失败"); return; }
              toast("已删除"); loadAgenda();
            });
          });
      }
    });
    loadAgenda();
  }

  // ================= 嘉宾 / 讲师（RD-04 专业版）=================
  // 与日程同构：事件委托绑 tbody，重绘后按钮不丢。
  var SPEAKER_ROWS = [];
  var SPEAKER_BOUND = false;

  function loadSpeakersAdmin() {
    if (!ADMIN_TOKEN) return;
    apiAdmin("/admin/activity/speakers").then(function (res) {
      var rows = (res.body && res.body.rows) || [];
      SPEAKER_ROWS = rows;
      var tb = document.getElementById("admin-speakers");
      if (!tb) return;
      if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#68808e">还没配嘉宾，前台不显示嘉宾区</td></tr>';
        return;
      }
      tb.innerHTML = rows.map(function (r) {
        var meta = [r.title, r.org].filter(Boolean).join(" · ");
        return '<tr data-id="' + r.id + '">' +
          '<td>' + esc(r.name) + '</td>' +
          '<td>' + esc(meta || "—") + '</td>' +
          '<td>' + esc((r.bio || "").slice(0, 40)) + '</td>' +
          '<td>' + Number(r.sort_order || 0) + '</td>' +
          '<td>' + (r.enabled ? '启用' : '<span style="color:#b4453a">停用</span>') + '</td>' +
          '<td><button type="button" class="btn-ghost sp-toggle" data-op="toggle">' +
            (r.enabled ? '停用' : '启用') + '</button> ' +
          '<button type="button" class="btn-ghost is-danger sp-del" data-op="del">删除</button></td>' +
        '</tr>';
      }).join("");
    });
  }

  function bindSpeakersPage() {
    if (SPEAKER_BOUND) { loadSpeakersAdmin(); return; }
    var addBtn = document.getElementById("sp-add");
    if (!addBtn) return;
    SPEAKER_BOUND = true;

    addBtn.addEventListener("click", function () {
      var val = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ""; };
      var payload = {
        name: val("sp-name"), title: val("sp-title"), org: val("sp-org"),
        bio: val("sp-bio"), avatar_url: val("sp-avatar"),
        sort_order: Number(val("sp-sort") || 0), enabled: 1
      };
      if (!payload.name) { toast("请填嘉宾姓名"); return; }
      var btn = addBtn; btn.disabled = true;
      sendAdmin("POST", "/admin/activity/speakers", payload).then(function (res) {
        btn.disabled = false;
        if (!res.body || !res.body.ok) {
          toast((res.body && res.body.detail) || "添加失败，请重试"); return;
        }
        ["sp-name", "sp-title", "sp-org", "sp-bio", "sp-avatar"].forEach(function (id) {
          var e = document.getElementById(id); if (e) e.value = "";
        });
        toast("已添加"); loadSpeakersAdmin();
      }).catch(function () { btn.disabled = false; toast("网络异常，请重试"); });
    });

    var tb = document.getElementById("admin-speakers");
    if (tb) tb.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button[data-op]") : null;
      if (!btn) return;
      var tr = btn.closest("tr"); if (!tr) return;
      var id = tr.getAttribute("data-id");
      var op = btn.getAttribute("data-op");
      if (op === "toggle") {
        var row = SPEAKER_ROWS.filter(function (r) { return String(r.id) === id; })[0];
        if (!row) return;
        sendAdmin("PATCH", "/admin/activity/speakers/" + id, { enabled: row.enabled ? 0 : 1 })
          .then(function (res) { if (res.body && res.body.ok) loadSpeakersAdmin(); else toast("操作失败"); });
      } else if (op === "del") {
        askConfirm({ title: "删除嘉宾", text: "确认删除这位嘉宾？", okText: "删除", danger: true })
          .then(function (yes) {
            if (!yes) return;
            sendAdmin("DELETE", "/admin/activity/speakers/" + id).then(function (res) {
              if (res.body && res.body.ok) { toast("已删除"); loadSpeakersAdmin(); }
              else toast("删除失败");
            });
          });
      }
    });
    loadSpeakersAdmin();
  }

  // ================= 活动资料下载（2.8，专业版）=================
  var MATERIAL_BOUND = false;

  function mtMsg(text) {
    var el = document.getElementById("mt-msg");
    if (el) el.textContent = text || "";
  }
  function loadMaterialAdmin() {
    if (!ADMIN_TOKEN) return;
    apiAdmin("/admin/activity/material").then(function (res) {
      var d = res.body || {};
      var box = document.getElementById("mt-current");
      if (!box) return;
      var row = d.row;
      if (!row) {
        box.innerHTML = '<p style="color:#68808e;font-size:12px">当前活动还没有配置资料下载。</p>';
        return;
      }
      var what = row.kind === "file"
        ? ("本地 PDF · " + (row.filename || ""))
        : esc(row.url);
      box.innerHTML = '<div class="ad-table-wrap"><table class="ad-table">' +
        '<thead><tr><th>资料</th><th>形式</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
        '<tr><td>' + esc(row.title || "活动资料") + '<br><small>' + what + '</small></td>' +
        '<td>' + (row.kind === "file" ? "PDF 文件" : "网盘链接") + '</td>' +
        '<td>' + (row.enabled ? '启用' : '<span style="color:#b4453a">停用</span>') + '</td>' +
        '<td><button type="button" class="btn-ghost" data-op="toggle">' +
          (row.enabled ? '停用' : '启用') + '</button> ' +
        '<button type="button" class="btn-ghost is-danger" data-op="del">删除</button></td></tr>' +
        '</tbody></table></div>';
    });
  }

  function bindMaterialPage() {
    if (MATERIAL_BOUND) { loadMaterialAdmin(); return; }
    var saveLink = document.getElementById("mt-save-link");
    if (!saveLink) return;
    MATERIAL_BOUND = true;

    saveLink.addEventListener("click", function () {
      var title = (document.getElementById("mt-title") || {}).value || "";
      var url = (document.getElementById("mt-url") || {}).value || "";
      if (!url.trim()) { mtMsg("请填写网盘链接"); return; }
      mtMsg("保存中…");
      saveLink.disabled = true;
      sendAdmin("POST", "/admin/activity/material/link",
        { title: title.trim() || "活动资料", url: url.trim() }).then(function (res) {
        saveLink.disabled = false;
        mtMsg(res.ok && res.body && res.body.ok ? "已保存" : ((res.body && res.body.detail) || "保存失败"));
        if (res.ok && res.body && res.body.ok) loadMaterialAdmin();
      }).catch(function () { saveLink.disabled = false; mtMsg("网络异常，请重试"); });
    });

    var upload = document.getElementById("mt-upload");
    if (upload) upload.addEventListener("click", function () {
      var input = document.getElementById("mt-file");
      var file = input && input.files && input.files[0];
      if (!file) { mtMsg("请先选择 PDF 文件"); return; }
      if (file.size > 5 * 1024 * 1024) { mtMsg("文件不能超过 5MB"); return; }
      mtMsg("上传中…");
      upload.disabled = true;
      var title = (document.getElementById("mt-title") || {}).value || "活动资料";
      var url = API + "/admin/activity/material/upload?token=" +
        encodeURIComponent(ADMIN_TOKEN) + "&filename=" + encodeURIComponent(file.name) +
        "&title=" + encodeURIComponent(title.trim() || "活动资料");
      fetch(url, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            return { ok: r.ok, body: j };
          });
        })
        .then(function (res) {
          upload.disabled = false;
          if (!res.ok || !res.body.ok) { mtMsg((res.body && res.body.detail) || "上传失败"); return; }
          mtMsg("上传成功");
          if (input) input.value = "";
          loadMaterialAdmin();
        }).catch(function () { upload.disabled = false; mtMsg("网络异常，请重试"); });
    });

    var box = document.getElementById("mt-current");
    if (box) box.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button[data-op]") : null;
      if (!btn) return;
      var op = btn.getAttribute("data-op");
      if (op === "toggle") {
        var cur = box.querySelector("td:nth-child(3)");
        var on = !cur || cur.textContent.indexOf("停用") < 0;
        sendAdmin("PATCH", "/admin/activity/material", { enabled: on ? 0 : 1 })
          .then(function (res) { mtMsg(res.ok && res.body.ok ? "已更新" : "操作失败"); loadMaterialAdmin(); });
      } else if (op === "del") {
        askConfirm({ title: "删除资料下载", text: "删除后前台立刻不再显示，确认？", okText: "删除", danger: true })
          .then(function (yes) {
            if (!yes) return;
            sendAdmin("DELETE", "/admin/activity/material").then(function (res) {
              mtMsg(res.ok && res.body.ok ? "已删除" : "删除失败");
              loadMaterialAdmin();
            });
          });
      }
    });
    loadMaterialAdmin();
  }
