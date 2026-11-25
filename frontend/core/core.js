/* meeting-h5 前端逻辑（功能优先版，视觉后续精修）
 * 路由：哈希路由适配静态托管。视图见 index.html data-route。
 * 授权：微信内静默授权拿 openid（snsapi_base）。
 *       生产经 rc-api /api/wx-openid 换 openid；dev 用 ?openid= 或本地生成 dev id。
 */
(function () {
  "use strict";

  // ---- 跨模块共享状态，必须在这里声明 ----
  // router.js / staff.js 会反复给这两个变量赋值，但它们的定义原本只在后台产物里
  // （admin-config.js）。严格模式下给未声明变量赋值直接抛 ReferenceError，
  // 后果不是"少个字段"，而是 loadState 这条链整条断掉：状态页不自动跳转、
  // 已报名用户被当成新用户。声明一次，两边各自赋值互不影响。
  var ME_STATE = null;
  var STAFF_INFO = null;

  // ---- 配置（上线前按需调整）----
  var DEV_API = "http://127.0.0.1:8088/platform/api";   // 平台化副本：本地联调端口 8088
  // 本地可用 ?api= 切到别的后端实例（演示/联调用）；非本地域名一律走同域路径，不可被覆盖
  var isLocal = (location.hostname === "127.0.0.1" || location.hostname === "localhost");
  // 站点配置优先（部署时注入，见 site-config.js）：绑独立域名后路径不再能代表站点，
  // 配置缺失才回落到「按目录推导」，保证本地开发与旧部署不受影响。
  function siteCfg() { return window.__SITE__ || {}; }
  // 接口前缀：优先站点配置；否则跟随页面所在目录（/reg/ → /reg/api）。
  function prodApiBase() {
    var c = siteCfg();
    if (c.api) return String(c.api).replace(/\/+$/, "");
    var dir = location.pathname.replace(/[^\/]*$/, "");   // 去掉文件名，保留目录
    if (!dir || dir === "/") dir = "/";                    // 兜底：部署在站点根
    return dir.replace(/\/$/, "") + "/api";
  }
  var API = (isLocal && getParam("api")) || (isLocal ? DEV_API : prodApiBase());
  // ---- 微信能力（可选）----
  // 开源版默认关闭：RC_API 是微信公众号签名与 openid 换取服务，属于部署方自有基础设施。
  // 留空即停用「微信内自动登录 + 自定义分享卡片」，页面回落到普通 H5 流程，不影响报名签到。
  // 部署方如需启用，在 site-config.js 里注入 rcApi / wxAppId 再打开 WX_ENABLED。
  var RC_API = "";
  var APPID = "";
  var CARD_MINI = { username: "", appid: "", path: "", url: "" };
  var WX_ENABLED = false;

  // ---- 微信分享卡片配置 ----
  // 文案对外，先定口径再落地；改这里即可，不必动逻辑。
  // 注意：微信两个分享接口的参数名都是 imgUrl（不是 imageUrl），写错会静默失效、朋友圈无图。
  var SHARE = {
    title: "2026 城市服务开放日",
    desc: "11 月 29 日，城市服务中心见。",
    // 微信两个分享入口最终都按 1:1 展示：聊天小图是方形裁切，朋友圈单图也是方形。
    // 5:4 那版中心裁成方形会切掉主标题末字，
    // 所以两个入口统一用 1:1 这张（文字排布本身是按方形设计的，裁切安全）。
    // 5:4 备用图在 img/share-cover-5x4-v2.jpg，改排版后可随时切回。
    // 两张统一用 JPEG（q85 / 4:4:4 色度采样，文字边缘不糊）：PNG 版 351K 换 JPEG 后 71K，
    // 微信抓取分享图有超时限制，体积越小卡片出图越稳。原始 PNG 已归档到 review/。
    imgSmall: "share-cover-v3.jpg",
    imgLarge: "share-cover-v3.jpg",
    // 分享落地链接带来源参数，用于核分享→报名转化；
    // 签名走 pageUrl（含 query，不含 hash），已实测带参 URL 签名正常。
    param: "from=share"
  };

  // ---- 活动信息（集中配置位：地点/名称/时间/坐标，运营上线前统一维护）----
  // 坐标为示例值：部署时按实际场馆重新采集，再覆盖 gcj / bd09 / wgs84 三套。
  // 三种坐标系严格分开，绝不混用：GCJ-02（高德/腾讯/微信 JS-SDK）、BD-09LL（百度）、WGS-84（Apple/geo）。
  // 注：外部提供的 WGS-84 采集值 (39.899009,116.648381) 与 GCJ-02 反解值相差约 1.8km，
  //     疑为另一点或旧数据，未采用；Apple/geo 暂用 GCJ-02 反解值，待 POI 复核后替换。
  var EVT = {
    title: "活动报名",
    startUTC: "20261129T010000Z",   // 2026-11-29 09:00 +08:00 的 UTC 写法
    endUTC: "20261129T080000Z",     // 2026-11-29 16:00 +08:00
    address: "城市服务中心 · 一号厅",
    venueName: "城市服务中心",
    desc: "活动详情与现场安排以主办方发布为准。",
    poiName: "城市服务中心",
    poiAddress: "城市服务中心 · 一号厅",
    gcj:   { lng: 116.673991, lat: 39.905575 },  // GCJ-02：高德 / 腾讯 / 微信 JS-SDK
    bd09:  { lng: "116.680510", lat: "39.911501" },  // BD-09LL：用字符串保留尾零，与 POI 采集值一致
    wgs84: { lng: 116.668075, lat: 39.904451 },  // WGS-84：由 GCJ-02 反解（Apple / geo）
    wxSdkReady: false   // 微信 JS-SDK 验签通过后置 true，方启用 wx.openLocation
  };

  // ---- 工具 ----
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }
  function isWeChat() { return /micromessenger/i.test(navigator.userAgent); }
  function getParam(name) {
    var m = new RegExp("[?&]" + name + "=([^&]*)").exec(location.search);
    return m ? decodeURIComponent(m[1]) : null;
  }
  // 名单里的姓名、意向等是用户输入，渲染前统一转义
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // 后端时间是 ISO 串（2026-11-10T17:20:55+08:00），展示成「2026-11-10 17:20」
  function fmtTime(s) {
    if (!s) return "";
    var m = String(s).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return m ? (m[1] + " " + m[2]) : String(s);
  }

  // ---- openid ----
  function getOpenid() {
    var p = getParam("openid");
    if (p) { try { localStorage.setItem("openid", p); } catch (e) {} return p; }
    try { var s = localStorage.getItem("openid"); if (s) return s; } catch (e) {}
    return null;
  }
  function ensureOpenid() {
    var o = getOpenid();
    if (o) return o;
    if (isWeChat() && WX_ENABLED) { wxAuthorize(); return null; }
    // dev 兜底：生成稳定 dev id，便于浏览器内联调
    var dev = "dev_" + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem("openid", dev); } catch (e) {}
    return dev;
  }
  function wxAuthorize() {
    // 微信回调 URL 不带 hash，先记住当前页，回来后恢复；
    // 否则默认落地改成首页后，从报名页触发授权会被送回首页且表单丢失。
    try { sessionStorage.setItem("wx_back_hash", location.hash || ""); } catch (e) {}
    var here = location.origin + location.pathname; // 去除 code/state，避免循环
    var url = "https://open.weixin.qq.com/connect/oauth2/authorize?appid=" + APPID +
      "&redirect_uri=" + encodeURIComponent(here) +
      "&response_type=code&scope=snsapi_base&state=meeting&connect_redirect=1#wechat_redirect";
    location.href = url;
  }
  function restoreAfterWx() {
    var h = "";
    try { h = sessionStorage.getItem("wx_back_hash") || ""; sessionStorage.removeItem("wx_back_hash"); } catch (e) {}
    try {
      if (getParam("code") || getParam("state")) {
        history.replaceState(null, "", location.pathname + h); // 清掉 code/state，刷新不再重复换取
      }
    } catch (e) {}
    if (h && location.hash !== h) location.hash = h;
  }
  // 微信回调 code 换 openid（经 rc-api，待与 rc-api 联调确认返回结构与 vid/src 参数）
  function wxExchange(code) {
    if (!RC_API) return Promise.resolve(null);   // 未接自有签名服务：跳过换取 openid
    return fetch(RC_API + "/wx-openid?code=" + encodeURIComponent(code))
      .then(function (r) { return r.json(); })
      .then(function (d) { return d.openid || (d.data && d.data.openid) || null; });
  }

  // ---- API 封装 ----
  // 参与者端活动上下文：URL 带 ?a=<活动短码> 时注入 X-Activity-Code，
  // 后端按 X-Activity-Code > Host > 默认活动解析（backend/activity.py）。
  // 用途：演示链接（?a=demo）、运营按码预览任意活动。不写 localStorage——
  // 参与者从海报/推文进来不带这个参数，不能让一次预览污染后续所有访问。
  //
  // 机构子域下改用路径式：/summit2026（方向二）。两条都要认——?a= 是已经
  // 印出去的老链接，路径式是新形态。判定与拼链接同一个实现（core/actlink.js），
  // 这里不另写一套正则。
  var urlActivityCode = getParam("a") ||
    (window.__ACTLINK ? window.__ACTLINK.pathCode() : "");
  function api(path, opts) {
    var o = {}, k;
    if (opts) for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    if (urlActivityCode) {
      // 合并而不是覆盖 headers：POST 要带 Content-Type，直接换掉会把它冲掉
      var h = {};
      var src = o.headers || {};
      for (k in src) if (Object.prototype.hasOwnProperty.call(src, k)) h[k] = src[k];
      h["X-Activity-Code"] = urlActivityCode;
      o.headers = h;
    }
    return fetch(API + path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, status: r.status, body: j };
      });
    });
  }
  function postJ(path, data) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
  }

  // ---- 埋点：页面到达率与关键动作（规格 3.4 指标口径）----
  // 一次访问一个 visit_id：把「介绍→报名→成功→领卡」串成一条漏斗
  function visitId() {
    var v = null;
    try { v = sessionStorage.getItem("visit_id"); } catch (e) {}
    if (!v) {
      v = "v_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { sessionStorage.setItem("visit_id", v); } catch (e) {}
    }
    return v;
  }
  // 匿名设备号：localStorage 持久，跨会话仍算同一个访客（UV 主口径）。
  // openid 只有微信授权后才有，授权前/非微信访客全丢会让 UV 系统性偏低；
  // 用 did 兜底，事件照记，payload.identified 标出是否已有真实身份。
  function deviceId() {
    var d = null;
    try { d = localStorage.getItem("did"); } catch (e) {}
    if (!d) {
      d = "d_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem("did", d); } catch (e) {}
    }
    return d;
  }
  // 首次来源：localStorage 持久，与本次来源 src 分开存——
  // 归因双轨都留，报表默认看末次（src），切首次（first_src）看拉新贡献。
  function firstSource() {
    var f = null;
    try { f = localStorage.getItem("first_src"); } catch (e) {}
    if (!f) {
      var s = "";
      try { s = sessionStorage.getItem("src") || ""; } catch (e) {}
      f = getParam("from") || s || "direct";
      try { localStorage.setItem("first_src", f); } catch (e) {}
    }
    return f;
  }
  // 投放物料短码：URL 形如 ?from=material&m=p9k2m4。
  // 首次触点原则——会话里记过就不再覆盖：先扫 A 海报、后扫 B，仍算 A 带来的。
  // 与 from 分开是因为 from 只有四类（物料/分享/活动/补录），分不出是哪一张物料。
  var MAT_CODE_TTL = 7 * 24 * 3600 * 1000;
  function matCode() {
    var c = null;
    try { c = sessionStorage.getItem("mat_code"); } catch (e) {}
    if (c) return c;
    // 微信静默授权会整页往返一次，部分安卓机还会把页面杀掉重开，sessionStorage 会丢；
    // 用 localStorage 兜 7 天，保证「扫码 → 授权 → 填表」这条链不会在中途断掉。
    // 仍守首次触点：窗口内有值就不覆盖，A 海报带来的报名不会算给后扫的 B。
    try {
      var raw = localStorage.getItem("mat_code");
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.c && (Date.now() - (o.t || 0)) < MAT_CODE_TTL) {
          try { sessionStorage.setItem("mat_code", o.c); } catch (e) {}
          return o.c;
        }
      }
    } catch (e) {}
    var p = getParam("m");
    if (!p) {
      // 有些投放平台会把参数拼到 hash 里：/#/intro?m=xxx
      var hm = /[?&]m=([^&]*)/.exec(String(location.hash || ""));
      if (hm) p = decodeURIComponent(hm[1]);
    }
    p = String(p || "").trim().toLowerCase();
    if (!/^[a-z0-9]{4,16}$/.test(p)) return null;
    try { sessionStorage.setItem("mat_code", p); } catch (e) {}
    try { localStorage.setItem("mat_code", JSON.stringify({ c: p, t: Date.now() })); } catch (e) {}
    return p;
  }
  // 设备识别：判定顺序很重要——鸿蒙 UA 里常带 Android 字样，先判安卓会误分。
  // 机型只能取到 Android/鸿蒙的具体型号；iOS 受系统限制只有 iPhone/iPad/iPod。
  function deviceInfo() {
    var ua = navigator.userAgent || "";
    var os = "其他", model = "", scr = "";
    if (/OpenHarmony|ArkWeb/i.test(ua)) os = "鸿蒙";
    else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
    else if (/Android|Adr/i.test(ua)) os = "安卓";
    if (os === "iOS") {
      model = /iPad/i.test(ua) ? "iPad" : (/iPod/i.test(ua) ? "iPod" : "iPhone");
    } else if (os !== "其他") {
      var parts = ua.split(";");
      var seg = parts.length > 1 ? parts[parts.length - 1].split(")")[0].trim() : "";
      // 微信内核末尾常是 wv / Mobile 这种标记，往前退一段才是机型
      if (/^(wv|mobile)$/i.test(seg) && parts.length > 2) {
        seg = parts[parts.length - 2].trim();
      }
      model = seg.replace(/\s*Build\/.*$/i, "").slice(0, 40);
    }
    try { if (window.screen) scr = screen.width + "x" + screen.height; } catch (e) {}
    return { os: os, model: model, screen: scr };
  }
  // 运营侧页面：后台（admin）、现场核销（verify）、工作人员绑定（staff-bind）。
  // 这些页面是运营/工作人员自己在用，一旦计入就会抬高 UV、稀释转化率——
  // 昨天的生产库里正是这样躺着 9 条 admin 的 pv。
  // 用 location.hash 判断而不是 currentRoute()：core.js 先于 signup.js 加载，
  // 此处不能依赖后者的定义。
  var OPS_ROUTES = { admin: 1, verify: 1, "staff-bind": 1 };
  function isOpsRoute() {
    var h = String(location.hash || "").replace(/^#\/?/, "").split("?")[0].split("/")[0];
    return !!OPS_ROUTES[h];
  }
  // 免埋点：URL 带 nt=1 时整站不上报。给自动化回归与人工巡检用。
  // 没有这个开关，scripts/ui_regression.py 跑一遍生产者端，测试设备的访问
  // 就会进 events —— UV 是设备维度，等于自己给自己刷了一个访客。
  // 查 search 也查 hash：hash 路由下页面内跳转只改 hash，search 会保留。
  function isNoTrack() {
    var s = String(location.search || "") + "&" + String(location.hash || "");
    return /[?&]nt=1(&|$)/.test(s);
  }
  function trackEvent(event, page, payload) {
    if (isOpsRoute() || isNoTrack()) return;   // 运营侧与巡检流量一律不上报
    var pl = payload || {};
    var oid = getOpenid();
    var dev = deviceId();
    var info = deviceInfo();
    pl.iid = "e_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    pl.did = dev;                                  // UV 主口径（匿名设备）
    pl.sid = pl.visit_id || visitId();             // 会话号，兼容旧字段名
    pl.visit_id = pl.sid;
    pl.identified = !!oid;                         // 是否已拿到真实身份
    pl.first_src = firstSource();                  // 首次触点
    try {
      var src = sessionStorage.getItem("src");
      if (src && !pl.from) pl.from = src;          // 本次触点（归因默认）
    } catch (e) {}
    if (!pl.from) pl.from = pl.first_src;
    pl.os = info.os; pl.model = info.model; pl.screen = info.screen;
    var mc = matCode();
    if (mc) pl.m = mc;                             // 物料短码，进 payload 便于排查
    try { postJ("/track", {
      openid: oid || dev, event: event,
      page: page || currentRoute(), payload: JSON.stringify(pl),
      code: mc || null, did: dev                   // 单独成列：按码聚合扫码人数要它去重
    }).catch(function () {}); } catch (e) {}
  }
  // page_view：原口径，同一会话同一页只记一次，保留给漏斗「到达」用
  function trackPage(view) {
    var key = "trk_" + view;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch (e) {}
    trackEvent("page_view", view);
  }
  // pv：真页面浏览，每次路由渲染都记一次。iOS 微信的 replaceState 会让 render
  // 重复触发，用 sid+route 做 800ms 节流，避免一次渲染被算成多次曝光。
  var PV_LAST = {};
  function trackPV(view) {
    var k = visitId() + "|" + view, now = Date.now();
    if (PV_LAST[k] && now - PV_LAST[k] < 800) return;
    PV_LAST[k] = now;
    trackEvent("pv", view);
  }

  // ---- 弱网恢复：写操作静默重试 2 次 + 8s 超时 ----
  // 现场 3Mbps + 微信内核，网络抖动是常态。只对幂等写操作用：报名（同 openid 走 UPDATE）、
  // 签到（已签返回 already）、领卡行为（后端按用户+行为去重），重发不会产生脏数据。
  // 4xx 是业务明确拒绝，重试无意义；5xx 与网络中断才重试，最后仍失败交给手动重试按钮。
  function postResilient(path, data) {
    var MAX = 3;
    return new Promise(function (resolve, reject) {
      var attempt = function (n) {
        var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
        var again = function () {
          if (n + 1 < MAX) setTimeout(function () { attempt(n + 1); }, 1000);
          else resolve(null);
        };
        api(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
          signal: ctrl ? ctrl.signal : undefined
        }).then(function (r) {
          if (timer) clearTimeout(timer);
          if (r.ok || r.status < 500) { resolve(r); return; }
          again();
        }).catch(function () {
          if (timer) clearTimeout(timer);
          again();
        });
      };
      attempt(0);
    });
  }

  // ---- 活动配置与公开数字：只取聚合值，不暴露任何个人信息 ----
  var CONFIG = { registration_open: true, event_ended: false, env: null };
  // 草稿态标识（P3-c 发布闸门）。
  // 草稿态**不拦访问**：运营要在这里测报名、签到、导出，一律 404 就没法验。
  // 防护降级为「说清楚」：顶部一条黄色提示，让拿链接的人一眼知道这不是正式活动。
  // 数据层的隔离不靠这里——发布时会把草稿期的数据整体归档（见 admin_activity_publish）。
  function showDraftBadge() {
    if (document.getElementById("draft-badge")) return;
    var d = document.createElement("div");
    d.id = "draft-badge";
    d.textContent = "预览模式 · 活动尚未发布，此处数据仅用于测试";
    // 挂 body 上、position:fixed：草稿态每翻一屏都得看见它，不能随内容滚走。
    // 让位不在这里做——由 CSS 让品牌条自己加厚 padding-top，见 base.css 对应段落。
    document.body.appendChild(d);
    document.body.classList.add("has-draft-badge");
  }
  var PUBLIC_NUMBERS = null;

  // ---- 底部标识（原广告位）----
  // 体验版报名/签到成功页底部那一行「技术支持：签到会 · 我也免费创建活动」。
  // 官网地址定了只改 TECH_BADGE.href 这一处；文案改 TECH_BADGE.brand。
  // 是否显示不在这里判断——后端下发 CONFIG.tech_badge（只有 trial 为真），
  // 前端不认版本号，改档位规则不必动这里。
  var TECH_BADGE = { brand: "签到会", text: "我也免费创建活动", href: "#" };
  function techBadgeHTML() {
    if (!CONFIG || !CONFIG.tech_badge) return "";
    return '<div class="tech-badge">' +
      '<span>技术支持：' + techBadgeEsc(TECH_BADGE.brand) + '</span>' +
      '<i class="tb-sep" aria-hidden="true"></i>' +
      '<a href="' + techBadgeEsc(TECH_BADGE.href) + '">' +
      techBadgeEsc(TECH_BADGE.text) + '</a>' +
      '</div>';
  }
  // 常量在文件内写死，但仍走一遍转义：将来从配置读也不会因为一句话破版。
  function techBadgeEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // P7 主题注入：变量值由后端按活动下发（theme.py），这里只写到 :root。
  // 不拼样式串、不 eval——主题是配置不是代码。key 正则兜底，
  // 即便后端返回了非预期键名也只会写不进去，不会注入任意样式。
  function applyTheme(theme) {
    if (!theme || !theme.vars) return;
    var root = document.documentElement;
    Object.keys(theme.vars).forEach(function (k) {
      if (/^--[a-z0-9-]+$/i.test(k)) root.style.setProperty(k, theme.vars[k]);
    });
    if (document.body) document.body.setAttribute("data-theme", theme.key || "default");
  }

  // P7-b2 介绍页文案覆盖：只覆盖三处纯文字，美术字图片（主标语/落款）不动。
  // 一律 textContent 写入——后端虽然已归一化，这里再守一道，杜绝脚本注入。
  function applyIntro(intro) {
    if (!intro) return;
    if (intro.line1) {
      var l1 = document.querySelector('[data-intro="line1"]');
      if (l1) l1.textContent = intro.line1;
    }
    if (intro.line2) {
      var l2 = document.querySelector('[data-intro="line2"]');
      if (l2) l2.textContent = intro.line2;
    }
    if (intro.desc && intro.desc.length) {
      var d = document.querySelector('[data-intro="desc"]');
      if (d) {
        d.textContent = "";
        intro.desc.forEach(function (txt) {
          var s = document.createElement("span");
          s.textContent = txt;
          d.appendChild(s);
        });
      }
    }
  }

  // RD-04 日程/议程渲染：后端下发的 agenda = {schedule:[], agenda:[]}。
  // 议程替换 event 页静态时间线，日程另起一段可折叠列表；两者都没配就
  // 原样保留 HTML 兜底，老活动不会突然变成空白页。
  // 一律 createElement + textContent；map_url 后端已校验 http/https，
  // 这里再限协议并加 noopener，杜绝注入与反跳。
  function applyAgenda(agenda) {
    if (!agenda) return;
    var list = agenda.agenda || [];
    var sched = agenda.schedule || [];
    var slot = document.getElementById("agenda-slot");
    if (list.length && slot) {
      slot.textContent = "";
      // 竖排：议程条数不限，横排时间轴超过 4 条会挤成一条
      slot.className = "ev-tl ev-tl-stack";
      list.forEach(function (it) {
        var row = document.createElement("div");
        row.className = "ev-tl-i";
        var t = document.createElement("b");
        t.textContent = it.time_range || it.day || "";
        var s = document.createElement("span");
        s.textContent = it.title || "";
        row.appendChild(t); row.appendChild(s);
        if (it.location) {
          var loc = document.createElement("em");
          loc.className = "ev-tl-loc";
          if (/^https?:\/\//i.test(it.map_url || "")) {
            var a = document.createElement("a");
            a.href = it.map_url; a.target = "_blank"; a.rel = "noopener noreferrer";
            a.textContent = it.location;
            loc.appendChild(a);
          } else {
            loc.textContent = it.location;
          }
          row.appendChild(loc);
        }
        slot.appendChild(row);
      });
    }
    var ss = document.getElementById("schedule-slot");
    if (sched.length && ss) {
      ss.textContent = "";
      var h = document.createElement("div");
      h.className = "ev-sched-h";
      h.textContent = "活动日程";
      ss.appendChild(h);
      sched.forEach(function (it) {
        var row = document.createElement("div");
        row.className = "ev-sched-i";
        var day = document.createElement("b");
        day.textContent = it.day || "";
        var body = document.createElement("span");
        body.textContent = (it.time_range ? it.time_range + " " : "") + (it.title || "") +
          (it.location ? " · " + it.location : "");
        row.appendChild(day); row.appendChild(body);
        ss.appendChild(row);
      });
      ss.style.display = "";
    }
  }

  // 嘉宾/讲师（专业版）：独立接口拉，因为 /config 是公开接口、不能绕过
  // speaker 能力位；/speakers 后端已 require_feature，未开通直接 403。
  // 失败静默——嘉宾是锦上添花，不能因为一次抖动拖住整页报名。
  function loadSpeakers() {
    api("/speakers").then(function (r) {
      var box = document.getElementById("speaker-slot");
      if (!box) return;
      var rows = (r.body && r.body.rows) || [];
      if (!rows.length) { box.style.display = "none"; return; }
      box.textContent = "";
      var h = document.createElement("div");
      h.className = "ev-sched-h";
      h.textContent = "嘉宾讲师";
      box.appendChild(h);
      rows.forEach(function (s) {
        var card = document.createElement("div");
        card.className = "ev-spk-i";
        if (/^https?:\/\//i.test(s.avatar_url || "")) {
          var img = document.createElement("img");
          img.className = "ev-spk-av";
          img.src = s.avatar_url;
          img.alt = s.name || "";
          img.loading = "lazy";
          card.appendChild(img);
        }
        var body = document.createElement("div");
        body.className = "ev-spk-body";
        var nm = document.createElement("b");
        nm.textContent = s.name || "";
        body.appendChild(nm);
        var meta = [s.title, s.org].filter(Boolean).join(" · ");
        if (meta) {
          var m = document.createElement("small");
          m.textContent = meta;
          body.appendChild(m);
        }
        if (s.bio) {
          var bio = document.createElement("span");
          bio.textContent = s.bio;
          body.appendChild(bio);
        }
        card.appendChild(body);
        box.appendChild(card);
      });
      box.style.display = "";
    }).catch(function () { /* 静默降级 */ });
  }

  // 平台化 P0：品牌、分享标题一律取当前活动名，前端不再写死任何机构或专场名。
  // 拿不到配置时只用中性兜底，不回落成某场历史活动的名字。
  function applyBranding(activity) {
    var name = (activity && activity.name) ? String(activity.name).trim() : "";
    var org = (activity && activity.org_name) ? String(activity.org_name).trim() : "活动主办方";
    if (name) {
      document.title = name;
      SHARE.title = name + " · 邀请函";
      EVT.title = name;
      $all("[data-activity-name]").forEach(function (el) { el.textContent = name; });
    }
    $all("[data-activity-org]").forEach(function (el) { el.textContent = org; });
  }

  // RD-15 咨询入口：页脚弱入口，点开只给主办方与联系口径，不进主叙事
  function bindContact() {
    var modal = $("#contact-modal");
    if (!modal || modal.dataset.bound) return;
    modal.dataset.bound = "1";
    $all("[data-contact]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        modal.style.display = "flex";
      });
    });
    var close = function () { modal.style.display = "none"; };
    var x = $("#contact-close"); if (x) x.addEventListener("click", close);
    var mask = $("#contact-mask"); if (mask) mask.addEventListener("click", close);
  }

  // 个人信息处理说明：主办方名称与收集字段清单都来自 /config，
  // 不写死任何机构或品牌名。用 textContent 写入，杜绝注入。
  function applyPrivacy(activity, fieldLabels) {
    var org = (activity && activity.org_name) ? activity.org_name : "活动主办方";
    $all("[data-privacy='org']").forEach(function (el) { el.textContent = org; });
    var list = document.querySelector("[data-privacy='fields']");
    if (list) {
      var labels = fieldLabels || [];
      list.textContent = labels.length ? labels.join("、") : "姓名、手机号等报名所需信息";
    }
  }

  // 活动资料下载（专业版）：报名页与成功页各一个弱入口，后端未开通/没配都不渲染。
  // 文件给下载链接，网盘链接给复制按钮——不在这里判能力位，服务端已按能力位过滤。
  function copyMaterialLink(text, btn) {
    function done() {
      var old = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(function () { btn.textContent = old; }, 1600);
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); }
      catch (e) { window.prompt("请手动复制：", text); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }
  function applyMaterial(m) {
    var boxes = ["material-entry-signup", "material-entry-success"]
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);
    if (!boxes.length) return;
    if (!m || !m.url) {
      boxes.forEach(function (b) { b.textContent = ""; b.style.display = "none"; });
      return;
    }
    boxes.forEach(function (box) {
      box.textContent = "";
      var label = document.createElement("span");
      label.className = "su-material-label";
      label.textContent = (m.title || "活动资料") +
        (m.kind === "file" ? "（PDF）" : "（网盘链接）");
      box.appendChild(label);
      var action;
      if (m.kind === "file") {
        action = document.createElement("a");
        action.href = m.url;
        if (m.filename) action.setAttribute("download", m.filename);
        action.textContent = "下载资料";
      } else {
        action = document.createElement("button");
        action.type = "button";
        action.textContent = "复制链接";
        action.addEventListener("click", function () { copyMaterialLink(m.url, action); });
      }
      action.className = "btn-ghost";
      box.appendChild(action);
      box.style.display = "";
    });
  }

  // P5-b CTA 补充入口：后台配置的活动级按钮。
  // 后端已保证合规（无 required/blocking、外链白名单），这里只渲染不判断。
  // 按 position 匹配当前页；url 用 href + target=_blank + rel=noopener，
  // tel 用 tel: 链接；一律 textContent 写标题，杜绝注入。
  var CTA_LAST = null;
  function applyCtas(ctas) {
    CTA_LAST = ctas || [];
    var box = document.getElementById("cta-extra");
    if (!box) return;
    box.textContent = "";
    if (!ctas || !ctas.length) { box.style.display = "none"; return; }
    var route = location.hash.replace(/^#\/?/, "").split("?")[0] || "intro";
    var shown = 0;
    ctas.forEach(function (c) {
      if (c.position && c.position !== route) return;
      if (c.kind !== "url" && c.kind !== "tel" && c.kind !== "material_code") return;
      var a = document.createElement("a");
      a.className = "cta-extra-item";
      a.textContent = c.title || "了解更多";
      if (c.kind === "tel") {
        a.href = "tel:" + String(c.target || "").replace(/[^0-9+]/g, "");
      } else {
        a.href = c.target || "#";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      if (c.cta_key) a.setAttribute("data-cta-key", c.cta_key);
      box.appendChild(a);
      shown++;
    });
    box.style.display = shown ? "flex" : "none";
  }

  // 路由切换后按新的 position 重算（只绑一次）
  if (!window.__ctaHashBound) {
    window.__ctaHashBound = true;
    window.addEventListener("hashchange", function () { applyCtas(CTA_LAST); });
  }

  function loadConfig() {
    return api("/config").then(function (r) {
      // 机构首页（RD-13）：后端只回机构与活动列表。必须**提前返回**，不能落到
      // 下面的活动级配置上——那会把该机构首个活动（机构没有活动时则是默认活动）
      // 的主题、日程、CTA、嘉宾一并应用到机构门面上，是实打实的跨租户串数据。
      if (r.body && r.body.mode === "org_home") {
        CONFIG.mode = "org_home";
        CONFIG.tech_badge = false;        // 机构门面不是活动成功页，永远没有底部标识
        CONFIG.org = r.body.org || null;
        CONFIG.activities = (r.body.activities || []).slice();
        CONFIG.env = r.body.env || null;
        return CONFIG;
      }
      CONFIG.mode = "activity";
      // 404 不是「取不到配置」这么轻：它是后端明确说「这个站点/这场活动不存在」。
      // 记下来交给 boot 决定落哪个视图——不记录的话前端会按默认值渲染一个
      // 空白报名页，访客看不出是打错了还是我们挂了。
      if (r.status === 404) {
        CONFIG.loadError = (r.body && r.body.detail) || "页面不存在";
        return CONFIG;
      }
      if (r.body && r.body.ok) {
        CONFIG.env = r.body.env || null;         // 后端声明的环境：staging / prod
        CONFIG.registration_open = r.body.registration_open !== false;
        CONFIG.event_ended = r.body.event_ended === true;
        CONFIG.gate = r.body.gate || null;      // 签到闸门判定，用于扫码落地页前置拦截
        // 底部标识（原广告位）：只有体验版为真，判定在后端。
        // 成功页可能在配置回来之前就渲染过一次（boot 里 state 先到），
        // 所以这里补一次填充——不然首屏会缺这一行，二次进页面才出现。
        CONFIG.tech_badge = r.body.tech_badge === true;
        var _tb = document.getElementById("tech-badge");
        if (_tb) _tb.innerHTML = techBadgeHTML();
        CONFIG.bgm = r.body.bgm || null;        // 背景音乐：后台可关、可换文件
        // 活动状态（P3-c）：draft 时挂「预览模式」提示。运营要在发布前测报名与签到，
        // 所以不拦访问；数据隔离靠发布时归档，不靠这里。
        CONFIG.activity = r.body.activity || null;
        // 协议弹层：主办方名称与字段清单都取自当前活动/机构配置，
        // 没有机构名时后端已回落「活动主办方」，前端不再写死任何品牌名。
        applyBranding(CONFIG.activity);
        applyPrivacy(CONFIG.activity, r.body.field_labels || []);
        bindContact();
        // 主题在配置回来后注入。默认主题与 CSS :root 同值，
        // 所以首屏（render 先落地）到注入之间不会有可见跳变。
        CONFIG.theme = r.body.theme || null;
        applyTheme(CONFIG.theme);
        // 介绍页文案覆盖（null 时保持 HTML 里的默认文案）
        applyIntro(r.body.intro || null);
        // 日程/议程（RD-04）：空的返回时保留 HTML 静态时间线兜底
        applyAgenda(r.body.agenda || null);
        // 嘉宾/讲师（专业版）：只有能力位开了才发请求，避免没买的机构白吃一个 403
        if ((r.body.features || {}).speaker) loadSpeakers();
        // 活动资料下载（专业版）：服务端已按能力位过滤，没配就是 null
        applyMaterial(r.body.material || null);
        // CTA 补充入口（后端已合规校验，前台只渲染）
        applyCtas(r.body.ctas || []);
        // P6 自助查询入口：按功能位显示（三个功能任一开了才露入口）
        var feats = r.body.features || {};
        var qe = document.getElementById("query-entry");
        if (qe) {
          var qon = !!(feats.self_query || feats.exhibition || feats.seat);
          qe.style.display = qon ? "block" : "none";
          if (qon && !qe.dataset.bound) {
            qe.dataset.bound = "1";
            qe.addEventListener("click", function () { go("query"); });
          }
        }
      }
      return CONFIG;
    }).catch(function () { return CONFIG; });  // 取不到按「正常开放」降级，绝不误伤报名
  }
  function publicNumbers(force) {
    if (!force && PUBLIC_NUMBERS) return Promise.resolve(PUBLIC_NUMBERS);
    return api("/public/numbers").then(function (r) {
      if (r.body && r.body.ok) PUBLIC_NUMBERS = r.body;
      return PUBLIC_NUMBERS;
    }).catch(function () { return null; });      // 失败静默降级，页面照常显示
  }
  function showRank(sel, text, n) {
    var el = $(sel);
    if (!el || !n) return;
    el.innerHTML = text.replace("{n}", '<span class="rank-num">' + n + '</span>');
    el.style.display = "";

    // 数字从基数滚到目标值：让"人正在变多"这件事被看见，一行字的说服力靠它撑
    var num = el.querySelector(".rank-num");
    if (!num) return;
    var to = Number(n);
    var from = Math.min(RANK_BASE, to);          // 起始不低于基数，不会出现 0 到 99 的空跑
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !isFinite(to) || from >= to) { num.textContent = to; return; }

    // 用定时器而不是 rAF：微信里 rAF 会被节流甚至暂停，
    // 一旦停在起点，用户看到的就是一个错数（99 而不是 102）。
    var t0 = Date.now(), timer = 0;
    num.textContent = from;
    timer = window.setInterval(function () {
      var p = Math.min(1, (Date.now() - t0) / 620);
      var e = 1 - Math.pow(1 - p, 3);            // easeOutCubic：先快后慢，收尾稳
      num.textContent = Math.round(from + (to - from) * e);
      if (p >= 1) { window.clearInterval(timer); num.textContent = to; }
    }, 40);
    // 双重兜底：无论动画走没走，1 秒后值一定是它该是的样子
    window.setTimeout(function () {
      window.clearInterval(timer);
      num.textContent = to;
    }, 1000);
  }

  // ---- 报名序号展示口径 ----
  // 不做随机、不做分档：以 99 为起点，按真实报名数顺位递增。
  // 第 1 位报名显示 100，之后每多一位真实报名 +1，永远单调递增。
  // 只影响成功页这一句「你是第 N 位」；后台统计、画像与导出仍全部使用真实数。
  var RANK_BASE = 99;
  function displaySignupNo(real) {
    return RANK_BASE + (Number(real) || 0);
  }

  // ---- 表单放弃：记录「填到第几项走的」，活动后回答漏斗断点才有数据 ----
  var SIGNUP_DONE = false;
  function trackFormAbandon(from, to) {
    if (from !== "signup" || to === "signup" || SIGNUP_DONE) return;
    var f = $("#signup-form");
    if (!f) return;
    // 进度口径交给 form-render：字段是可配的，这里再写一遍字段名就白改了
    var p = frProgress();
    if (!p.done) return;
    trackEvent("form_abandon", "signup", { filled: p.done, total: p.total, step: SU.step });
  }

  // ---- 首页字号单位 --u：必须等于「舞台实际宽度 / 941」，不是视口宽 ----
  // 设计稿坐标全按 941 宽算。手机上舞台宽≈视口宽，两者等价；
  // PC / 平板被高度限制住，舞台只有 340 宽而视口 1000 宽，用视口宽就会把字放大三倍、
  // 整片溢出重叠——这就是电脑端微信打开时的样子。改成测量后写入，任何尺寸都不会错。
  var LAST_U = 0;
  function fitIntro() {
    var safe = document.querySelector(".intro-safe");
    if (!safe) return;
    var w = safe.getBoundingClientRect().width;
    if (!w) return;
    var u = w / 941;
    if (Math.abs(u - LAST_U) < 0.0005) return;   // 值没变就不写，免得多余重排
    LAST_U = u;
    safe.style.setProperty("--u", u + "px");
  }

  // ---- 键盘避让：微信键盘弹起会压缩 visualViewport，报名页固定尾栏随之收缩 ----
  function syncViewportHeight() {
    var vv = window.visualViewport;
    var h = vv ? vv.height : window.innerHeight;
    if (h > 0) document.documentElement.style.setProperty("--vvh", h + "px");
  }
  function bindViewport() {
    syncViewportHeight();
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncViewportHeight);
      window.visualViewport.addEventListener("scroll", syncViewportHeight);
    }
    window.addEventListener("resize", syncViewportHeight);
    window.addEventListener("resize", fitIntro);      // 转屏 / 窗口拉伸时重算字号单位
    window.addEventListener("orientationchange", function () { setTimeout(fitIntro, 220); });
    $all("#signup-form input, #signup-form select").forEach(function (el) {
      el.addEventListener("focus", function () {
        setTimeout(function () {
          if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 260);
      });
    });
  }

  // ---- 背景音乐 ----
  // 播放时机：安卓/桌面配置到位后直接试播；iOS 微信禁止自动播放，等首次交互再起。
  // 音量压到 0.3 并做 0.8s 渐入，避免自动播时突然砸出来。
  // 图标旋转绑 audio 的 playing/pause 事件，而不是开关意图——被系统拦下时不会空转。
  // 后台可关（关闭后连文件都不加载）、可换曲（url 由 /api/config 下发）。
  var BGM_VOL = 0.3, BGM_EL = null, BGM_BTN = null;

  function bgmPaint() {
    if (!BGM_EL || !BGM_BTN) return;
    var playing = !BGM_EL.paused;
    BGM_BTN.classList.toggle("is-off", !playing);
    BGM_BTN.setAttribute("aria-pressed", playing ? "true" : "false");
  }
  function bgmFadeIn() {
    var a = BGM_EL; if (!a) return;
    var t0 = Date.now();
    var timer = setInterval(function () {
      var k = Math.min(1, (Date.now() - t0) / 800);
      a.volume = BGM_VOL * k;
      if (k >= 1) clearInterval(timer);
    }, 60);
  }
  function bgmPlay() {
    var a = BGM_EL; if (!a || !a.paused) return;
    var p = a.play();
    // 不等待 play() 的 promise：部分环境（含弱网首帧）它可能长时间 pending，
    // 那样会出现「paused 已是 false、图标却还显示关闭」。这里立即按状态上屏。
    bgmPaint();
    bgmFadeIn();
    if (p && p.catch) p.catch(function () { bgmPaint(); });
  }
  // 每次配置刷新后调用：决定显不显示开关、用哪个文件、要不要开播
  function applyBgm() {
    if (!BGM_EL || !BGM_BTN) return;
    if (/^#\/admin/.test(location.hash)) {          // 后台是工作人员在用，不放音乐
      BGM_BTN.style.display = "none";
      if (!BGM_EL.paused) BGM_EL.pause();
      return;
    }
    var b = (CONFIG && CONFIG.bgm) || null;
    if (b && b.enabled === false) {
      BGM_BTN.style.display = "none";               // 后台关了：隐藏开关，也不加载文件
      if (!BGM_EL.paused) BGM_EL.pause();
      return;
    }
    BGM_BTN.style.display = "";
    // 配置拿不到时用内置默认，别让音乐因为一次接口抖动就没了
    var url = (b && b.url) || "audio/bgm-full-60s-96k.mp3";
    if (BGM_EL.getAttribute("src") !== url) {
      BGM_EL.setAttribute("src", url);              // 首次加载或后台换了曲目
      BGM_EL.load();
    }
    bgmPlay();
  }