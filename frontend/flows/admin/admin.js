  function renderWatermark() {
    var el = $("#ad-watermark");
    if (!el || !ACCOUNT) return;
    var text = ACCOUNT.username + " · " + wmStamp();
    var W = 152, H = 82;   // 一屏约 115 个水印单元（1440×1000），密度翻倍
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">' +
      '<text x="12" y="56" font-size="11" font-family="-apple-system,BlinkMacSystemFont,PingFang SC,sans-serif"' +
      ' fill="#0f3d43" fill-opacity="0.22" transform="rotate(-24 12 56)">' + esc(text) + '</text></svg>';
    el.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
    el.style.backgroundRepeat = "repeat";
    el.style.backgroundSize = W + "px " + H + "px";
    el.classList.add("on");
  }
  function startWatermark() {
    renderWatermark();
    if (WM_TIMER) clearInterval(WM_TIMER);
    WM_TIMER = setInterval(renderWatermark, 60000);   // 时间戳刷新，截图可定位到分钟
  }
  function stopWatermark() {
    if (WM_TIMER) { clearInterval(WM_TIMER); WM_TIMER = null; }
    var el = $("#ad-watermark");
    if (el) { el.classList.remove("on"); el.style.backgroundImage = ""; }
  }

  // 人离开屏幕：隐藏超过 2 分钟自动收回「完整信息」并重载当前表，避免全名全号留在屏幕上
  function watchVisibility() {
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        HIDE_TIMER = setTimeout(function () {
          if (!SHOW_FULL_INFO) return;
          SHOW_FULL_INFO = false;
          var pt = $("#phone-toggle");
          if (pt) pt.textContent = "显示完整信息";
          if (CUR_TAB === "roster") loadRoster();
          else if (CUR_TAB === "cards") loadCardActions();
          else if (CUR_TAB === "checkins") loadCheckins();
        }, 120000);
      } else if (HIDE_TIMER) {
        clearTimeout(HIDE_TIMER); HIDE_TIMER = null;
      }
    });
  }

  function showPanel() {
    var wrap = $("#admin-login-wrap"), panel = $("#admin-panel");
    if (wrap) wrap.style.display = "none";
    if (panel) panel.style.display = "grid";
    applyPerms();
    initPurgeBtn();
    startWatermark();
    switchTab("overview");
    loadAdmin();
  }

  var PURGE_ENV_ASKED = false;   // 环境标识只补取一次，避免接口异常时反复重试

  // 测试环境专用工具：右下角固定「清除测试数据」。
  // 显示条件＝后端 /config 声明的 env 非 prod ＋ 当前是管理员；生产即使误点也无效（后端 403）。
  // 单一依据是后端：不按 URL 猜环境，按 IP/端口直连测试机时也不会误判。
  function isStagingEnv() { return !!CONFIG.env && CONFIG.env !== "prod"; }
  function initPurgeBtn() {
    var btn = $("#ad-purge-btn");
    if (!btn) return;
    // 环境标识来自 /config；后台可能在 config 返回前就恢复登录，因此取不到时补取一次
    if (CONFIG.env == null) {
      if (PURGE_ENV_ASKED) return;
      PURGE_ENV_ASKED = true;
      loadConfig().then(initPurgeBtn);
      return;
    }
    if (!isAdmin() || !isStagingEnv()) { btn.hidden = true; return; }
    btn.hidden = false;
    if (btn.getAttribute("data-bound") === "1") return;
    btn.setAttribute("data-bound", "1");
    var armed = false, timer = null;
    function reset() {
      armed = false;
      clearTimeout(timer);
      btn.classList.remove("armed");
      btn.disabled = false;
      btn.textContent = "清除测试数据";
    }
    btn.addEventListener("click", function () {
      if (!armed) {
        // 第一下只进入待确认态；5 秒内不点第二下自动复原，避免误触
        armed = true;
        btn.classList.add("armed");
        btn.textContent = "再点一次确认清除";
        timer = setTimeout(reset, 5000);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      btn.textContent = "清除中…";
      postJ("/admin/dev/purge-test-data", { token: ADMIN_TOKEN, confirm: "PURGE_TEST_DATA" })
        .then(function (res) {
          reset();
          if (res.body && res.body.ok) {
            toast("已清除测试数据 " + (res.body.total || 0) + " 条");
            loadAdmin();                       // 刷新面板上的数字与列表
            if (CUR_TAB === "logs") loadLogs();
          } else {
            toast((res.body && res.body.detail) || "清除失败");
          }
        })
        .catch(function () { reset(); toast("网络异常，清除未执行"); });
    });
  }

  // 刷新页面恢复登录：本地有会话就直接进面板，再用 /admin/me 校验一次
  function restoreSession() {
    var d = readSession();
    if (!d || !d.token) return false;
    ADMIN_TOKEN = d.token; ACCOUNT = d.account;
    showPanel();
    apiAdmin("/admin/me").then(function (res) {
      if (!res.body.ok) { kickToLogin(); return; }
      ACCOUNT = res.body.account; saveSession(); applyPerms();
      // 直达 #/admin/bgm 时首屏那次加载被跳过了，这里补上
      if (CUR_TAB === "bgm" && BGM_RELOAD) BGM_RELOAD();
    });
    return true;
  }

  function switchTab(name) {
    // 旧深链兼容：3.6 P2 把「平台设置」拆成「活动能力与成员」+「平台风控」，
    // 拆前存下的 ?tab=platform 书签还落在这一页，直接重定向到活动级那半。
    if (name === "platform") name = "actperm";
    var prevTab = CUR_TAB;
    CUR_TAB = name;
    // 换页即复位：看全号只对当时那一页生效，避免切页后满屏全号被截图带走
    if (prevTab !== name && SHOW_FULL_INFO) {
      SHOW_FULL_INFO = false;
      var pBtn = $("#phone-toggle");
      if (pBtn) pBtn.textContent = "显示完整信息";
    }
    $all(".ad-tab").forEach(function (t) { t.classList.remove("on"); });
    var sec = $("#tab-" + name); if (sec) sec.classList.add("on");
    $all(".ad-nav-item").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-tab") === name);
    });
    var meta = AD_TABS[name] || ["工作台", ""];
    var ti = $("#ad-page-title"), su = $("#ad-page-sub");
    if (ti) ti.textContent = meta[0];
    if (su) su.textContent = meta[1];

    // 背景音乐分区：进来才拉状态。render() 会早于登录态恢复触发一次，
    // 此时交给 load() 内部判断直接跳过，恢复会话后再补一次。
    if (name === "bgm" && BGM_RELOAD) BGM_RELOAD();

    var ops = $("#ad-top-ops"), opCfg = TAB_OPS[name];
    if (ops) ops.style.display = opCfg ? "flex" : "none";
    var ex = $("#admin-export");
    if (ex && opCfg) ex.textContent = opCfg.exportText;
    applyPerms();
    if (ops && opCfg) ops.style.display = (canFullPhone() || canExport()) ? "flex" : "none";

    // 现场用，切页即取最新数据，避免看到上一次登录时的旧快照
    if (!ADMIN_TOKEN) return;
    if (name === "overview") { loadWorkbench(); loadStats(); loadGate(); loadRoster(); }
    else if (name === "review") bindReviewPage();
    else if (name === "stats") { bindStatsPage(); loadStatsPage(); }
    else if (name === "roster") loadRoster();
    else if (name === "cards") loadCardActions();
    else if (name === "logs") { bindLogsPage(); loadLogs(); }
    else if (name === "checkins") loadCheckins();
    else if (name === "agenda") bindAgendaPage();
    else if (name === "speakers") bindSpeakersPage();
    else if (name === "material") bindMaterialPage();
    else if (name === "gifts") bindGiftPage();
    // 物料页三件事：固定兜底两码（loadMaterials/bindMaterials，已在 admin-utils.js 补齐）、
    // 投放码表格（loadMaterialCodes）、投放码按钮（bindMaterialsPage）。
    // 之前误把 loadMaterials 当"参与者端专属"删掉，导致报名/核销两个兜底码面板空白。
    else if (name === "materials") { loadMaterials(); bindMaterials(); bindMaterialsPage(); loadMaterialCodes(); }
    else if (name === "accounts") loadAccounts();
    // 机构三块（C 批）：总台与信息机构内所有管理者可见；授权矩阵挂在账号页里
    else if (name === "orghome") bindOrgHomePage();
    else if (name === "orginfo") bindOrgInfoPage();
    // 平台三块：活动管理（切活动/发布）、活动能力与成员、表单字段
    // 机构管理 / 平台风控单独列：只有平台超管能进（后端就是 platform_admin）
    else if (name === "orgs") bindOrgsPage();
    else if (name === "dashboard") bindDashboardPage();
    else if (name === "activities") bindActivitiesPage();
    else if (name === "actperm") { bindFeatures(); bindMembers(); }
    else if (name === "riskwords") bindRiskWords();
    else if (name === "form") bindFormPage();
    else if (name === "staff") loadAdminStaff();
  }

  // ---- 删除二次确认弹窗 ----
  // 所有删除类操作都先过这里：把「删掉什么、后果是什么」摆清楚再让人点确认，
  // 免得一句「确定吗？」把人点麻木了。Promise 化，调用方 .then(yes => ...)
  var CONFIRM_RESOLVE = null;
  function askConfirm(opts) {
    opts = opts || {};
    var m = $("#confirm-modal");
    if (!m) return Promise.resolve(window.confirm(opts.text || "确定吗？"));
    var t = $("#confirm-title"), x = $("#confirm-text"), ok = $("#confirm-ok");
    if (t) t.textContent = opts.title || "确认操作";
    if (x) x.textContent = opts.text || "";
    if (ok) {
      ok.textContent = opts.okText || "确认删除";
      // 只有删除类才用红色。发布/回草稿这类「重但可逆」的动作标红会误导，
      // 让人以为点下去会丢数据；danger:false 走常规主色。
      ok.className = "btn-primary block confirm-ok" + (opts.danger === false ? " safe" : "");
    }
    var msg = $("#confirm-msg"); if (msg) msg.textContent = "";
    m.style.display = "flex";
    return new Promise(function (resolve) { CONFIRM_RESOLVE = resolve; });
  }
  function closeConfirm(yes) {
    var m = $("#confirm-modal");
    if (m) m.style.display = "none";
    var fn = CONFIRM_RESOLVE; CONFIRM_RESOLVE = null;
    if (fn) fn(!!yes);
  }
  function bindConfirmModal() {
    var ok = $("#confirm-ok"), cancel = $("#confirm-cancel"), mask = $("#confirm-mask");
    if (ok) ok.addEventListener("click", function () { closeConfirm(true); });
    if (cancel) cancel.addEventListener("click", function () { closeConfirm(false); });
    if (mask) mask.addEventListener("click", function () { closeConfirm(false); });
  }

  function bindAdmin() {
    bindConfirmModal();
    var login = $("#admin-login");
    if (!login) return;
    login.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("#admin-msg");
      var username = (login.username.value || "").trim();
      var password = login.password.value || "";
      if (!username || !password) { if (msg) msg.textContent = "请输入账号和密码"; return; }
      if (msg) msg.textContent = "登录中…";
      postJ("/admin/login", { username: username, password: password }).then(function (res) {
        if (!res.body.ok || !res.body.token) {
          if (msg) msg.textContent = (res.body.detail || "账号或密码不正确");
          return;
        }
        ADMIN_TOKEN = res.body.token;
        ACCOUNT = res.body.account;
        saveSession();
        if (msg) msg.textContent = "";
        login.password.value = "";
        showPanel();
      }).catch(function () { if (msg) msg.textContent = "网络异常，请重试"; });
    });

    $all(".ad-nav-item").forEach(function (b) {
      b.addEventListener("click", function () {
        var t = b.getAttribute("data-tab");
        if (!t) return;
        if (t === "logs" && !isAdmin()) return;
        if (t === "accounts" && !isAdmin()) return;
        switchTab(t);
      });
    });
    // 总览页的快捷入口：跳到数据统计 tab
    $all("[data-goto-tab]").forEach(function (b) {
      b.addEventListener("click", function () { switchTab(b.getAttribute("data-goto-tab")); });
    });

    var lo = $("#admin-logout");
    if (lo) lo.addEventListener("click", function () {
      if (ADMIN_TOKEN) { postJ("/admin/logout", { token: ADMIN_TOKEN }).catch(function () {}); }
      ADMIN_TOKEN = null; ACCOUNT = null; clearSession();
      var pnl = $("#admin-panel"), lgw = $("#admin-login-wrap");
      if (pnl) pnl.style.display = "none";
      // 必须还原成 flex：.ad-login-wrap 靠 flex 居中，写成 block 会让登录框掉到左上角
      if (lgw) lgw.style.display = "flex";
      $("#ad-top-ops").style.display = "none";
      stopWatermark();
      login.reset();
      login.username.value = "";
      window.scrollTo(0, 0);
    });

    var pt = $("#phone-toggle");
    if (pt) pt.addEventListener("click", function () {
      if (!canFullPhone()) return;
      SHOW_FULL_INFO = !SHOW_FULL_INFO;
      pt.textContent = SHOW_FULL_INFO ? "隐藏完整信息" : "显示完整信息";
      // 只刷新当前页：开关控制的就是所在页面
      if (CUR_TAB === "roster") loadRoster();
      else if (CUR_TAB === "cards") loadCardActions();
      else if (CUR_TAB === "checkins") loadCheckins();
    });

    var ex = $("#admin-export");
    if (ex) ex.addEventListener("click", function () {
      var cfg = TAB_OPS[CUR_TAB];
      if (!cfg || !canExport()) return;
      window.open(API + cfg.exportPath + "?token=" + encodeURIComponent(ADMIN_TOKEN));
    });

    // 修改本人密码
    var pm = $("#pwd-modal"), pform = $("#pwd-form");
    var openPwd = function () { if (pm) pm.style.display = "flex"; var m = $("#pwd-msg"); if (m) m.textContent = ""; };
    var closePwd = function () { if (pm) pm.style.display = "none"; };
    var cp = $("#change-pwd"); if (cp) cp.addEventListener("click", openPwd);
    var pc = $("#pwd-close"); if (pc) pc.addEventListener("click", closePwd);
    var pmk = $("#pwd-mask"); if (pmk) pmk.addEventListener("click", closePwd);
    if (pform) pform.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("#pwd-msg");
      var np = pform.new_password.value || "", cf = pform.confirm.value || "";
      if (np.length < 8) { if (msg) msg.textContent = "新密码至少 8 位"; return; }
      if (np !== cf) { if (msg) msg.textContent = "两次输入的新密码不一致"; return; }
      postJ("/admin/password", {
        token: ADMIN_TOKEN,
        old_password: pform.old_password.value || "",
        new_password: np
      }).then(function (res) {
        if (res.body.ok) {
          if (msg) msg.textContent = "";
          closePwd(); pform.reset(); toast("密码已修改");
        } else {
          if (msg) msg.textContent = res.body.detail || "修改失败";
        }
      }).catch(function () { if (msg) msg.textContent = "网络异常，请重试"; });
    });

    // 新增账号
    var af = $("#acct-form");
    if (af) af.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("#acct-msg");
      postJ("/admin/accounts", {
        token: ADMIN_TOKEN,
        username: (af.username.value || "").trim(),
        password: af.password.value || "",
        role: af.role.value,
        can_full_phone: af.can_full_phone.checked,
        can_export: af.can_export.checked
      }).then(function (res) {
        if (res.body.ok) {
          if (msg) msg.textContent = "";
          af.reset(); toast("账号已创建"); loadAccounts();
        } else if (msg) msg.textContent = res.body.detail || "创建失败";
      }).catch(function () { if (msg) msg.textContent = "网络异常，请重试"; });
    });

    bindRosterSearch();
    bindRosterRows();
    bindAccountRows();
    watchVisibility();
  }
