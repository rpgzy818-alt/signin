  function bindBgm() {
    BGM_EL = document.getElementById("bgm");
    BGM_BTN = document.getElementById("bgmBtn");
    if (!BGM_EL || !BGM_BTN) return;
    BGM_EL.volume = 0;
    BGM_EL.addEventListener("playing", bgmPaint);
    BGM_EL.addEventListener("pause", bgmPaint);
    BGM_BTN.addEventListener("click", function (e) {
      e.stopPropagation();
      if (BGM_EL.paused) bgmPlay(); else BGM_EL.pause();
    });
    // 首次交互兜底：iOS 微信里只有用户主动触摸后才允许出声
    var unlock = function () {
      document.removeEventListener("touchstart", unlock);
      document.removeEventListener("click", unlock);
      applyBgm();
    };
    document.addEventListener("touchstart", unlock, { passive: true });
    document.addEventListener("click", unlock);
    bgmPaint();
  }

  // ---- 路由 ----
  // 默认落地＝活动介绍页（H5 首页）；报名页为显式 #/signup
  var ROUTE_VIEW = { "": "view-intro", "intro": "view-intro", "event": "view-event",
    "signup": "view-signup",
    "success": "view-success",
    "checkin": "view-checkin",
    "walkin": "view-walkin", "verify": "view-verify", "admin": "view-admin",
    "status": "view-status", "staff-bind": "view-staff-bind",
    "query": "view-query",
    // 机构入口页（RD-13）：只有「机构域名根路径」与 ?org=<短码> 两条入口，
    // 正常活动流里没有任何一处跳到这里——它是门面，不是流程中的一页。
    "org": "view-org",
    // 站点不存在：/config 返回 404 时落到这里（写错的子域、已归档活动）。
    // 不给空白报名页——访客分不清「站点坏了」和「自己被骗了」。
    "vanish": "view-vanish" };
  function currentRoute() {
    var h = location.hash.replace(/^#\/?/, "").split("?")[0];   // 去掉 ?code= 之类的参数
    h = h.split("/")[0];                                        // 支持 #/admin/roster 这类子路径
    return ROUTE_VIEW[h] ? h : "";
  }
  // 读 hash 里的查询参数，如 #/verify?code=ABC
  function hashParam(name) {
    var m = location.hash.match(new RegExp("[?&]" + name + "=([^&]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }
  // iOS 微信内页内跳转不写历史，微信就不会在底部绘制「< >」进退条；
  // 代价是系统返回失效，改由品牌条左侧的箭头兜底。安卓保持原样，系统返回照常可用。
  var IS_IOS_WX = /iPhone|iPad|iPod/i.test(navigator.userAgent || "")
    && /MicroMessenger/i.test(navigator.userAgent || "");
  var BACK_TO = { event: "intro", signup: "event" };   // 显示返回的页面 → 返回目标

  // 活动页两个数字的跳数：进页面后从 0 数到目标值。
  // 微信里 rAF 在省电模式/后台会被降频甚至停摆，所以用 setInterval + 终值兜底，
  // 保证「一定停在 50 和 1000」，不会卡在 37 这种半截数字。
  var EV_NUM_TIMER = null;
  function runEventNums() {
    var els = $all("#view-event .ev-n");
    if (!els.length) return;
    if (EV_NUM_TIMER) { clearInterval(EV_NUM_TIMER); EV_NUM_TIMER = null; }
    els.forEach(function (el) { el.textContent = "0"; });
    var t0 = Date.now(), DUR = 900;
    EV_NUM_TIMER = setInterval(function () {
      var p = Math.min(1, (Date.now() - t0) / DUR);
      var k = 1 - Math.pow(1 - p, 3);                 // easeOutCubic：前快后慢，收得稳
      els.forEach(function (el) {
        var to = parseInt(el.getAttribute("data-to"), 10) || 0;
        el.textContent = Math.round(to * k);
      });
      if (p >= 1) {
        clearInterval(EV_NUM_TIMER); EV_NUM_TIMER = null;
        els.forEach(function (el) { el.textContent = el.getAttribute("data-to"); });
      }
    }, 16);
  }

  // data-go 会写成 "/card"，统一去掉前导斜杠，否则拼出 #//card 导致路由失效
  function go(route) {
    var h = "#/" + String(route || "").replace(/^\/+/, "");
    if (IS_IOS_WX) {
      // replaceState 在部分微信内核会抛异常，兜底回原写法（条会回来，但功能不坏）
      try {
        history.replaceState(null, "", h);
        render();
        // replaceState 不触发 hashchange，boot 里那条 loadState→routeByState 的重绘
        // 等不来。凡是「内容要按接口状态画」的页面，就得在这里就地补一次，
        // 否则停在静态加载态（已签到用户跳状态页，标题一直卡在「状态查询中」）。
        // 只在 ME_STATE 已有值时才重绘：首屏还没取到时保持加载态，等 routeByState 纠正，
        // 免得先闪一下「未报名」再跳走。
        if (route === "status" && ME_STATE) renderStatus();
        return;
      } catch (e) {}
    }
    location.hash = h;
  }
  var PREV_ROUTE = "";        // 上一次停留的页面，供「返回」用
  var LAST_ROUTE = "";        // 路由变化前所在页，用于表单放弃埋点
  function render() {
    var route = currentRoute();
    // 陌生 hash 一律当首页处理（只改视图，不动地址栏——replaceState 在部分
    // 微信内置浏览器里会抛异常，且清 hash 会再触发一次 hashchange，得不偿失）
    if (route && !ROUTE_VIEW[route]) route = "";
    var viewId = ROUTE_VIEW[route] || "view-intro";
    $all(".view").forEach(function (v) { v.classList.remove("active"); });
    var view = $("#" + viewId); if (view) view.classList.add("active");
    document.body.setAttribute("data-route", route || "intro");
    // 品牌条返回：仅 iOS 微信、且当前页有明确上一页时出现
    var backTo = IS_IOS_WX ? (BACK_TO[route] || "") : "";
    document.body.setAttribute("data-back", backTo ? "1" : "0");
    var bb = $("#brandBack");
    if (bb) bb.setAttribute("data-back-to", backTo);
    // 浏览器标题按场景切换：后台是系统名，前台是活动名
    document.title = route === "admin"
      ? "签到会 · 活动报名与签到"
      : (EVT && EVT.title ? EVT.title : document.title);
    // 进入成功页：凭证码 + 领卡引导一起铺。
    // 领卡引导原只挂在 routeByState 的「已报名」分支上，而 iOS 微信的 go() 走
    // history.replaceState（不触发 hashchange），也就等不到 loadState→routeByState
    // 那次重绘 —— 结果是首次跳进来只有凭证、CTA 整块空白，刷新一次才补齐。
    // 这里直接铺：内容是静态的，不依赖接口。bindGiftRows 用 onclick 赋值，
    // 之后 routeByState 再重绘一遍也不会叠事件。
    if (route === "success") { renderSuccess(); renderSuccessCta(); }
    // P6 查询页：配置到位后按需渲染（iOS 微信 replaceState 不触发 hashchange）
    if (route === "query") renderQuery();
    // 改信息模式同样要就地处理：iOS 的 go() 不触发 hashchange，等不到
    // routeByState，表单会既不预填也不认 edit 标记（提交时当成新报名）。
    // EDIT_LOADED 保证只拉一次数据，重复调用安全。
    if (route === "signup" && hashParam("edit") === "1") applyEditMode();
    if (route === "event") runEventNums();      // 两个数字从 0 数上来
    // 空 hash 也是首页（viewId 兜底到 view-intro），原来只在 route==="intro" 时算，
    // 直接打开链接时 fitIntro 不跑，PC 宽屏字号按 100vw 算、整屏文字重叠
    if (route === "intro" || !route) requestAnimationFrame(fitIntro);   // 舞台宽只有显示后才能量到
    // 支持 #/admin/roster 直达指定分区（方便分享与排查）
    if (route === "admin") {
      var sub = (location.hash.split("/")[2] || "").split("?")[0];
      if (sub) switchTab(sub);
    }
    if (route) PREV_ROUTE = route;
    // 页面内跳到核销页时也把凭证码带上（扫码进来是整页加载，走 bindVerify 那条）
    if (route === "verify") {
      var preCode = hashParam("code"), vf = $("#verify-form");
      if (preCode && vf && vf.code && !vf.code.value) vf.code.value = preCode;
    }
    // 状态页与 CTA 卡片取代自动弹层：现场签到不再被弹层打断
    // 核销界面只对已绑定工作人员开放；身份尚未判定时先不露出这一页
    if (route === "verify" && !(STAFF_INFO && STAFF_INFO.is_staff)) {
      var vv = $("#view-verify"); if (vv) vv.classList.remove("active");
    }
    // 运营侧页面（后台 / 核销 / 人员绑定）不计入用户统计：
    // 后台是运营自己在点，记进去只会把 UV 抬高、把转化率稀释。
    if (route !== "admin" && route !== "verify" && route !== "staff-bind") {
      var pvRoute = currentRoute() || "intro";
      trackPage(pvRoute);        // 漏斗用：会话内每视图一次
      trackPV(pvRoute);          // PV 用：每次渲染一次（800ms 节流防 replaceState 重复）
    }
    LAST_ROUTE = route || "intro";
    window.scrollTo(0, 0);
  }

  // 报名来源：与后台《报名名单》来源列的四类口径一一对应。
  // 物料码 URL 带 from=material；微信分享由 SHARE.param 自动带 from=share；
  // 两者都没有就是裸的活动链接。现场补录不经过这里，后端直接写「现场补录」。
  function sourceChannel() {
    var f = getParam("from") || "";
    // 分享落地时 boot 会把 from 存进 sessionStorage，作为跳转丢参时的兜底
    try { if (!f) f = sessionStorage.getItem("src") || ""; } catch (e) {}
    if (f === "material") return "物料扫码";
    if (f === "share") return "分享链接";
    return "活动链接";
  }

  // ---- 报名 ----
  // 字段定义全部来自 /form（见 form-render.js）。这里不再出现任何具体字段名：
  // 加一个字段只需要后台配，前端零改动——这也是 P3-b 的全部意义。
  var SU_STEPS = [];          // [{step, fields}]
  var SU_RENDERED = false;
  // 两步流程的页面态。字段值不存这里，统一在 DOM 的 input 上（见 form-render.js）
  var SU = { step: 1 };

  // core.js 的用户记录里要「已选几个意向方向」。保留这个出口、实现走 schema，
  // 否则运营把字段 key 改掉后那个埋点会静默变成 0，报表看不出问题但数字是错的。
  function checkedIntents() { return frSplit(frCollect()["intent"] || ""); }
  function collectIntent() { return checkedIntents().join("、"); }
  // 国际区号：聚焦清空默认 86 方便直接改，失焦空值回落 86；
  // 大陆号 11 位、海外号放宽到 15 位，输入框 maxlength 随区号切换。
  // 报名表与现场补录表共用这一套——两个表单都要能录境外号，规则不能各写一份，
  // 所以按 [data-cc] 遍历、自己往上找 form，不再写死 #signup-form。
  function bindCcInput() {
    $all("[data-cc]").forEach(function (cc) {
      if (cc.dataset.ccBound) return;
      var form = cc.closest ? cc.closest("form") : null;
      if (!form) return;
      cc.dataset.ccBound = "1";
      var isSignup = form.id === "signup-form";
      function syncPhoneLimit() {
        if (!form.elements.phone) return;
        form.elements.phone.maxLength = (cc.value.replace(/\D/g, "") || "86") === "86" ? 11 : 15;
      }
      // 草稿和进度条只属于报名表，补录表不该去动它们
      function afterChange() { if (isSignup) { saveDraft(); refreshProgress(); } }
      cc.addEventListener("focus", function () {
        var w = cc.closest(".cc-fld"); if (w) w.classList.add("focus");
        if (this.value === "86") this.value = "";
      });
      cc.addEventListener("blur", function () {
        var w = cc.closest(".cc-fld"); if (w) w.classList.remove("focus");
        if (!this.value.trim()) this.value = "86";
        syncPhoneLimit(); afterChange();
      });
      cc.addEventListener("input", function () {
        this.value = this.value.replace(/\D/g, "").slice(0, 5);
        syncPhoneLimit(); afterChange();
      });
      syncPhoneLimit();
    });
  }

  // 进度条：按当前可见字段算，跨两步累计。
  // 口径跟着 schema 走——运营加一个字段，分母自己会变，不用回来改代码。
  function refreshProgress() {
    var form = $("#signup-form"); if (!form || !SU_RENDERED) return;
    var p = frProgress(), n = p.done, total = p.total || 1;
    var pct = Math.round(n / total * 100);
    var bar = $("#su-bar"), txt = $("#su-step-pct");
    if (bar) bar.style.width = pct + "%";
    // 不暴露总项数：一上来写「共 10 项」是劝退不是激励。
    // 只报已完成，剩余感交给进度条本身表达。
    if (txt) {
      txt.textContent = n === 0 ? "待填写"
        : (pct >= 100 ? "已填完 · 100%" : "已填 " + n + " 项 · " + pct + "%");
    }
  }

  // 步骤文案跟着 schema 走：共几步由字段的 step 决定，不再写死「共 2 步」。
  // 第 1 步固定叫「基本信息」——姓名与手机号是硬约束，任何活动都在这步。
  function suStepLabel(n) {
    var total = Math.max(SU_STEPS.length || 0, 2);
    var title = n === 1 ? "基本信息" : (n === 2 ? "补充信息" : "补充信息");
    return "第 " + n + " 步 / 共 " + total + " 步 · " + title;
  }

  // 两步之间切换：当前 pane 左滑淡出、目标 pane 右滑淡入
  function goStep(n) {
    if (SU.step === n) return;
    var p1 = $("#su-pane1"), p2 = $("#su-pane2");
    if (!p1 || !p2) return;
    var out = n === 2 ? p1 : p2, into = n === 2 ? p2 : p1;
    out.classList.add("out");
    setTimeout(function () {
      out.hidden = true;
      out.classList.remove("out");
      into.hidden = false;
      into.classList.remove("in");
      void into.offsetWidth;          // 强制重排，否则动画不会重播
      into.classList.add("in");
      into.scrollTop = 0;
      SU.step = n;
      var nameEl = $("#su-step-name"), btn = $("#su-submit"), pr = $("#privacy-row");
      if (nameEl) nameEl.textContent = suStepLabel(n);
      if (btn) {
        // 关键：上一步提交成功后按钮仍停在 disabled（lockBtn 设的），
        // 切步骤时必须恢复，否则第二步点了没反应、请求根本发不出去
        btn.disabled = false;
        btn.textContent = n === 2
          ? (hashParam("edit") === "1" ? "保存并返回" : "提交报名")
          : "保存，下一步";
      }
      // 隐私勾选只在第一步出现：勾过一次即代表同意，第二步不重复要求
      if (pr) pr.style.display = n === 2 ? "none" : "";
      var msg = $("#signup-msg"); if (msg) msg.textContent = "";
      refreshProgress();
    }, 160);
  }
  var DRAFT_KEY = "signup_draft";
  // 草稿整份存：{v: {字段: 值}, step}。不再逐个字段名读写，
  // 否则加一个字段就要在存和取两处各补一行，漏了就是「填完刷新没了」。
  function saveDraft() {
    if (!SU_RENDERED) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        v: frCollect(), step: SU.step, t: Date.now()
      }));
    } catch (e) {}
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }
  function restoreDraft() {
    if (!SU_RENDERED) return;
    try {
      var raw = localStorage.getItem(DRAFT_KEY); if (!raw) return;
      var d = JSON.parse(raw);
      if (!d || Date.now() - (d.t || 0) > 24 * 3600 * 1000) { clearDraft(); return; }
      if (d.v) frFill(d.v);
      if (d.step === 2) goStep(2);
    } catch (e) {}
  }
  // ---- 自定义下拉：不用系统原生 select ----
  // 鸿蒙 / 安卓 WebView 会用各自的滚轮弹层渲染 select，样式不可控、字号还会被系统放大。
  // 改成页面内选项层：hidden input 保留原 name，表单取值与草稿逻辑完全不用改。
  //
  // 选项来源：报名页读 schema（运营改选项即时生效）；现场补录表还没迁到 schema，
  // 用下面这张兜底表。等 walkin 也走 schema 后这张表可以删掉。
  var FALLBACK_PICK = {
    gender: { title: "性别", options: ["男", "女"] }
  };
  function pickMeta(name) {
    var f = frByName(name);
    if (f) return { title: f.label, options: f.options || [] };
    return FALLBACK_PICK[name] || null;
  }
  function syncSignupLabels() {
    $all(".fld-pick").forEach(function (btn) {
      var name = btn.getAttribute("data-pick");
      var form = btn.closest ? btn.closest("form") : $("#signup-form");
      var field = form && form.elements ? form.elements[name] : null;
      var v = field ? field.value : "";
      var box = btn.parentNode;
      // 报名表用 .fld，现场补录用 .wk-pick（标签与按钮结构不同），两者都要打标
      if (box && (box.classList.contains("fld") || box.classList.contains("wk-pick"))) {
        box.classList.toggle("has-val", !!v);
      }
      var txt = btn.querySelector(".fld-pick-v");
      if (txt) txt.textContent = v || "请选择";
    });
  }
  function openPick(btn) {
    var name = btn.getAttribute("data-pick");
    var m = $("#pick-modal"), box = $("#pick-options"), t = $("#pick-title");
    // 表单必须从按钮自己往上找。写死 #signup-form 时，现场补录页（#walkin-form）
    // 的性别会写进报名表那份 hidden，补录表始终为空——界面上选完仍显示「请选择」，
    // 提交上去也是空值。syncSignupLabels 早就按 closest("form") 取值，两边口径要对齐。
    var form = (btn.closest && btn.closest("form")) || $("#signup-form");
    var isSignup = !!(form && form.id === "signup-form");
    if (!m || !box || !form || !form.elements[name]) return;
    // 年月类型走两级选择（先年再月），复用同一个弹层
    var f = frByName(name);
    if (f && f.type === "date") { openDatePicker(form, f); return; }
    var meta = pickMeta(name);
    if (!meta) return;
    if (t) t.textContent = meta.title;
    var cur = form.elements[name].value || "";
    box.innerHTML = meta.options.map(function (o) {
      return '<button type="button" class="pick-opt' + (o === cur ? " on" : "") +
        '" data-val="' + esc(o) + '">' + esc(o) + "</button>";
    }).join("");
    m.style.display = "flex";
    box.onclick = function (e) {
      var b = e.target && e.target.closest ? e.target.closest(".pick-opt") : null;
      if (!b) return;
      form.elements[name].value = b.getAttribute("data-val");
      m.style.display = "none";
      syncSignupLabels();
      try { form.dispatchEvent(new Event("change")); } catch (err) {}
      // 草稿与进度条只属于报名表；补录表跑一遍会白写一份草稿，也会去改报名页的进度
      if (isSignup) { frApplyVisibility(); saveDraft(); refreshProgress(); }
      trackEvent("field_fill", isSignup ? "signup" : "walkin", { field: name, value_len: 1 });
    };
  }

  // 年月两级选择：先选年、再选月，复用同一个弹层连续选两次，不额外加弹窗。
  // 年份范围取自 schema 的 min_year / max_year，运营配什么就限制到什么。
  function openDatePicker(form, f) {
    var m = $("#pick-modal"), box = $("#pick-options"), t = $("#pick-title");
    if (!m || !box || !form) return;
    var input = form.elements[f.key];
    if (!input) return;
    var mt = String(input.value || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    var y = mt ? Number(mt[1]) : new Date().getFullYear();
    var mo = mt ? Number(mt[2]) : new Date().getMonth() + 1;
    var lo = f.min_year || 2000;
    var hi = f.max_year || (new Date().getFullYear() + 2);

    function showYears() {
      if (t) t.textContent = f.label + " · 选择年份";
      var html = "";
      for (var i = hi; i >= lo; i--) {
        html += '<button type="button" class="pick-opt' + (i === y ? " on" : "") +
          '" data-y="' + i + '">' + i + " 年</button>";
      }
      box.innerHTML = html;
      box.scrollTop = 0;
      box.onclick = function (e) {
        var b = e.target.closest ? e.target.closest(".pick-opt") : null;
        if (!b) return;
        y = Number(b.getAttribute("data-y"));
        showMonths();
      };
    }
    function showMonths() {
      if (t) t.textContent = y + " 年 · 选择月份";
      var html = "";
      for (var i = 1; i <= 12; i++) {
        html += '<button type="button" class="pick-opt' + (i === mo ? " on" : "") +
          '" data-m="' + i + '">' + i + " 月</button>";
      }
      box.innerHTML = html;
      box.scrollTop = 0;
      box.onclick = function (e) {
        var b = e.target.closest ? e.target.closest(".pick-opt") : null;
        if (!b) return;
        mo = Number(b.getAttribute("data-m"));
        input.value = y + " 年 " + mo + " 月";
        m.style.display = "none";
        syncSignupLabels();
        saveDraft();
        refreshProgress();
        trackEvent("field_fill", "signup", { field: f.key, value_len: 1 });
      };
    }
    showYears();
    m.style.display = "flex";
  }
  // 幂等：渲染是异步的（等 /form 返回），渲染完要再调一次给新按钮挂监听；
  // 不加标记会把现场补录表那几个按钮重复绑定，点一次弹两次
  function bindPick() {
    $all("[data-pick]").forEach(function (b) {
      if (b.dataset.pickBound) return;
      b.dataset.pickBound = "1";
      b.addEventListener("click", function () { openPick(b); });
    });
    var m = $("#pick-modal"), c = $("#pick-close"), mask = $("#pick-mask");
    var close = function () { if (m) m.style.display = "none"; };
    if (m && !m.dataset.closeBound) {
      m.dataset.closeBound = "1";
      if (c) c.addEventListener("click", close);
      if (mask) mask.addEventListener("click", close);
    }
  }

  // 「修改信息」模式：由路由触发（点成功页的修改链接只是改 hash，
  // bindSignup 只在页面加载时跑一次，挂在那里永远不会执行）
  var EDIT_LOADED = false;
  function resetSignupMode() {
    EDIT_LOADED = false;
    var form = $("#signup-form");
    if (!form) return;
    // 上次可能停在第二步（补完补充信息就离开），再进来要回到第一步
    var p1 = $("#su-pane1"), p2 = $("#su-pane2");
    if (p1 && p2 && SU.step !== 1) {
      p1.hidden = false; p2.hidden = true;
      p1.classList.remove("in"); p2.classList.remove("out");
      p1.scrollTop = 0;
      SU.step = 1;
      var nameEl = $("#su-step-name");
      if (nameEl) nameEl.textContent = suStepLabel(1);
      var pr = $("#privacy-row"); if (pr) pr.style.display = "";
    }
    var sub = $("#su-submit");
    if (sub) {
      var open = CONFIG.registration_open && !CONFIG.event_ended;
      sub.textContent = open ? (SU.step === 2 ? "提交报名" : "保存，下一步") : "报名已截止";
      sub.disabled = !open;
    }
    // 配置是异步取回来的，bindSignup 初次检查时可能还是默认值；
    // 路由纠正时再补一次说明，避免只把按钮置灰却不告诉用户为什么、能去哪。
    var msg = $("#signup-msg");
    if (msg) msg.textContent = CONFIG.event_ended
      ? "本场活动已结束，线上报名已关闭"
      : (!CONFIG.registration_open ? "报名已截止，可到签到台由工作人员现场登记" : "");
  }
  function applyEditMode() {
    var form = $("#signup-form");
    if (!form) return;
    // 表单还没渲染完就返回，不要往下走：路由比 /form 先到是常态，
    // 这里若继续执行会把 EDIT_LOADED 置 true，等渲染完再回来就什么都填不上了
    if (!SU_RENDERED) return;
    // 改信息固定从第一步起。原来按「第二步是否填过」决定落点
    // （`if (!d.current_status) goStep(2)`），用户点「点此修改」本是冲着基础
    // 信息去的，被直接甩到第二步还得自己往回翻。
    // 放在 EDIT_LOADED 之前：表单已预填过、重复点进来时也要回到第一步。
    goStep(1);
    var sub = $("#su-submit");
    if (sub) { sub.textContent = "保存，下一步"; sub.disabled = false; }
    if (EDIT_LOADED) return;
    EDIT_LOADED = true;
    clearDraft();
    api("/me?full=1&openid=" + encodeURIComponent(getOpenid() || "")).then(function (r) {
      var d = r.body || {};
      if (!d.ok || !d.registered) return;
      // 按 schema 组装回填值：core 字段与接口同名字段，自定义字段由 /me 展开在顶层，
      // 所以这里只按 key 取，不需要知道具体有哪些字段。
      var vals = {};
      FR_FIELDS.forEach(function (f) {
        if (f.type === "phone") {
          vals[f.key] = d.phone || "";
          vals["phone_code"] = d.phone_code || "86";
          return;
        }
        var v = d[f.key];
        vals[f.key] = v == null ? "" : v;
      });
      frFill(vals);
    }).catch(function () { EDIT_LOADED = false; });
  }

  // 拉 schema 并渲染。接口抖动时退化成空表单而不是空白页——至少给出下一步指引，
  // 而不是让人对着一个没有输入框的页面刷新。
  function loadFormSchema() {
    api("/form").then(function (r) {
      var b = (r && r.body) || {};
      renderSignupForm(b.ok && b.steps && b.steps.length ? b.steps : null);
    }).catch(function () { renderSignupForm(null); });
  }

  function renderSignupForm(steps) {
    var p1 = $("#su-pane1"), p2 = $("#su-pane2");
    if (!p1 || !p2) return;
    // 超过 2 步的字段并到第 2 步：报名表三步以上体验本来就差，
    // 这里明确收口，不做无限分页。第 1 步恒定是基本信息（姓名与手机号必填）。
    var byStep = { 1: [], 2: [] };
    (steps || []).forEach(function (s) {
      var target = (Number(s.step) || 1) >= 2 ? 2 : 1;
      byStep[target] = byStep[target].concat(s.fields || []);
    });
    SU_STEPS = [{ step: 1, fields: byStep[1] }, { step: 2, fields: byStep[2] }]
      .filter(function (s) { return s.fields.length > 0; });
    if (!SU_STEPS.length) SU_STEPS = [{ step: 1, fields: [] }];

    // 「返回上一步」是 pane2 的固定尾项，渲染会覆盖 innerHTML，先摘出来再放回去
    var back = $("#su-back");
    if (back && back.parentNode) back.parentNode.removeChild(back);

    frRender({ 1: p1, 2: p2 }, SU_STEPS);
    if (back) p2.appendChild(back);

    SU_RENDERED = true;
    // 默认单步活动：隐藏步骤条，按钮直接写「提交报名」——
    // 通用活动只有姓名/性别/手机号+3 项，全是 step=1，不该还能看到「第 1 步 / 共 2 步」
    var oneStep = SU_STEPS.length === 1;
    var stepsBar = document.querySelector("#signup-form .steps");
    if (stepsBar) stepsBar.style.display = oneStep ? "none" : "";
    var submitBtn = $("#su-submit");
    if (submitBtn && oneStep) submitBtn.textContent = "提交报名";
    bindPick();
    bindCcInput();
    frApplyVisibility();
    var nameEl = $("#su-step-name");
    if (nameEl) nameEl.textContent = suStepLabel(SU.step);
    restoreDraft();
    // 编辑模式：schema 就绪才能按字段回填
    if (hashParam("edit") === "1") applyEditMode();
  }

  function bindSignup() {
    var form = $("#signup-form");
    if (!form) return;
    // 表单结构由 /form 决定，先渲染再谈字段级行为（渲染前 form.elements 是空的）
    loadFormSchema();
    form.addEventListener("input", saveDraft);
    form.addEventListener("change", saveDraft);
    form.addEventListener("change", function () { syncSignupLabels(); refreshProgress(); });
    form.addEventListener("input", refreshProgress);

    var backBtn = $("#su-back");
    if (backBtn) backBtn.addEventListener("click", function () { goStep(1); });

    // 字段级填写率：只记字段名与长度，不记内容。
    // 用委托而不是遍历绑定——渲染是异步的，遍历那一刻字段还不存在。
    form.addEventListener("focusout", function (e) {
      var el = e.target;
      if (!el || !el.name || el.name === "privacy") return;
      if (!String(el.value || "").trim()) return;
      trackEvent("field_fill", "signup", { field: el.name, value_len: String(el.value).length });
    });

    function showClosed(detail) {
      var msg = $("#signup-msg");
      if (msg) msg.textContent = detail || "报名已截止，可到签到台由工作人员现场登记";
      var btn = $("#su-submit");
      if (btn) { btn.disabled = true; btn.textContent = "报名已截止"; }
    }
    function checkClosed() {
      if (CONFIG.event_ended) { showClosed("本场活动已结束，线上报名已关闭"); return true; }
      if (!CONFIG.registration_open) { showClosed(); return true; }
      return false;
    }
    checkClosed();

    function lockBtn(text) { var b = $("#su-submit"); if (b) { b.disabled = true; b.textContent = text; } }
    function unlockBtn() {
      var b = $("#su-submit"); if (!b) return;
      b.disabled = false;
      if (SU_STEPS.length === 1) b.textContent = "提交报名";
      else b.textContent = SU.step === 2
        ? (hashParam("edit") === "1" ? "保存并返回" : "提交报名")
        : "保存，下一步";
    }

    // 第一步：基本信息落库。这一步成功即视为报名完成（凭证码此时已生成），
    // 原地切到第二步补填信息——不跳页、不改 hash，只填到第一步也不影响签到。
    // 按 schema 生成提交体：core 字段走具名参数（后端有固定列，要索引/脱敏/算届），
    // 自定义字段装进 answers。不再逐字段拼对象——运营加一个字段不用改这里。
    function payloadFor(step, vals) {
      var out = {
        openid: ensureOpenid(),
        channel: sourceChannel(),
        source_code: matCode()      // 投放物料短码，后端会校验是否存在
      };
      var answers = {};
      var fields = (SU_STEPS[step - 1] || {}).fields || [];
      fields.forEach(function (f) {
        var v = vals[f.key];
        if (!f.core) {
          if (v !== "" && v != null) answers[f.key] = v;
          return;
        }
        if (f.type === "phone") {
          out.phone = v;
          out.phone_code = vals["phone_code"] || "86";
          return;
        }
        out[f.core] = v;
      });
      if (Object.keys(answers).length) out.answers = answers;
      return out;
    }

    // 按 core 取某个字段的值（key 可能被运营改过，不能直接 vals.name）
    function valOf(vals, coreName) {
      var f = null;
      FR_FIELDS.forEach(function (x) { if (x.core === coreName) f = x; });
      return f ? (vals[f.key] || "") : "";
    }

    function submitStep1() {
      var msg = $("#signup-msg");
      var vals = frCollect();
      var err = frValidate(1, vals);
      if (err) {
        msg.textContent = err.msg;
        trackEvent("form_error", "signup", { field: err.key });
        return;
      }
      if (!form.elements.privacy.checked) {
        msg.textContent = "请先勾选同意《个人信息处理说明》";
        trackEvent("form_error", "signup", { field: "privacy" });
        return;
      }
      var d = payloadFor(1, vals);
      d.privacy = true;

      lockBtn(SU_STEPS.length > 1 ? "已保存，正在进入下一步…" : "正在提交…");
      postResilient("/register", d).then(function (res) {
        if (!res) {
          unlockBtn();
          msg.textContent = "网络有点慢，请再点一次";
          trackEvent("signup_fail", "signup", { reason: "network" });
          return;
        }
        if (res.status >= 400 || !res.body.ok) {
          var detail = res.body.detail || "保存失败，请重试";
          msg.textContent = detail;
          trackEvent("signup_fail", "signup", { status: res.status, reason: detail.slice(0, 40) });
          if (res.status === 409 && /截止|结束/.test(detail)) showClosed(detail);
          else unlockBtn();
          return;
        }
        SIGNUP_DONE = true;
        sessionStorage.setItem("cred", JSON.stringify({
          code: res.body.credential_code, name: valOf(vals, "name")
        }));
        trackEvent("signup_submit", "signup", { status: res.body.status, step: 1 });
        msg.textContent = "";
        // 同一微信再次提交＝改信息：凭证码不变，只提示一句，不让人以为重报了一次
        if (res.body.status === "updated") toast("你已报名，信息已更新");
        else toast("信息已保存，现场可凭手机号签到");
        // 只有一步的活动：提交完直接进成功页，别切到一个空的分步页
        if (SU_STEPS.length > 1) goStep(2);
        else { clearDraft(); go("success"); }
      }).catch(function () {
        unlockBtn();
        msg.textContent = "网络有点慢，请再点一次";
        trackEvent("signup_fail", "signup", { reason: "network" });
      });
    }

    // 第二步：补充信息。第一步已报名成功，这一步失败不能把人卡住或假装报名失败，
    // 提示后仍进成功页，之后可从「信息填错了？点此修改」补填。
    function submitStep2() {
      var msg = $("#signup-msg");
      var vals = frCollect();
      var err = frValidate(2, vals);
      if (err) {
        msg.textContent = err.msg;
        toast(err.msg);
        trackEvent("form_error", "signup", { field: err.key });
        return;
      }
      lockBtn("正在提交…");
      postResilient("/profile", payloadFor(2, vals))
        .then(function (res) {
          if (!res || res.status >= 400 || !res.body.ok) {
            unlockBtn();
            msg.textContent = "补充信息没存上，可稍后在「修改信息」里补填";
            trackEvent("signup_fail", "signup", { reason: "profile" });
            setTimeout(function () { clearDraft(); go("success"); }, 1200);
            return;
          }
          trackEvent("signup_submit", "signup", { status: res.body.status, step: 2 });
          clearDraft();
          go("success");
        }).catch(function () {
          unlockBtn();
          msg.textContent = "网络有点慢，可稍后在「修改信息」里补填";
          setTimeout(function () { clearDraft(); go("success"); }, 1200);
        });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (checkClosed()) return;
      if (SU.step === 2) return submitStep2();
      return submitStep1();
    });
    $("#privacy-link").addEventListener("click", function (e) { e.preventDefault(); openPrivacy(); });
    $("#privacy-close").addEventListener("click", agreePrivacy);
    var pd = $("#privacy-decline"); if (pd) pd.addEventListener("click", declinePrivacy);
    // 点遮罩是「先不看」而不是「不同意」：只收起弹层，勾选状态原样留着，
    // 别让一次误触把已经勾好的同意抹掉
    var pm = $("#privacy-mask"); if (pm) pm.addEventListener("click", closePrivacy);
  }
  function openPrivacy() {
    var m = $("#privacy-modal"); if (m) m.style.display = "flex";
  }
  function closePrivacy() {
    var m = $("#privacy-modal"); if (m) m.style.display = "none";
  }
  // 协议弹层两条出口必须互斥：
  //   同意 → 勾上再关；不同意 → 关掉并把勾摘掉。
  // 只说「关闭」是不行的——之前勾过的人点完「不同意」，勾还留着，
  // 一提交等于默认同意了，两条路就白分了。
  function setPrivacyChecked(on) {
    var c = $("#signup-form input[name=privacy]");
    if (!c || c.checked === on) return;
    c.checked = on;
    // 走一遍冒泡的 change：勾选是表单状态的一部分，别绕过表单自己的变更链
    try { c.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
  }
  function agreePrivacy() {
    setPrivacyChecked(true);
    // 上一轮若因未勾选被拦过，提示要跟着撤掉，否则勾了还挂着红字
    var msg = $("#signup-msg"); if (msg && msg.textContent) msg.textContent = "";
    closePrivacy();
  }
  function declinePrivacy() {
    setPrivacyChecked(false);
    closePrivacy();
  }

  // ---- 成功页 ----
  // ---- 二维码：凭证码与现场物料码共用 ----
  function hasQr() { return typeof window.qrcode === "function"; }
  // 本站绝对地址：优先读站点配置（绑独立域名后路径推不出来），缺失才回落到当前目录。
  // 用于凭证二维码、物料码等「发出去就收不回」的链接，务必走这里。
  function siteUrl(hashPath) {
    var c = window.__SITE__ || {};
    var hp = String(hashPath || "");
    if (c.base) return String(c.base).replace(/\/+$/, "") + "/" + hp.replace(/^\/+/, "");
    var dir = location.pathname.replace(/[^\/]*$/, "");
    if (!dir || dir === "/") dir = "/";
    return location.origin + dir + hp;
  }
  function qrSvg(text, cell, margin) {
    var q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: cell || 6, margin: margin || 12 });
  }
  // 成功页凭证卡里的二维码：工作人员扫它直接进核销页，不用手输 8 位码
  // 二维码放大层：签到台人多、光线杂，让工作人员隔着一段距离也能扫
  function zoomSvg(svg) {
    if (!svg) return;
    var old = $("#u-zoom"); if (old) old.remove();
    var m = document.createElement("div");
    m.id = "u-zoom"; m.className = "u-zoom";
    var inner = document.createElement("div");
    inner.className = "u-zoom-box";
    var clone = svg.cloneNode(true);
    clone.setAttribute("class", "u-zoom-img");   // SVGElement.className 只读，必须用 setAttribute
    clone.setAttribute("style", "width:280px;height:280px;background:#fff");
    inner.appendChild(clone);
    var tip = document.createElement("p");
    tip.className = "u-zoom-tip";
    tip.textContent = "点任意处关闭";
    inner.appendChild(tip);
    m.appendChild(inner);
    m.onclick = function () { m.remove(); };
    document.body.appendChild(m);
  }
  function renderCredQr(code) {
    var box = $("#cred-qr");
    if (!box) return;
    if (!code || !hasQr()) { box.style.display = "none"; return; }
    box.innerHTML = qrSvg(siteUrl("#/verify?code=" + encodeURIComponent(code)), 4, 8) +
      '<span class="cred-qr-tip">到场出示 · 点击放大给工作人员扫</span>';
    box.style.display = "block";
    box.onclick = function () { zoomSvg(box.querySelector("svg")); };
  }

  // 只负责把凭证码写进页面：每次进成功页都要跑，
  // 否则「提交后跳转」这一下拿不到刚写进 sessionStorage 的值，凭证位一直是「—」。
  function renderSuccess() {
    var c = JSON.parse(sessionStorage.getItem("cred") || "{}");
    if (c.code) { $("#cred-code").textContent = c.code; }
    if (c.name) { $("#cred-name").textContent = c.name; }
    renderCredQr(c.code);
    // 数据叙事：把系统里的报名数变成一句能写进汇报的话，取不到就静默不显示。
    // 强制取一次最新值：提交完报名立刻进这一页，不能用缓存里的旧总数。
    publicNumbers(true).then(function (d) {
      if (d) showRank("#success-rank", "你是第 {n} 位报名的来宾", displaySignupNo(d.registered));
    });
    initAttachments(c.code);
    // 底部标识（原广告位）：体验版才有；非 trial 时 techBadgeHTML 返回空串，
    // 容器留空不占高度。放在这一页而不是写死在 HTML 里，是因为
    // 同一份静态产物要同时服务付费客户。
    var tb = $("#tech-badge");
    if (tb) tb.innerHTML = techBadgeHTML();
  }

  // ---- RD-04 报名附件：成功后按凭证码上传，图≤2、文档≤1、≤5M ----
  // 不进表单 schema（文件塞不进 JSON answers，且服务器无 python-multipart）。
  // 服务端按 registration_id 计数限流，前端这里只做展示与交互。
  var ATT_CODE = "";
  var ATT_LIMITS = { image: 2, document: 1 };

  function attLoad() {
    if (!ATT_CODE) return;
    api("/attachment/mine?code=" + encodeURIComponent(ATT_CODE)).then(function (r) {
      var box = $("#attach-entry");
      var list = $("#attach-list");
      if (!box || !list) return;
      if (!r.body || !r.body.ok) return;   // 凭证失效就保持入口隐藏
      box.style.display = "block";
      if (r.body.limits) ATT_LIMITS = r.body.limits;
      var rows = r.body.rows || [];
      list.textContent = "";
      rows.forEach(function (a) {
        var row = document.createElement("div");
        row.className = "su-att-i";
        var link = document.createElement("a");
        link.href = a.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        link.textContent = a.filename || (a.kind === "image" ? "图片" : "文档");
        var del = document.createElement("button");
        del.type = "button"; del.className = "su-att-del";
        del.textContent = "删除"; del.setAttribute("data-id", a.id);
        row.appendChild(link); row.appendChild(del);
        list.appendChild(row);
      });
    });
  }

  function initAttachments(code) {
    ATT_CODE = (code || "").trim();
    var open = $("#attach-open");
    if (!open || open.dataset.bound) { attLoad(); return; }
    open.dataset.bound = "1";
    open.addEventListener("click", function () {
      var inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".png,.jpg,.jpeg,.gif,.pdf,.doc,.docx,.xls,.xlsx";
      inp.addEventListener("change", function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        if (f.size > 5 * 1024 * 1024) { toast("单个文件不能超过 5MB"); return; }
        var btn = open; btn.disabled = true; btn.textContent = "上传中…";
        // raw body：api() 透传 opts，不发 Content-Type（后端按字节读）
        api("/attachment/upload?code=" + encodeURIComponent(ATT_CODE) +
            "&filename=" + encodeURIComponent(f.name),
            { method: "POST", body: f }).then(function (r) {
          btn.disabled = false; btn.textContent = "补充材料（选填）";
          if (!r.body || !r.body.ok) {
            toast((r.body && r.body.detail) || "上传失败，请重试"); return;
          }
          toast("已上传"); attLoad();
        }).catch(function () {
          btn.disabled = false; btn.textContent = "补充材料（选填）";
          toast("网络异常，请重试");
        });
      });
      inp.click();
    });
    var list = $("#attach-list");
    if (list) list.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button[data-id]") : null;
      if (!b) return;
      api("/attachment/mine/" + b.getAttribute("data-id") +
          "?code=" + encodeURIComponent(ATT_CODE),
          { method: "DELETE" }).then(function (r) {
        if (r.body && r.body.ok) { toast("已删除"); attLoad(); }
        else toast("删除失败");
      });
    });
    attLoad();
  }
  // 事件只绑一次，避免重复绑定导致弹层被触发多下
  function bindSuccess() {
    var sc = $("#save-cred");
    if (sc) sc.addEventListener("click", saveCredential);
    var cal = $("#success-cal");
    if (cal) cal.addEventListener("click", addToCalendar);
    // 已报名用户回来改信息：报名表单页有路由守门会被赶回成功页，靠 edit=1 放行
    var ei = $("#edit-info");
    if (ei) ei.addEventListener("click", function (e) { e.preventDefault(); go("signup?edit=1"); });
  }
  // ---- 二维码画进 canvas：逐模块手绘，不依赖图片加载 ----
  // 用 SVG → <img> → drawImage 那条路要先等 onload，保存会变成异步，
  // 微信里容易被打断；直接按模块画方块，同步可靠，任意分辨率都不糊。
  function drawQrToCanvas(ctx, text, x, y, size) {
    if (!hasQr() || !text) return false;
    var q = qrcode(0, "M");
    q.addData(text);
    q.make();
    var n = q.getModuleCount(), quiet = 4;
    var cell = size / (n + quiet * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#1a1a1a";
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (!q.isDark(r, c)) continue;
        // 用取整后的边界算宽高，相邻模块严丝合缝，不会出现发丝白缝
        var x0 = Math.round(x + (c + quiet) * cell);
        var x1 = Math.round(x + (c + quiet + 1) * cell);
        var y0 = Math.round(y + (r + quiet) * cell);
        var y1 = Math.round(y + (r + quiet + 1) * cell);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
    return true;
  }

  // ---- 保存参会凭证 ----
  // 输出 1080×1320（3 倍于页面展示宽度），手机上放大看、印刷小卡都不糊。
  // 二维码一并画进图里：现场直接扫这张图就能进核销页，凭证码仍留在卡上做兜底。
  var CRED_W = 1080, CRED_H = 1320;
  var CRED_FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";

  function saveCredential() {
    var code = ($("#cred-code").textContent || "").trim();
    var name = ($("#cred-name").textContent || "").trim();
    var hasCode = !!code && code !== "—";
    trackEvent("credential_save", "success", { has_code: hasCode ? 1 : 0 });

    var cv = $("#cred-canvas");
    cv.width = CRED_W;          // 重设尺寸会清空画布，顺带把上一次的残留抹掉
    cv.height = CRED_H;
    var ctx = cv.getContext("2d");
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    // 底：纯白，方便直接印
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CRED_W, CRED_H);

    // 顶部色带 + 底部收边
    ctx.fillStyle = "#1ba9a0";
    ctx.fillRect(0, 0, CRED_W, 14);
    ctx.fillRect(0, CRED_H - 8, CRED_W, 8);

    ctx.fillStyle = "#0f3d43";
    ctx.font = "bold 56px " + CRED_FONT;
    ctx.fillText("参会凭证", 70, 118);

    ctx.fillStyle = "#6b7785";
    ctx.font = "30px " + CRED_FONT;
    ctx.fillText((CONFIG.activity && CONFIG.activity.name) || "活动报名平台", 70, 172);

    // 虚线分隔
    ctx.strokeStyle = "#dbe5ec";
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 12]);
    ctx.beginPath();
    ctx.moveTo(70, 212);
    ctx.lineTo(CRED_W - 70, 212);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#9aa6b2";
    ctx.font = "26px " + CRED_FONT;
    ctx.fillText("凭证码", 70, 272);

    ctx.fillStyle = "#1f2a37";
    ctx.font = "bold 96px ui-monospace,Menlo,Consolas,monospace";
    ctx.fillText(hasCode ? code : "—", 66, 368);

    ctx.fillStyle = "#33414f";
    ctx.font = "36px " + CRED_FONT;
    ctx.fillText("姓名：" + (name || "—"), 70, 438);

    ctx.fillStyle = "#6b7785";
    ctx.font = "32px " + CRED_FONT;
    ctx.fillText("活动时间与地点见活动详情", 70, 500);

    // 二维码：居中，480px（约合 40mm 见方，手机上扫毫无压力）
    var qrSize = 480;
    var qrDrawn = hasCode && drawQrToCanvas(
      ctx, siteUrl("#/verify?code=" + encodeURIComponent(code)), (CRED_W - qrSize) / 2, 640, qrSize);

    ctx.textAlign = "center";
    ctx.fillStyle = "#6b7785";
    ctx.font = "30px " + CRED_FONT;
    ctx.fillText(qrDrawn ? "现场核验请出示此码 · 工作人员扫码即可" : "请向工作人员出示上方凭证码",
                 CRED_W / 2, qrDrawn ? 1176 : 720);

    ctx.fillStyle = "#9aa6b2";
    ctx.font = "24px " + CRED_FONT;
    ctx.fillText("活动服务平台", CRED_W / 2, 1246);

    var url;
    try { url = cv.toDataURL("image/png"); } catch (e) { toast("生成失败，请直接截图"); return; }
    // 微信内置浏览器不支持 a[download]，点了没反应或提示"可在浏览器打开"。
    // 微信里唯一可行的是把图显示出来让用户长按存相册。
    if (isWeChat()) {
      var m = $("#img-modal"), img = $("#img-tip");
      if (m && img) { img.src = url; m.style.display = "flex"; return; }
    }
    var a = document.createElement("a");
    a.href = url; a.download = "参会凭证.png";
    document.body.appendChild(a); a.click(); a.remove();
    toast("凭证已保存");
  }

  // ---- 领卡行为上报 ----
  // 后端按「同一用户 + 同一行为」唯一索引去重，前端再做一次会话级节流防止连点。
  // 两边都以第一次为准，后台列表里同一个人的同一行为只会出现一条。
  var CARD_ACTION_SENT = {};
  function reportCardAction(action, source) {
    var key = action + "|" + (getOpenid() || "anon");
    if (CARD_ACTION_SENT[key]) return;
    CARD_ACTION_SENT[key] = 1;
    var cred = {};
    try { cred = JSON.parse(sessionStorage.getItem("cred") || "{}"); } catch (e) {}
    try {
      postJ("/card/action", {
        openid: getOpenid(),
        action: action,
        source: source || currentRoute() || "signup",
        visit_id: visitId(),
        name: cred.name || null
      }).catch(function () {});
    } catch (e) {}
  }

  // ---- 微信 JSSDK：H5 打开小程序只有开放标签这条路 ----
  // 之前用 wx.navigateToMiniProgram，真机上拉不起来：那是 JSSDK 接口，
  // 需要 wx.config 鉴权，且它只对已授权域名生效，实际以开放标签为准。
  // 三条硬要求：① 已认证服务号且域名在「JS 接口安全域名」里
  //             ② wx.config 的 openTagList 申请过 wx-open-launch-weapp
  //             ③ path 必须以 .html 结尾（iOS 不加会报「页面不存在」）
  var WX_SDK_OK = false;
  var WX_MOUNT_TIMER = null;
