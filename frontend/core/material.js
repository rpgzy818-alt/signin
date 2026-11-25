  function openCalTip() {
    var m = $("#cal-modal");
    if (!m) return;
    var info = $("#cal-info");
    if (info) info.innerHTML =
      '<div class="cal-row"><span class="cal-info-k">时间</span>' +
      '<span class="cal-info-v">11 月 29 日（周日）9:00—16:00</span></div>' +
      '<div class="cal-row"><span class="cal-info-k">地点</span>' +
      '<span class="cal-info-v">城市服务中心 · 一号厅<br>场馆地址以主办方通知为准</span></div>';
    m.style.display = "flex";
  }
  function closeCalTip() { var m = $("#cal-modal"); if (m) m.style.display = "none"; }
  function copyCalInfo() {
    var text = ((CONFIG && CONFIG.activity && CONFIG.activity.name) || "活动报名") + "\n" +
      "11 月 29 日（周日）9:00—16:00\n" +
      "城市服务中心 · 一号厅";
    function done() { toast("已复制，粘贴到日历新建日程即可"); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast("复制失败，请手动记录"); }
      ta.remove();
    }
  }
  function bindImgModal() {
    var c = $("#img-close"); if (c) c.addEventListener("click", function () { $("#img-modal").style.display = "none"; });
    var m = $("#img-mask"); if (m) m.addEventListener("click", function () { $("#img-modal").style.display = "none"; });
  }
  function bindCalModal() {
    var c = $("#cal-close"); if (c) c.addEventListener("click", closeCalTip);
    var m = $("#cal-mask"); if (m) m.addEventListener("click", closeCalTip);
    var cp = $("#cal-copy"); if (cp) cp.addEventListener("click", copyCalInfo);
  }

  // 两类物料：对外发布的报名入口码、活动当天用的现场核销物料码。
  // 两者指向不同路由，扫码后的行为完全不同，不能混印。
  // 报名码指向主页（#/intro）而不是表单页：从推文/海报进来的人，
  // 需要先看活动介绍、再看活动安排，最后才填表；直接甩表单会让人不知道在报什么名。
  // 已报名的人扫到这里，autoResume 会自动把他送到报名成功页。
  // from=material 是后台「物料扫码 / 活动链接 / 分享链接」分类的真实依据：
  // 新生成的物料码都带这个参数，旧码（裸链接）无法回溯，会被算作活动链接。
  // 拆成 query + hash 两段：query 段要跟着活动上下文一起拼，hash 段固定在最后。
  // 之前是一整串 "?from=material#/intro"，中间插不进活动码——多机构下通用码
  // 扫进来必然落默认活动，等于把 A 机构海报的访客送进 B 机构的报名表。
  var MATS = {
    signup:  { path: "#/intro",   query: "from=material", name: "活动报名入口码" },
    checkin: { path: "#/checkin", query: "from=material", name: "现场核销物料码" }
  };
  function matUrl(kind) {
    var m = MATS[kind] || MATS.signup;
    var code = getParam("a") || (window.__ACTLINK ? window.__ACTLINK.pathCode() : "");
    return window.__ACTLINK.url(code, m.query) + m.path;
  }
  function loadMaterials() {
    if (!hasQr()) {
      $all("#mat-qr-signup, #mat-qr-checkin").forEach(function (b) {
        b.innerHTML = '<p class="muted">二维码组件未加载</p>';
      });
      return;
    }
    Object.keys(MATS).forEach(function (kind) {
      var u = matUrl(kind);
      var box = $("#mat-qr-" + kind), urlBox = $("#mat-url-" + kind);
      if (urlBox) urlBox.textContent = u;
      if (box) box.innerHTML = qrSvg(u, 8, 20);
    });
  }
  function saveBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  // 下载物料码：kind=signup|checkin，fmt=svg|png
  function downloadQr(matKey, fmt) {
    var u = matUrl(matKey), label = (MATS[matKey] || MATS.signup).name;
    downloadQrUrl(u, label, fmt);
  }
  // 任意链接出码：投放物料码是后台现建的，走的是这条而不是上面的固定两码
  function downloadQrUrl(u, label, fmt) {
    if (!hasQr()) { toast("二维码组件未加载"); return; }
    var q = qrcode(0, "M");
    q.addData(u);
    q.make();
    var svg = q.createSvgTag({ cellSize: 12, margin: 24 });
    if (fmt === "svg") {
      saveBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), label + ".svg");
      return;
    }
    // PNG：SVG 转 canvas，1000 像素见方，A4 印刷够用
    var img = new Image();
    img.onload = function () {
      var size = 1000;
      var cv = document.createElement("canvas");
      cv.width = cv.height = size;
      var cx = cv.getContext("2d");
      cx.fillStyle = "#ffffff";
      cx.fillRect(0, 0, size, size);
      cx.drawImage(img, 0, 0, size, size);
      cv.toBlob(function (b) { saveBlob(b, label + ".png"); }, "image/png");
    };
    img.onerror = function () { toast("导出失败，请改用 SVG"); };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  // 物料按钮：下载与复制链接
  function bindMaterials() {
    $all("[data-mat-dl]").forEach(function (b) {
      b.addEventListener("click", function () {
        downloadQr(b.getAttribute("data-mat-dl"), b.getAttribute("data-mat-kind") || "png");
      });
    });
    $all("[data-mat-copy]").forEach(function (b) {
      b.addEventListener("click", function () {
        var u = matUrl(b.getAttribute("data-mat-copy"));
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(u).then(function () { toast("链接已复制"); },
            function () { toast("复制失败，请手动选中链接"); });
          return;
        }
        // 老浏览器兜底：临时 textarea
        var ta = document.createElement("textarea");
        ta.value = u; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); toast("链接已复制"); }
        catch (e) { toast("复制失败，请手动选中链接"); }
        ta.remove();
      });
    });
  }

  // ---- 领卡（历史兼容）：平台不再内置该入口 ----
  // 领卡（历史兼容）：平台不再内置领卡入口，保留函数备查
  // source 用于埋点区分来源场景（signup / checkin），老调用方不传则按当前页
  // 领卡点击的兜底处理。
  // 正常情况：开放标签已经盖在卡片上，点击由标签直接接管，根本不会走到这儿；
  // 走到这儿说明标签没渲染（老版本微信 / 非微信环境 / wx.config 没成功），
  // 此时才依次退到 JSSDK、H5 地址、提示。
  function receiveCard(source) {
    var src = source || currentRoute() || "card";
    reportCardAction("card_click", src);
    trackEvent("card_click", src);

    // 开放标签正常工作时，click 被它拦截、这个函数不会进来。
    // 进到这里＝标签没挂上或没盖住按钮——直接走 JSSDK 兜底，不静默退出。
    if (/[?&]wxdebug=1/.test(location.search) && WX_FAIL) {
      toast("开放标签未接管：" + WX_FAIL + "（走兜底）");
    }

    var canMini = isWeChat() && window.wx &&
      typeof window.wx.navigateToMiniProgram === "function";
    if (canMini && CARD_MINI.appid) {
      window.wx.navigateToMiniProgram({
        appId: CARD_MINI.appid,
        path: CARD_MINI.path || "",
        envVersion: "release",
        extraData: { source: src, openid: getOpenid() || "" },
        fail: function () {
          if (CARD_MINI.url) { location.href = CARD_MINI.url; return; }
          toast("该入口未在当前活动开放");
        }
      });
      return;
    }
    if (CARD_MINI.url) { location.href = CARD_MINI.url; return; }
    toast("该入口未在当前活动开放");
  }
  // 领奖页已废弃：三份领取内嵌到成功页与签到页，不再有独立权益页

  // ---- 活动交互：日历 / 导航 / 复制地址 ----
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function addToCalendar() {
    // 微信内置浏览器不允许下载 ics，点了只会弹「可在浏览器打开此网页来下载文件」
    if (isWeChat()) { openCalTip(); return; }
    var stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    var lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//signin//ZH//",
      "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
      "UID:meeting-1129-" + stamp + "@example.com",
      "DTSTAMP:" + stamp,
      "DTSTART:" + EVT.startUTC, "DTEND:" + EVT.endUTC,
      "SUMMARY:" + EVT.title,
      "LOCATION:" + EVT.address,
      "DESCRIPTION:" + EVT.desc,
      "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY",
      "DESCRIPTION:活动即将开始", "END:VALARM",
      "END:VEVENT", "END:VCALENDAR"
    ];
    var ics = lines.join("\r\n");
    try {
      var blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "活动日程.ics";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast("日历文件已生成，请在打开方式中点击「日历」导入");
    } catch (e) {
      toast("日历生成失败，请手动记录活动时间");
    }
  }
  // ---- 地图 URI：坐标 + POI 名称同时传，个别机型坐标不准时名称匹配更稳 ----