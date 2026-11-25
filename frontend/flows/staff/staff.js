  function bindWalkin() {
    var form = $("#walkin-form"); if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("#walkin-msg");
      // 区号与号码分开取，规则与报名表一致：86 严格 11 位，其他区号 4—15 位。
      // 号码统一只留数字——海外号常带空格/连字符
      var cc = ((form.elements.cc && form.elements.cc.value) || "").replace(/\D/g, "") || "86";
      var d = { name: form.name.value.trim(),
        phone: (form.phone.value || "").replace(/\D/g, ""),
        phone_code: cc,
        gender: form.gender ? form.gender.value : "",
        openid: getOpenid() };
      if (!d.name) { msg.textContent = "请填写姓名"; return; }
      if (cc === "86") {
        if (!/^1[3-9]\d{9}$/.test(d.phone)) { msg.textContent = "手机号格式不正确，请填写 11 位大陆手机号"; return; }
      } else if (!(d.phone.length >= 4 && d.phone.length <= 15)) {
        msg.textContent = "请填写有效号码"; return;
      }
      postJ("/walkin", d).then(function (res) {
        if (!res.body.ok) { msg.textContent = "补录失败，请重试"; return; }
        toast("补录并签到成功");
        // 后端已经把报名名单和签到记录一起写好了（channel=现场补录，状态=已签到），
        // 这里用返回值就地更新本地状态，不依赖再拉一次 /me：
        // iOS 微信的 go() 走 history.replaceState，既不触发 hashchange，也不会走
        // routeByState→onCheckinEnter，签到页会原样停在上一次的「现场登记」DOM 上。
        // 结果就是补录完看着像没成功，再点一次又进补录表单——来回鬼打墙。
        ME_STATE = {
          ok: true, state: "checked_in", registered: true, checked_in: true,
          checked_at: res.body.checked_at || "", method: "walkin",
          name: d.name, credential_code: res.body.credential_code || "",
          created_at: (ME_STATE && ME_STATE.created_at) || "",
          is_staff: !!(ME_STATE && ME_STATE.is_staff), closed: false, closed_at: null
        };
        // 清表单：同一个人一般不会连补两次，留着旧值容易被下一位直接提交上去。
        // reset 不会触发 input，区号回 86 了手机号的 maxlength 还停在 15，
        // 补一次 input 让 bindCcInput 把上限一起同步回来。
        try {
          form.reset();
          if (form.elements.cc) form.elements.cc.dispatchEvent(new Event("input"));
          syncSignupLabels();
        } catch (e) {}
        setTimeout(function () {
          go("checkin");
          onCheckinEnter();     // 补一次重绘：replaceState 那条路不会自己触发
        }, 800);
      }).catch(function () { msg.textContent = "网络异常，请重试"; });
    });
  }

  // ---- 核销 ----
  // 核销结果渲染：签到台上要一眼看出「能不能进」，所以状态用横条、姓名用大字
  function vfMethod(m) {
    return ({ self: "自助签到", verify: "工作人员核销", walkin: "现场补录" })[m] || "已签到";
  }
  // 伴手礼（RD-21）：核销页按库存里的状态出按钮，不靠"扫到第几次"。
  // 未开通能力位时接口 403，这里静默不渲染，不影响原核销动线。
  function vfLoadGifts(token, code) {
    api("/gift/status?token=" + encodeURIComponent(token) + "&code=" + encodeURIComponent(code))
      .then(function (res) {
        var rows = (res.body && res.body.rows) || [];
        if (!res.ok || !rows.length) return;
        var card = $("#verify-result .vf-card");
        if (!card) return;
        var box = document.createElement("div");
        box.className = "vf-gifts";
        box.innerHTML = '<p class="vf-gifts-t">伴手礼</p>' + rows.map(function (g, i) {
          var tail = g.state === "issued"
            ? "已领 " + esc(String(g.issued_at).slice(5, 16)) + " · " + g.qty + " 份"
            : (g.state === "revoked" ? "已撤销，可重新发放"
              : (g.window === "not_started" ? esc(g.start_at) + " 开始发放"
                : (g.window === "ended" ? "发放已结束"
                  : (g.stock_left < 1 ? "已发完" : "可发放 · 余 " + g.stock_left))));
          var qty = g.can_issue && g.per_limit > 1
            ? '<input type="number" class="vf-gqty" data-i="' + i + '" min="1" max="' +
              Math.min(g.per_limit, g.stock_left) + '" value="1" />' : "";
          var btn = g.can_issue
            ? '<button type="button" class="vf-give" data-i="' + i + '">发放</button>' : "";
          return '<div class="vf-gift-row"><span><b>' + esc(g.name) + '</b><small>' + tail +
            '</small></span>' + qty + btn + '</div>';
        }).join("") +
        '<button type="button" class="vf-skip" id="vf-skip">暂不发放</button>';
        card.appendChild(box);
        var give = box.querySelector("[data-gf-issue]"); // 占位：下面用委托绑定
        box.addEventListener("click", function (e) {
          var b = e.target.closest ? e.target.closest(".vf-give") : null;
          if (b) {
            var i = Number(b.getAttribute("data-i")), g = rows[i];
            var qi = box.querySelector('.vf-gqty[data-i="' + i + '"]');
            var qty = qi ? Math.max(1, Number(qi.value || 1)) : 1;
            b.disabled = true; b.textContent = "发放中…";
            postJ("/gift/claim", { token: token, code: code, gift_id: g.id, qty: qty,
              claim_key: "gf-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) })
              .then(function (rr) {
                if (rr.body && rr.body.ok) {
                  api("/verify/lookup?token=" + encodeURIComponent(token) +
                      "&code=" + encodeURIComponent(code)).then(function (res2) {
                    var d = (res2.body && res2.body.found) ? res2.body
                      : { name: "—", phone: "—", checked_in: true, checked_at: "", method: "verify" };
                    vfRenderLookup(d, token, code);
                  });
                }
                else { b.disabled = false; b.textContent = "发放"; toast((rr.body && rr.body.detail) || "发放失败"); }
              }).catch(function () { b.disabled = false; b.textContent = "发放"; toast("网络异常，请重试"); });
            return;
          }
          var sk = e.target.closest ? e.target.closest("#vf-skip") : null;
          if (sk) { $("#verify-result").innerHTML = ""; var f = $("#vf-code"); if (f) { f.value = ""; f.focus(); } }
        });
      }).catch(function () { /* 未开通/网络异常都不打扰核销主路径 */ });
  }
  function vfRenderLookup(r, token, code) {
    var box = $("#verify-result");
    var html = '<div class="vf-card">';
    html += '<div class="vf-bar vf-bar-' + (r.checked_in ? "warn" : "ok") + '">' +
      (r.checked_in ? "已签到，请勿重复核销" : "可签到") + '</div>';
    html += '<div class="vf-body">';
    html += '<div class="vf-name">' + esc(r.name) + '</div>';
    html += '<div class="vf-phone">' + esc(r.phone) + '</div>';
    if (r.checked_in) {
      html += '<div class="vf-when">' + vfMethod(r.method) + ' · ' + fmtTime(r.checked_at) + '</div>';
    } else {
      html += '<button type="button" class="vf-confirm" id="verify-confirm">确认签到</button>';
    }
    html += '</div></div>';
    box.innerHTML = html;
    if (r.checked_in) vfLoadGifts(token, code);
    var cf = $("#verify-confirm");
    if (cf) cf.addEventListener("click", function () {
      cf.disabled = true;
      cf.textContent = "正在签到…";
      postJ("/verify/confirm", { token: token, code: code }).then(function (rr) {
        if (rr.body && rr.body.ok) {
          toast("核销成功");
          var fc = $("#vf-code");
          if (fc) { fc.value = ""; fc.focus(); }
          // 重新查一次拿后端真实的签到时间：前端本地时间可能是别的时区，
          // 显示成 02:01 这种就会让工作人员以为核销错了
          api("/verify/lookup?token=" + encodeURIComponent(token) +
              "&code=" + encodeURIComponent(code)).then(function (res2) {
            if (res2.body && res2.body.found) vfRenderLookup(res2.body, token, code);
          });
        } else {
          cf.disabled = false;
          cf.textContent = "确认签到";
          toast((rr.body && rr.body.detail) || "核销失败，请重试");
        }
      }).catch(function () {
        cf.disabled = false;
        cf.textContent = "确认签到";
        toast("网络异常，请重试");
      });
    });
  }

  function bindVerify() {
    var form = $("#verify-form"); if (!form) return;
    var codeEl = $("#vf-code");
    // 凭证码统一大写：后台存的是大写 hex，小写输入查不到，输错一次就要重来
    if (codeEl) codeEl.addEventListener("input", function () {
      var p = this.selectionStart;
      this.value = this.value.toUpperCase().replace(/[^0-9A-F]/g, "");
      this.setSelectionRange(p, p);
    });
    // 工作人员扫用户凭证码进来时，凭证码已经带在地址里，直接填好
    var pre = hashParam("code");
    if (pre) {
      form.code.value = String(pre).toUpperCase();
      var tip = $("#verify-result"), isStaff = STAFF_INFO && STAFF_INFO.is_staff;
      if (tip) tip.innerHTML = isStaff
        ? '<div class="state-box state-info">凭证码已带入，点「查询」核对</div>'
        : '<div class="state-box state-warn">凭证码已带入，填写核销凭据后点「查询」</div>';
      if (!isStaff && form.token) form.token.focus();
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var token = form.token.value.trim(), code = form.code.value.trim();
      if (!token || !code) { toast("请填写凭据与凭证码"); return; }
      if (code.length !== 8) { toast("凭证码是 8 位，请核对"); return; }
      api("/verify/lookup?token=" + encodeURIComponent(token) + "&code=" + encodeURIComponent(code))
        .then(function (res) {
          var box = $("#verify-result");
          if (!res.body.ok && res.status === 404) {
            box.innerHTML = '<div class="vf-card vf-empty"><b>未找到报名记录</b>' +
              '<span>核对凭证码是否输错；没有线上报名的人，请带到补录台登记。</span></div>';
            return;
          }
          if (!res.body.found) {
            box.innerHTML = '<div class="vf-card vf-empty"><b>未找到报名记录</b>' +
              '<span>核对凭证码是否输错；没有线上报名的人，请带到补录台登记。</span></div>';
            return;
          }
          vfRenderLookup(res.body, token, code);
        })
        .catch(function () {
          $("#verify-result").innerHTML =
            '<div class="vf-card vf-empty"><b>网络异常</b><span>稍后重试，或让用户走现场补录。</span></div>';
        });
    });
  }

  // ---- 已报名自动回到成功页 ----
  // 只在「默认入口」上自动跳：分享链接、扫码、直接打开域名都算。
  // 用户明确要去签到页 / 核销页 / 后台时不打扰，避免把他从正在做的事上拽走。
  function autoResume() {
    var route = currentRoute();
    if (route && route !== "intro") return;
    var oid = getOpenid();
    if (!oid) return;
    api("/me?openid=" + encodeURIComponent(oid)).then(function (res) {
      var d = res.body || {};
      if (!d.ok || !d.registered) return;
      try {
        sessionStorage.setItem("cred", JSON.stringify({
          code: d.credential_code || "",
          name: d.name || ""
        }));
      } catch (e) {}
      go("success");
    }).catch(function () {});
  }

  // ---- 后台 ----
  var ADMIN_TOKEN = null;
  var ACCOUNT = null;
  // 「完整信息」开关：开着才向接口要 ?full=1，姓名与手机号一起出原值；切页自动复位
  var SHOW_FULL_INFO = false;
  var WM_TIMER = null;         // 水印每分钟刷新时间戳
  var HIDE_TIMER = null;       // 页面隐藏计时：超时自动收回完整信息
  var SESSION_KEY = "adm_session";
  var CUR_TAB = "overview";
  var AD_TABS = {
    overview: ["工作台", "活动整体情况与现场签到控制"],
    stats: ["数据统计", "访问 UV/PV、渠道来源、设备分布与转化漏斗"],
    roster: ["报名名单", "全部报名记录、签到状态与来源渠道"],
    cards: ["领卡行为", "点击领取礼物 / 点击开卡 的行为留痕"],
    checkins: ["签到流水", "现场签到记录，按时间倒序"],
    materials: ["推广二维码", "通用报名码 / 渠道码 / 通用核销码，扫码与报名归因"],
    bgm: ["背景音乐", "用户端背景音乐的开关与曲目更换"],
    logs: ["操作审计", "管理与导出动作留痕（仅管理员可见）"],
    accounts: ["账号管理", "管理员账号、权限与登录密码"],
    staff: ["现场工作人员", "可辅助签到人员、微信绑定与专属核销凭证"]
  };
  // 顶部「显示完整信息 / 导出」只在三张数据表页出现，并各自控制本页
  var TAB_OPS = {
    roster: { exportPath: "/export", exportText: "导出名单 CSV" },
    cards: { exportPath: "/admin/card-actions/export", exportText: "导出行为记录" },
    checkins: { exportPath: "/admin/checkins/export", exportText: "导出签到流水" }
  };
  // 分页状态：后台各表独立，默认 20 条/页，可切 50/100
  var PG = {
    roster: { page: 1, size: 20, total: 0, q: "" },
    logs: { page: 1, size: 20, total: 0 },
    checkins: { page: 1, size: 20, total: 0 },
    cards: { page: 1, size: 20, total: 0 }
  };

  function isAdmin() { return !!(ACCOUNT && ACCOUNT.role === "admin"); }
  function canFullPhone() { return !!(ACCOUNT && ACCOUNT.can_full_phone); }
  function canExport() { return !!(ACCOUNT && ACCOUNT.can_export); }

  function saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: ADMIN_TOKEN, account: ACCOUNT }));
    } catch (e) {}
  }
  function readSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }

  // 后台请求统一带 token；会话过期（401）直接退回登录页，避免页面停在空白
  function apiAdmin(path) {
    var sep = path.indexOf("?") >= 0 ? "&" : "?";
    return api(path + sep + "token=" + encodeURIComponent(ADMIN_TOKEN)).then(function (res) {
      if (res.status === 401) kickToLogin();
      return res;
    });
  }
  function kickToLogin() {
    ADMIN_TOKEN = null; ACCOUNT = null; clearSession();
    var p = $("#admin-panel"), l = $("#admin-login-wrap");
    if (p) p.style.display = "none";
    // flex 是 .ad-login-wrap 的居中前提；写成 block 会把登录框顶到左上角
    if (l) l.style.display = "flex";
    var f = $("#admin-login");
    if (f) { f.reset(); if (f.password) f.password.value = ""; }
    var m = $("#admin-msg"); if (m) m.textContent = "登录已失效，请重新登录";
    var ops = $("#ad-top-ops"); if (ops) ops.style.display = "none";
    stopWatermark();
    window.scrollTo(0, 0);
  }

  // 权限落到界面：非管理员看不到操作日志与账号管理；无权限看不到看全号/导出
  function applyPerms() {
    $all(".admin-only").forEach(function (el) { el.style.display = isAdmin() ? "" : "none"; });
    // 分组标题跟着组内可见项走：非管理员时「系统」组只剩修改密码、其它组可能整组空，
    // 留着空标题会让侧边栏出现悬空的「系统」字样
    $all(".ad-nav-group").forEach(function (g) {
      var any = false, n = g.nextElementSibling;
      while (n && !n.classList.contains("ad-nav-group")) {
        if (n.classList.contains("ad-nav-item") && n.style.display !== "none") { any = true; break; }
        n = n.nextElementSibling;
      }
      g.style.display = any ? "" : "none";
    });
    var pt = $("#phone-toggle"), ex = $("#admin-export");
    if (pt) pt.style.display = canFullPhone() ? "" : "none";
    if (ex) ex.style.display = canExport() ? "" : "none";
    // 数据统计页的两个导出按钮走同一套 can_export 权限，后端也会再校验一次
    var exSum = $("#ds-exp-summary"), exEvt = $("#ds-exp-events");
    if (exSum) exSum.style.display = canExport() ? "" : "none";
    if (exEvt) exEvt.style.display = canExport() ? "" : "none";
    if (!canFullPhone()) {
      SHOW_FULL_INFO = false;
      if (pt) pt.textContent = "显示完整信息";
    }
    var who = $("#ad-who");
    if (who && ACCOUNT) {
      who.textContent = ACCOUNT.username + " · " +
        (ACCOUNT.is_super ? "超级管理员" : (ACCOUNT.role === "admin" ? "管理员" : "普通用户"));
    }
  }

  // ---- 账号水印：全屏平铺「账号 + 时间」，截图可溯源到人 ----
  function wmStamp() {
    var d = new Date(), p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }