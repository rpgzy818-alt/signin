  function loadWxSdk(cb) {
    if (window.wx) { cb(); return; }
    var el = document.createElement("script");
    el.src = "https://res.wx.qq.com/open/js/jweixin-1.6.0.js";
    el.onload = cb;
    el.onerror = function () { cb(); };
    document.head.appendChild(el);
  }

  // 微信 JSSDK 初始化：签名 → config → ready 后才挂开放标签。
  // 失败时把原因摆出来（真机上看得到），别让它静默地退化成"去搜索"。
  var WX_FAIL = "";     // 最近一次失败原因，?wxdebug=1 时可显示
  var SHARE_STATE = { app: "", timeline: "" };   // 分享卡片配置结果，?wxdebug=1 时可显示
  function initWxSdk() {
    if (!isWeChat() || location.protocol !== "https:") {
      WX_FAIL = "not_wechat_or_http";
      return;
    }
    if (!RC_API) { WX_FAIL = "no_sign_service"; return; }   // 未配签名服务，跳过 JS-SDK
    // 签名用不带 hash 的完整地址：任何参数差异都会让微信报 invalid signature
    var pageUrl = location.href.split("#")[0];
    fetch(RC_API + "/wx-sign?url=" + encodeURIComponent(pageUrl))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { WX_FAIL = "sign_" + ((d && d.reason) || "fail"); return; }
        loadWxSdk(function () {
          if (!window.wx) { WX_FAIL = "sdk_not_loaded"; return; }
          wx.config({
            appId: d.appId,
            timestamp: d.timestamp,
            nonceStr: d.nonceStr,
            signature: d.signature,
            // 导航要用 openLocation，分享用这两个；开放标签单独在 openTagList 里申请
            jsApiList: ["openLocation", "updateAppMessageShareData", "updateTimelineShareData"],
            openTagList: ["wx-open-launch-weapp"]
          });
          wx.ready(function () {
            WX_SDK_OK = true;
            WX_FAIL = "";
            EVT.wxSdkReady = true;
            // 分享卡片必须在 wx.ready 后配置，否则 update* 接口直接报错
            initShare();
            // 此刻多半还在别的页面，挂不上没关系；进签到页或成功页时会再挂一次
            mountWeappBtn('[data-cta-key="card"]', "去领卡");
          });
          wx.error(function (e) {
            WX_SDK_OK = false;
            WX_FAIL = "config_" + ((e && e.errMsg) || "fail");
            trackEvent("wx_config_error", "card", { msg: String(WX_FAIL).slice(0, 80) });
            if (/[?&]wxdebug=1/.test(location.search)) {
              toast("微信鉴权失败：" + String((e && e.errMsg) || "").slice(0, 60));
            }
          });
        });
      })
      .catch(function () { WX_FAIL = "sign_request_fail"; });
  }

  // 静态资源基址：优先读站点配置（绑独立域名后路径推不出来），缺失才回落到
  // 「页面同级目录」。微信要求 imgUrl 是公网可访问的绝对 URL，相对路径会取不到图。
  function assetBase() {
    var c = window.__SITE__ || {};
    if (c.base) return String(c.base).replace(/\/+$/, "") + "/";
    var dir = location.pathname.replace(/[^\/]*$/, "");
    if (!dir || dir === "/") dir = "/";              // 兜底：与 prodApiBase 保持一致
    return location.origin + dir;
  }
  // 分享落地链接：只保留目录 + 来源参数，不带 hash（带 hash 会落到具体页而非首屏）。
  function shareLink() {
    return assetBase() + "?" + SHARE.param;
  }

  // 配置微信分享卡片（聊天 + 朋友圈）。
  // 必须在 wx.ready 之后调用：config 没通过，update* 接口一律报错。
  function initShare() {
    if (!WX_SDK_OK || !window.wx) return;
    var link = shareLink();
    var imgS = assetBase() + "img/" + SHARE.imgSmall;
    var imgL = assetBase() + "img/" + SHARE.imgLarge;
    // 显式放行「发送给朋友」与「分享到朋友圈」：
    // 不显式声明时，部分机型「分享到朋友圈」是灰的、点不动。
    // jweixin-1.6.0 这版 SDK 没有 showShareMenu，只有老接口 showMenuItems，
    // 所以两个都调：老接口保证全版本可用，新接口在新版微信上更准。
    var menus = ["shareAppMessage", "shareTimeline"];
    try {
      if (typeof wx.showMenuItems === "function") wx.showMenuItems({ menuList: menus });
    } catch (e) {}
    try {
      if (typeof wx.showShareMenu === "function") wx.showShareMenu({ menus: menus });
    } catch (e) {}
    wx.updateAppMessageShareData({
      title: SHARE.title,
      desc: SHARE.desc,
      link: link,
      imgUrl: imgS,
      success: function () {
        SHARE_STATE.app = "ok";
        trackEvent("share_config_ok", "share", { ch: "appMessage" });
        showShareFab();
      },
      fail: function (e) {
        SHARE_STATE.app = "fail:" + String((e && e.errMsg) || "").slice(0, 60);
        trackEvent("share_config_fail", "share", {
          ch: "appMessage", msg: String((e && e.errMsg) || "").slice(0, 80)
        });
      }
    });
    // 朋友圈只认 title/link/imgUrl，没有 desc 字段。
    wx.updateTimelineShareData({
      title: SHARE.title,
      link: link,
      imgUrl: imgL,
      success: function () {
        SHARE_STATE.timeline = "ok";
        trackEvent("share_config_ok", "share", { ch: "timeline" });
      },
      fail: function (e) {
        SHARE_STATE.timeline = "fail:" + String((e && e.errMsg) || "").slice(0, 60);
        trackEvent("share_config_fail", "share", {
          ch: "timeline", msg: String((e && e.errMsg) || "").slice(0, 80)
        });
      }
    });
    // 真机自查：?wxdebug=1 时把分享配置结果摆到页面上，不用连电脑看日志
    if (/[?&]wxdebug=1/.test(location.search)) {
      setTimeout(function () {
        toast("分享卡片：" + shareStateText());
      }, 1800);
    }
  }
  function shareStateText() {
    var a = SHARE_STATE.app, t = SHARE_STATE.timeline;
    var m = { "": "未配置", "ok": "已就绪" };
    return "聊天" + (m[a] || a) + "／朋友圈" + (m[t] || t);
  }

  // 分享引导：右侧悬浮球 + 右上角指路气泡。
  // 为什么不用底部横条：它横跨整宽贴底，实测压住报名按钮和正文。
  // 现在改成一颗小球常驻右侧，滚动时收起、静止淡入；点击弹气泡指右上角，3 秒自动消失。
  // 只在微信内出现（分享本身只能在微信里做），且只在分享配置成功后才有意义。
  var shareHintTimer = null;
  function showShareFab() {
    if (!isWeChat() || !WX_SDK_OK) return;
    var fab = $("#share-fab");
    if (!fab) return;
    var r = currentRoute();
    // 表单页用户正在填信息，别打扰；签到/后台是工作人员在用，也收起来。
    // 报名成功页保留分享入口：用户刚拿到凭证，是最愿意转发的一刻。
    if (r === "signup" || r === "checkin" || r === "admin") {
      fab.style.display = "none";
      return;
    }
    fab.style.display = "block";
    trackEvent("share_fab_show", "share", { route: r });

    if (!fab._bound) {
      fab._bound = 1;
      fab.addEventListener("click", function (e) {
        e.stopPropagation();
        showShareHint();
      });
    }
    if (!fab._scrollBound) {
      fab._scrollBound = 1;
      // 滚动时收起，避免遮正文；停止滚动 700ms 后淡入。
      // 滚动容器是 #app 不是 window，且 scroll 事件不冒泡，
      // 所以用捕获阶段挂在 document 上，才能收到任意容器的滚动。
      var hideT = null;
      var onScroll = function () {
        fab.classList.add("is-hidden");
        if (hideT) clearTimeout(hideT);
        hideT = setTimeout(function () { fab.classList.remove("is-hidden"); }, 700);
      };
      document.addEventListener("scroll", onScroll, true);
    }
  }

  // 分享指引蒙层：点亮右上角「···」并给出说明，3 秒自动消失，点任意处可提前关。
  function showShareHint() {
    var hint = $("#share-hint");
    if (!hint) return;
    hint.style.display = "flex";
    trackEvent("share_hint_show", "share");
    if (shareHintTimer) clearTimeout(shareHintTimer);
    shareHintTimer = setTimeout(function () {
      hint.style.display = "none";
    }, 3000);
    if (!hint._bound) {
      hint._bound = 1;
      hint.addEventListener("click", function () {
        hint.style.display = "none";
        if (shareHintTimer) clearTimeout(shareHintTimer);
        trackEvent("share_hint_close", "share");
      });
    }
  }

  // 把开放标签盖在「领卡」按钮上；标签本身透明，视觉仍是原来的按钮。
  // 开放标签（wx-open-launch-weapp）比 wx.navigateToMiniProgram 可靠：
  // 后者是 JSSDK 接口，需要 wx.config 鉴权且真机上常拉不起来，
  // 开放标签不依赖 wx.config，只需公众号是认证服务号且域名在「JS 接口安全域名」里。
  // target 指定要盖哪个按钮：领奖页的领卡 CTA；不传则用老 card 页的「点击接收」。
  function mountWeappBtn(targetSel, label, scene) {
    if (!WX_SDK_OK || !window.wx) return;
    var sel = targetSel || '[data-cta-key="card"]';
    var btn = $(sel);
    var slot = btn ? (btn.closest(".cta-card") || btn.parentElement) : null;
    if (!slot || !btn || !CARD_MINI.username || !CARD_MINI.path) return;
    if (slot.querySelector("wx-open-launch-weapp")) return;
    var w = Math.round(btn.offsetWidth), h = Math.round(btn.offsetHeight);
    if (w < 60 || h < 20) {   // 视图还没显示时量不到尺寸，等一帧再来
      if (WX_MOUNT_TIMER) clearTimeout(WX_MOUNT_TIMER);
      WX_MOUNT_TIMER = setTimeout(function () { mountWeappBtn(targetSel, label, scene); }, 160);
      return;
    }
    // 插槽模板照抄官方要求：里面必须是一颗「看得见的按钮」（官方要求 default 必填）。
    // 这里盖的是整张 CTA 卡，所以做成铺满整卡、底透明，只把按钮画在右下原位；
    // 颜色取页面主色 --coral(#ff6b4a)，跟垫子那颗按钮一模一样——
    // 标签渲染前后视觉不跳，否则真机上按钮会突然从橙变绿。
    var tpl = '<style>.b{display:block;width:' + w + 'px;height:' + h + 'px;' +
      'background:transparent;border:0;padding:0;margin:0;cursor:pointer;' +
      'pointer-events:auto;touch-action:manipulation;' +
      'font-family:-apple-system,"PingFang SC",sans-serif}' +
      '.b i{position:absolute;right:14px;top:50%;transform:translateY(-50%);' +
      'display:block;background:#ff6b4a;color:#fff;font-style:normal;' +
      'border-radius:18px;padding:8px 16px;font-size:13px;font-weight:600;' +
      'letter-spacing:.3px;white-space:nowrap}</style>' +
      '<button class="b"><i>' + esc(label) + '</i></button>';
    var html = '<wx-open-launch-weapp username="' + esc(CARD_MINI.username) + '"' +
      ' path="' + esc(CARD_MINI.path) + '"' +
      ' env-version="release"' +
      ' style="position:absolute;left:0;top:0;width:' + w + 'px;height:' + h + 'px;display:block;overflow:hidden;z-index:5">' +
      '<script type="text/wxtag-template">' + tpl + '<\/script>' +
      '</wx-open-launch-weapp>';
    slot.insertAdjacentHTML("beforeend", html);

    // 挂上事件监听：真机上到底成没成，靠这两个事件说话
    var tag = slot.querySelector("wx-open-launch-weapp");
    if (tag && tag.addEventListener) {
      tag.addEventListener("launch", function () {
        // 开放标签是原生组件，点击不冒泡：垫在下面的 button.onclick 永远不会执行。
        // 只靠 onclick 记领卡动作 → 真机一条都记不到（后台统计为空的根因）。
        // 这里补记，与 onclick 路径保持同一口径：一次点击＝gift_claim + card_click。
        reportCardAction("gift_claim", scene);
        reportCardAction("card_click", scene);
        trackEvent("weapp_launch", "card");
      });
      tag.addEventListener("error", function (e) {
        // 跳转失败也是用户真的点了，同样要留痕，否则失败场景全成黑洞
        reportCardAction("gift_claim", scene);
        reportCardAction("card_click", scene);
        var msg = (e && e.detail && e.detail.errMsg) || "unknown";
        trackEvent("weapp_error", "card", { msg: String(msg).slice(0, 80) });
        // 真机排查用：把微信给的原话直接显示出来，不用连电脑看日志
        toast("小程序跳转失败：" + String(msg).slice(0, 40));
      });
      // wxdebug=1 时报告挂载位置，验证标签是否真的盖在按钮上
      if (/[?&]wxdebug=1/.test(location.search)) {
        var tagR = tag.getBoundingClientRect(), btnR = btn.getBoundingClientRect();
        var aligned = Math.abs(tagR.left - btnR.left) < 4 && Math.abs(tagR.top - btnR.top) < 4;
        toast(aligned ? "✓ 开放标签已对齐按钮" : "⚠ 标签偏移 tag:" +
          Math.round(tagR.left) + "," + Math.round(tagR.top) +
          " btn:" + Math.round(btnR.left) + "," + Math.round(btnR.top));
      }
    }
  }

  // ---- 微信内加日历的兜底 ----