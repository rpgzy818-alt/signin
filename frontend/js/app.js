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
/* 动态表单渲染器（P3-b）
 *
 * 报名页原本把 11 个字段名写死在四处：进度条、草稿、编辑回填、两步提交校验。
 * 运营想加一个字段就要改五处代码，于是「字段可配」这件事运营根本用不上。
 * 这里把「schema → DOM」和「DOM → 值」两个方向收成一个模块，signup.js 从此
 * 不再出现任何具体字段名。
 *
 * ## 值存在哪
 *
 * 每个字段在 DOM 里都有一个 `name=<key>` 的 input：
 *   · 文本 / 数字 / 邮箱：真实输入框
 *   · 选择类（下拉、分段、网格）：hidden input，点按钮组时把值写进去
 * 多选统一以「、」连接存单值（与后端 form.py 的口径一致，导出到 CSV 不用转义）。
 *
 * 这样 `form.elements` 依旧可用，草稿/回填/提交三处都能统一遍历，
 * 不需要再为某个字段名单独写一行。
 *
 * ## 与后端的分工
 *
 * 这里只做「让用户少犯错」的前端校验，最终校验在 backend/form.py。
 * 提示文案按 schema 的 label 拼，不硬编码「请填写姓名」——改了标签文案要跟着变。
 *
 * ## display 约定（决定视觉形态，不影响数据）
 *
 *   pick   按钮 + 底部选项弹层（下拉、年月）
 *   seg    是 / 否 两段式（标题在框外）
 *   grid   纯按钮网格，无标题（如留学国家）
 *   gridt  按钮网格 + 标题行 + 已选计数（如意向方向）
 */

var FR_SEP = "、";
var FR_FIELDS = [];          // 当前活动生效的字段定义，openPick 等处复用

function frSetFields(fields) { FR_FIELDS = fields || []; }

function frByName(key) {
  for (var i = 0; i < FR_FIELDS.length; i++) {
    if (FR_FIELDS[i].key === key) return FR_FIELDS[i];
  }
  return null;
}

function frEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* 展示形态：schema 没写 display 时按类型给默认值 */
function frDisplay(f) {
  if (f.display) return f.display;
  if (f.type === "select") return "pick";
  if (f.type === "date") return "pick";
  if (f.type === "radio") return "seg";
  if (f.type === "checkbox") return (f.options || []).length > 12 ? "grid" : "grid";
  return "input";
}

function frReq(f) { return f.required ? "<b>*</b>" : ""; }

/* 标题行（框外标签）：分段与带标题网格共用 */
function frHeadHtml(f, withCount) {
  var opt = f.required ? "" : '<span class="sec-opt">选填</span>';
  var cnt = withCount ? '<span class="cnt" data-cnt="' + frEsc(f.key) + '"></span>' : "";
  if (withCount) {
    return '<div class="sec-t"><b>' + frEsc(f.label) + " " + opt + "</b>" + cnt + "</div>";
  }
  return '<div class="fld-static"><span>' + frEsc(f.label) + (f.required ? '<b class="req">*</b>' : "") + "</span></div>";
}

/* ---------------- 渲染 ---------------- */

function frFieldEl(f) {
  var disp = frDisplay(f);
  var key = frEsc(f.key);
  var ph = f.placeholder ? frEsc(f.placeholder) : " ";
  var maxlen = f.max_len ? ' maxlength="' + f.max_len + '"' : "";

  // 手机号：区号与号码并排，区号固定 122px（与原版一致，避免号码被挤窄）
  if (f.type === "phone") {
    return '<div class="row2" style="grid-template-columns:122px 1fr" data-fr="' + key + '">' +
      '<label class="fld cc-fld">' +
        '<div class="cc-wrap"><span class="plus">+</span>' +
        '<input name="phone_code" id="cc-input" data-cc type="tel" inputmode="numeric" ' +
        'maxlength="5" value="86" autocomplete="off"></div>' +
        '<span class="fld-lb">国际区号<b>*</b></span>' +
      "</label>" +
      '<label class="fld float-lb">' +
        '<input name="phone" type="tel" inputmode="numeric" maxlength="11" ' +
        'placeholder=" " autocomplete="tel">' +
        '<span class="fld-lb">' + frEsc(f.label) + frReq(f) + "</span>" +
      "</label></div>";
  }

  // 按钮 + 弹层：值在 hidden 里，按钮只负责显示与唤起
  if (disp === "pick") {
    return '<label class="fld" data-fr="' + key + '">' +
      '<input type="hidden" name="' + key + '" value="">' +
      '<button type="button" class="fld-pick" data-pick="' + key + '">' +
      '<span class="fld-pick-v"></span><i class="fld-pick-arrow"></i></button>' +
      '<span class="fld-lb">' + frEsc(f.label) + frReq(f) + "</span></label>";
  }

  // 分段 / 网格：按钮组，单选写单值，多选写「、」串
  if (disp === "seg" || disp === "grid" || disp === "gridt") {
    var cls = disp === "seg" ? "seg2" : (f.type === "checkbox" || (f.options || []).length > 12 ? "grid2" : "grid4");
    var opts = f.options || [];
    var btns = opts.map(function (o, idx) {
      // wide_last：最后一项占整行（意向方向的「其他／暂未确定」就是，
      // 它是兜底选项，不该和具体方向并列）。由 schema 指定，不按字数猜。
      var isWide = (f.wide_last && idx === opts.length - 1) ? " wide" : "";
      return '<button type="button" data-v="' + frEsc(o) + '"' +
        (disp === "seg" ? "" : ' class="gcell' + isWide + '"') + ">" + frEsc(o) + "</button>";
    }).join("");
    var hint = "";
    if (f.hint || f.hint_link) {
      hint = '<p class="help-hint">' + frEsc(f.hint || "");
      if (f.hint_link) {
        hint += '<a href="#" class="help-link" data-modal="' + frEsc(f.hint_link.modal) + '">' +
          frEsc(f.hint_link.text) + "</a>";
      }
      hint += "</p>";
    }
    return '<div data-fr="' + key + '" data-kind="' + disp + '">' +
      (disp === "grid" ? "" : frHeadHtml(f, disp === "gridt" || f.type === "checkbox")) +
      '<input type="hidden" name="' + key + '" value="">' +
      '<div class="' + cls + '" data-group="' + key + '">' + btns + "</div>" +
      hint + "</div>";
  }

  // 文本类
  if (f.type === "textarea") {
    return '<label class="fld" data-fr="' + key + '">' +
      '<textarea name="' + key + '" rows="3" placeholder=" "' + maxlen + '></textarea>' +
      '<span class="fld-lb">' + frEsc(f.label) + frReq(f) + "</span></label>";
  }
  var itype = f.type === "email" ? "email" : (f.type === "number" ? "number" : "text");
  var imode = f.type === "number" ? ' inputmode="decimal"' : "";
  var auto = f.key === "name" ? ' autocomplete="name"' : "";
  return '<label class="fld' + (f.key === "name" ? " float-lb" : "") + '" data-fr="' + key + '">' +
    '<input name="' + key + '" type="' + itype + '"' + imode + ' placeholder="' + ph + '"' +
    maxlen + auto + ">" +
    '<span class="fld-lb">' + frEsc(f.label) + frReq(f) + "</span></label>";
}

/* 按 width 组装一行：两个连续的 half 字段并排（姓名+性别就是这种），
   其余整行。phone 自己就是两列结构，不参与配对。 */
function frFieldsHtml(fields) {
  var out = [], i = 0;
  while (i < fields.length) {
    var f = fields[i], g = fields[i + 1];
    if (f.width === "half" && f.type !== "phone" && g && g.width === "half" && g.type !== "phone") {
      out.push('<div class="row2">' + frFieldEl(f) + frFieldEl(g) + "</div>");
      i += 2;
    } else {
      out.push(frFieldEl(f));
      i += 1;
    }
  }
  return out.join("");
}

/* 把 steps 渲染进各自的 pane。panes 形如 {1: el, 2: el}。 */
function frRender(panes, steps) {
  var all = [];
  (steps || []).forEach(function (s) {
    var pane = panes[s.step];
    if (!pane) return;
    pane.innerHTML = frFieldsHtml(s.fields || []);
    all = all.concat(s.fields);
  });
  frSetFields(all);
  frBindGroups();
  frBindModalLinks();
  // 有上限的字段一开始就要显示「已选 0/N」，否则计数行是空的，
  // 用户点第一下才突然冒出来一段文字
  all.forEach(function (f) { if (f.max_select) frPaintGroup(f.key); });
  return all;
}

/* 说明弹层的入口：schema 指定打开哪个 modal，这里只按 id 找，不认字段名。
   全局绑一次——表单是异步渲染的，逐个绑会漏掉后渲染的那批。 */
function frBindModalLinks() {
  if (document.__frModalBound) return;
  document.__frModalBound = true;
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("[data-modal]") : null;
    if (!a) return;
    e.preventDefault();
    var m = document.getElementById(a.getAttribute("data-modal"));
    if (m) m.style.display = "flex";
  });
}

/* 按钮组点击：单选互斥、多选切换、多选有上限时拦一下 */
function frBindGroups() {
  $all("[data-group]").forEach(function (group) {
    if (group.dataset.frBound) return;
    group.dataset.frBound = "1";
    group.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button[data-v]") : null;
      if (!b) return;
      var key = group.getAttribute("data-group");
      var f = frByName(key);
      var input = group.parentNode.querySelector('input[name="' + key + '"]');
      if (!f || !input) return;
      var v = b.getAttribute("data-v");
      var max = f.max_select || (f.type === "checkbox" ? 99 : 1);

      if (f.type === "checkbox") {
        var arr = frSplit(input.value);
        var i = arr.indexOf(v);
        if (i >= 0) arr.splice(i, 1);
        else {
          if (arr.length >= max) { toast("最多选 " + max + " 项"); return; }
          arr.push(v);
        }
        input.value = arr.join(FR_SEP);
      } else {
        input.value = (input.value === v ? "" : v);
      }
      frPaintGroup(key);
      frAfterChange(key);
    });
  });
}

/* 按 hidden 的值刷新按钮的选中态与计数 */
function frPaintGroup(key) {
  var f = frByName(key);
  var wrap = document.querySelector('[data-fr="' + key + '"]');
  if (!f || !wrap) return;
  var input = wrap.querySelector('input[name="' + key + '"]');
  var cur = frSplit(input ? input.value : "");
  $all('[data-group="' + key + '"] button[data-v]').forEach(function (b) {
    b.classList.toggle("on", cur.indexOf(b.getAttribute("data-v")) >= 0);
  });
  var cnt = wrap.querySelector('[data-cnt]');
  if (cnt && f.max_select) cnt.textContent = "已选 " + cur.length + "/" + f.max_select;
}

function frAfterChange(key) {
  frApplyVisibility();
  saveDraft();
  refreshProgress();
  var f = frByName(key);
  if (f) trackEvent("field_fill", "signup", { field: key, value_len: 1 });
}

function frSplit(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s.slice();
  return String(s).split(FR_SEP).map(function (x) { return x.trim(); })
    .filter(function (x) { return !!x; });
}

/* ---------------- 取值 / 回填 ---------------- */

function frForm() { return $("#signup-form"); }

function frCollect() {
  var form = frForm(), out = {};
  if (!form) return out;
  FR_FIELDS.forEach(function (f) {
    if (f.type === "phone") {
      var p = form.elements[f.key];
      var c = form.elements["phone_code"];
      out[f.key] = p ? p.value : "";
      out["phone_code"] = c ? (c.value.replace(/\D/g, "") || "86") : "86";
      return;
    }
    var el = form.elements[f.key];
    out[f.key] = el ? el.value : "";
  });
  return out;
}

function frFill(values) {
  var form = frForm();
  if (!form || !values) return;
  FR_FIELDS.forEach(function (f) {
    var v = values[f.key];
    if (f.type === "phone") {
      if (form.elements[f.key]) form.elements[f.key].value = v || "";
      var cc = values["phone_code"] || "86";
      if (form.elements["phone_code"]) form.elements["phone_code"].value = cc;
      return;
    }
    if (v == null) v = "";
    if (form.elements[f.key]) form.elements[f.key].value = v;
  });
  FR_FIELDS.forEach(function (f) { frPaintGroup(f.key); });
  frApplyVisibility();
  syncSignupLabels();
  refreshProgress();
}

/* ---------------- 条件显示 ---------------- */

function frVisible(f, values) {
  var c = f.visible_when;
  if (!c) return true;
  var cur = values[c.key];
  var op = c.op || "eq";
  var t = c.value;
  var curArr = Array.isArray(cur) ? cur : frSplit(cur);
  if (op === "nonempty") return curArr.length > 0;
  if (op === "in") {
    var opts = Array.isArray(t) ? t : [t];
    return curArr.some(function (x) { return opts.indexOf(x) >= 0; });
  }
  var same = curArr.indexOf(t) >= 0;
  return op === "eq" ? same : !same;
}

/* 隐藏的字段：整块收起来，同时清空值。
   不清空会出现「选了是→填了国家→改回否」把美国带进库的脏数据。 */
function frApplyVisibility() {
  var vals = frCollect();
  FR_FIELDS.forEach(function (f) {
    var wrap = document.querySelector('[data-fr="' + f.key + '"]');
    if (!wrap) return;
    var vis = frVisible(f, vals);
    if (!vis && !wrap.hidden) {
      wrap.hidden = true;
      var form = frForm();
      if (f.type === "phone") {
        if (form.elements[f.key]) form.elements[f.key].value = "";
      } else if (form.elements[f.key]) {
        form.elements[f.key].value = "";
      }
      frPaintGroup(f.key);
    } else if (vis) {
      wrap.hidden = false;
    }
  });
  // 第一步出现条件字段时整页切紧凑档：多出一整块国家网格，
  // 不加 tight 会把提交按钮挤出首屏。判据是「有条件字段当前可见」，
  // 不是「有字段被隐藏」——后者在多数页面恒为真，等于永远紧凑。
  var p1 = $("#su-pane1");
  if (p1) {
    var extra = FR_FIELDS.some(function (f) {
      return f.visible_when && frVisible(f, vals);
    });
    p1.classList.toggle("tight", extra);
  }
}

/* ---------------- 进度 ---------------- */

function frProgress() {
  var vals = frCollect();
  var done = 0, total = 0;
  FR_FIELDS.forEach(function (f) {
    if (!frVisible(f, vals)) return;
    total++;
    var v = vals[f.key];
    if (f.type === "phone") v = vals["phone_code"] === "86" ? v : v;
    if (f.type === "checkbox") { if (frSplit(v).length) done++; return; }
    if (String(v == null ? "" : v).trim()) done++;
  });
  return { done: done, total: total || 1 };
}

/* ---------------- 前端校验 ---------------- */

/* 只校验指定步骤（跨步的必填由后端 missing_required 兜底），返回第一条错误。 */
function frValidate(step, values) {
  var err = null;
  FR_FIELDS.forEach(function (f) {
    if (err || (step && f.step !== step)) return;
    if (!frVisible(f, values)) return;
    var v = values[f.key];
    var empty = f.type === "checkbox" ? !frSplit(v).length : !String(v == null ? "" : v).trim();

    if (f.required && empty) {
      var verb = (f.type === "radio" || f.type === "select" || f.type === "checkbox" || f.type === "date") ? "请选择" : "请填写";
      err = { key: f.key, msg: verb + f.label };
      return;
    }
    if (empty) return;

    if (f.type === "phone") {
      var cc = values["phone_code"] || "86";
      var num = String(v).replace(/\D/g, "");
      if (cc === "86" && !/^1[3-9]\d{9}$/.test(num)) {
        err = { key: f.key, msg: "手机号格式不正确，请填写 11 位大陆手机号" };
      } else if (cc !== "86" && (num.length < 4 || num.length > 15)) {
        err = { key: f.key, msg: "请填写有效号码" };
      }
      return;
    }
    if (f.type === "text" || f.type === "textarea") {
      var s = String(v);
      if (f.min_len && s.length < f.min_len) err = { key: f.key, msg: f.label + "至少 " + f.min_len + " 字" };
      else if (f.max_len && s.length > f.max_len) err = { key: f.key, msg: f.label + "不能超过 " + f.max_len + " 字" };
      return;
    }
    if (f.type === "checkbox") {
      var n = frSplit(v).length;
      if (f.min_select && n < f.min_select) err = { key: f.key, msg: f.label + "至少选 " + f.min_select + " 项" };
      else if (f.max_select && n > f.max_select) err = { key: f.key, msg: f.label + "最多选 " + f.max_select + " 项" };
      return;
    }
    if (f.type === "date") {
      if (!/\d{4}/.test(String(v))) err = { key: f.key, msg: f.label + "格式不正确" };
      return;
    }
    if (f.type === "email") {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) err = { key: f.key, msg: f.label + "格式不正确" };
      return;
    }
  });
  return err;
}

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
  function mapUris() {
    var q = encodeURIComponent(EVT.poiName);
    var g = EVT.gcj, b = EVT.bd09, w = EVT.wgs84;
    return {
      // 高德 to = 经度,纬度,名称（GCJ-02）
      amap: "https://uri.amap.com/navigation?to=" + g.lng + "," + g.lat + "," + q +
            "&mode=car&policy=1&src=h5&coordinate=gaode&callnative=1",
      // 腾讯 tocoord = 纬度,经度（GCJ-02，顺序与高德相反）
      qq:   "https://apis.map.qq.com/uri/v1/routeplan?type=drive&to=" + q +
            "&tocoord=" + g.lat + "," + g.lng + "&referer=h5",
      // 百度 destination = 纬度,经度，必须声明 bd09ll
      baidu: "https://api.map.baidu.com/direction?destination=latlng:" + b.lat + "," + b.lng +
             "|name:" + q + "&mode=driving&coord_type=bd09ll&output=html&src=h5",
      // Apple / geo 用 WGS-84，顺序 纬度,经度
      apple: "https://maps.apple.com/?daddr=" + w.lat + "," + w.lng + "&dirflg=d&q=" + q,
      geo:   "geo:" + w.lat + "," + w.lng + "?q=" + w.lat + "," + w.lng + "(" + q + ")"
    };
  }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function openWxLocation() {
    // wx.openLocation 依赖 wx.config 注入签名；未就绪返回 false，改走 URI 链路
    if (!window.wx || !window.wx.openLocation) return false;
    try {
      window.wx.openLocation({
        latitude: EVT.gcj.lat, longitude: EVT.gcj.lng,   // GCJ-02，顺序 纬度,经度
        name: EVT.poiName, address: EVT.poiAddress, scale: 18
      });
      return true;
    } catch (e) { return false; }
  }
  // 预留：直接唤起高德（当前导航按钮改为拉起选择面板，此函数备用）
  function openNav() {
    var u = mapUris();
    // 主链路＝高德（callnative=1 由高德 H5 唤起 App）；微信内也先走高德，不用微信内置地图顶掉它
    var left = false;
    function onVis() { if (document.hidden) left = true; }
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", function () { left = true; }, { once: true });
    location.href = u.amap;
    // 3 秒兜底：仅当页面仍可见（高德未拉起）才换下一条，避免已进高德又被二次跳转
    setTimeout(function () {
      document.removeEventListener("visibilitychange", onVis);
      if (left || document.hidden) return;
      if (isWeChat() && EVT.wxSdkReady && openWxLocation()) return;  // 微信内先试原生地图
      if (isWeChat()) location.href = u.qq;        // 再退腾讯（微信内不支持 geo）
      else if (isIOS()) location.href = u.apple;   // iOS 直接 Apple 地图
      else location.href = u.geo;                  // 安卓系统地图
    }, 3000);
  }
  function copyAddress() {
    var text = EVT.address + "，" + EVT.poiAddress;
    function done() { toast("地址已复制，可粘贴到地图 App"); }
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove(); done();
      } catch (e) { toast("复制失败，请长按地址手动复制"); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
  }
  function openMoreMaps() {
    // 微信内点 https 地图链接只会开网页版，还得跳应用市场，地址也带不过去；
    // 唯一能直接导航的是 JSSDK 的 openLocation（打开微信内置地图，坐标用 GCJ-02）。
    if (isWeChat() && WX_SDK_OK && window.wx && wx.openLocation) {
      wx.openLocation({
        latitude: EVT.gcj.lat,
        longitude: EVT.gcj.lng,
        name: EVT.venueName,
        address: "数智北京创新中心 46 号楼展示中心",
        scale: 17
      });
      return;
    }
    var p = $("#map-panel"); if (!p) return;
    var u = mapUris();
    $all("[data-map]", p).forEach(function (a) { a.href = u[a.getAttribute("data-map")] || "#"; });
    p.style.display = "flex";
  }
  function closeMoreMaps() { var p = $("#map-panel"); if (p) p.style.display = "none"; }
  function bindVenue() {
    var ac = $("#add-cal"); if (ac) ac.addEventListener("click", addToCalendar);
    // 导航＝拉起地图选项面板，由用户选具体地图（高德排首、标推荐）
    var nb = $("#nav-btn"); if (nb) nb.addEventListener("click", openMoreMaps);
    var ca = $("#copy-addr"); if (ca) ca.addEventListener("click", function (e) { e.preventDefault(); copyAddress(); });
    var mc = $("#map-close"); if (mc) mc.addEventListener("click", closeMoreMaps);
    var mk = $("#map-mask"); if (mk) mk.addEventListener("click", closeMoreMaps);
  }

  // ---- 首页上滑进报名（手势 + 滚轮 + 点击提示三路兜底，任一可用即可）----
  function introActive() {
    var v = $("#view-intro");
    return !!v && v.classList.contains("active");
  }
  function bindSwipe() {
    var view = $("#view-intro");
    var hint = $("#swipe-hint");
    // 提示区本身就是按钮：点它也进，不依赖手势
    if (hint) hint.addEventListener("click", function () { go("event"); });
    // 活动页 → 报名页；报名页顶部返回活动页
    var gs = $("#go-signup");
    if (gs) gs.addEventListener("click", function () {
      // 后台关掉报名（或活动已结束）时，不再放人进表单——进去填完才被拒是最差的体验
      if (CONFIG.event_ended || !CONFIG.registration_open) { go("status"); return; }
      go("signup");
    });
    var be = $("#back-event");
    if (be) be.addEventListener("click", function () { go("event"); });
    if (!view) return;
    var screenEl = view.querySelector(".intro-screen");

    var sy = 0, sx = 0, up = false, lock = false;
    function enter() {
      if (lock || !introActive()) return;
      lock = true; go("event");
      setTimeout(function () { lock = false; }, 600);   // 防抖：一次滑动只跳一次
    }
    view.addEventListener("touchstart", function (e) {
      if (!introActive() || !e.touches.length) return;
      sy = e.touches[0].clientY; sx = e.touches[0].clientX; up = false;
      if (screenEl) screenEl.classList.add("dragging");   // 拖动期间不要过渡，否则跟手发黏
    }, { passive: true });
    view.addEventListener("touchmove", function (e) {
      if (!introActive() || !e.touches.length) return;
      var dy = sy - e.touches[0].clientY;              // 向上为正
      var dx = Math.abs(sx - e.touches[0].clientX);
      if (dy > 28 && dy > dx) up = true;               // 竖向滑动且方向朝上
      // 整屏跟着手指走一小段：位移上限 46px，越推越淡。
      // 目的是「推得动」的回应感，不是真把页面拖出去。
      if (dy > 0 && dy > dx && screenEl) {
        // 缩小而不是上移：上移会在底部拽出一条边，缩小只是四边各让出几像素，
        // 露出的是同图虚化底，看起来像页面被「抬起来」。
        var k = Math.min(dy * 0.3, 34);
        screenEl.style.transform = "scale(" + (1 - k / 1500).toFixed(4) + ")";
      }
    }, { passive: true });
    view.addEventListener("touchend", function () {
      if (screenEl) {
        screenEl.classList.remove("dragging");          // 松手交给 CSS 回弹
        screenEl.style.transform = "";
        screenEl.style.opacity = "";
      }
      if (up) enter();
    }, { passive: true });
    view.addEventListener("touchcancel", function () {
      if (screenEl) {
        screenEl.classList.remove("dragging");
        screenEl.style.transform = ""; screenEl.style.opacity = "";
      }
    }, { passive: true });
    // 桌面/微信 PC 端预览：往下滚即进
    view.addEventListener("wheel", function (e) {
      if (introActive() && e.deltaY > 12) enter();
    }, { passive: true });
  }

  // ---- 签到 ----
  // 签到页只有一张卡：状态、现场节奏、下一步都渲染在同一个容器里，
  // 不再「上面一个结果盒、下面一个按钮」两块拼接（那样像两个模块硬拼在一起）。
  function onCheckinEnter() {
    var box = $("#checkin-state");
    if (!getOpenid()) {
      box.innerHTML = ckWarn("没能读到你的微信身份", "退出后重新扫码，即可进入签到", "");
      return;
    }
    // 首次落地时 ME_STATE 还没回来，显示加载态而不是报错——loadState 完成后会重绘
    if (!ME_STATE) {
      box.innerHTML = '<div class="ck-skel">正在核对签到状态…</div>';
      return;
    }
    if (ME_STATE.state === "checked_in") { ckRenderDone(); return; }
    // 闸门未开（没到时间或已被后台关闭）：直接给提示页，不让用户白等一次接口往返
    if (CONFIG.gate && CONFIG.gate.checkin_open === false) { ckRenderGateClosed(); return; }
    if (ME_STATE.state === "unregistered") { ckRenderUnreg(); return; }
    ckSubmit();
  }

  function ckFlow(h, t) {
    return '<div class="ck-f"><b>' + h + '</b><span>' + t + '</span></div>';
  }

  // G7 凭证找回：签到成功页一行弱提示，点开就是码 + 二维码。
  // 不新建页面、不做账号体系；复用 signup.js 的 qrSvg，同一微信打开即可。
  function openCredModal() {
    var m = $("#cred-view-modal");
    if (!m) return;
    var code = (ME_STATE && ME_STATE.credential_code) || "";
    var text = $("#cvm-code"), qr = $("#cvm-qr");
    if (text) text.textContent = code || "—";
    if (qr) qr.innerHTML = code ? qrSvg(siteUrl("#/verify?code=" + encodeURIComponent(code)), 6, 4) : "";
    m.style.display = "flex";
    if (!m.dataset.bound) {
      m.dataset.bound = "1";
      var close = function () { m.style.display = "none"; };
      var x = $("#cvm-close"); if (x) x.addEventListener("click", close);
      var mask = $("#cvm-mask"); if (mask) mask.addEventListener("click", close);
    }
  }

  // 三份领取卡已下线（平台化 P0）：平台内置任何机构专属权益都会让别的机构
  // 一眼看出这是别人的系统。活动级入口统一走后台 CTA 配置（/config.ctas），
  // 这里只留空函数保持调用点不变，前端不再写死任何权益文案。
  function giftRowsHTML(scene) { return ""; }
  function bindGiftRows(scopeSel, scene) { /* 入口由 applyCtas 统一渲染 */ }

  // 已完成签到：结果与现场节奏同卡展开，不再跳一层结果页
  function ckRenderDone() {
    var box = $("#checkin-state");
    var at = fmtTime(ME_STATE.checked_at);
    var hhmm = at.length >= 16 ? at.slice(11, 16) : "";
    // 现场补录（walkin）走的也是这张结果页：签到记录 method 就是 walkin，
    // 直接读状态自带的口径，不用额外传标记，刷新后也不会退化成「签到成功」。
    var isWalkin = ME_STATE.method === "walkin";
    box.innerHTML =
      '<div class="ck-card ck-card-done">' +
        // v126：头部改左右结构——图标在左、三行文案在右，且文案整体居中。
        // 原来「图标 / 标题 / 副题 / 时间」四段竖排，光头部就吃掉约 120px，
        // 改左右后省下的高度全给领卡区。
        '<div class="ck-head">' +
          '<div class="ck-badge" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.6 9.6 17.6 19.6 6.8"/></svg>' +
          '</div>' +
          '<div class="ck-head-txt">' +
            '<h2 class="ck-title">' + (isWalkin ? "补录并签到成功" : "签到成功") + '</h2>' +
            '<p class="ck-sub">欢迎参加本次活动</p>' +
            '<p class="ck-stamp">' + (hhmm ? hhmm + " 完成签到" : "已完成签到") + '</p>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="su-cred-link" id="cred-view">参会凭证 · 点击查看</button>' +
        // 到场人数是公共数据、不是个人信息，放在头部外面单独一行居中胶囊，
        // 挤进右栏会把三行文案撑成四行、破坏"三行"的节奏
        '<p class="ck-rank" id="checkin-rank" style="display:none"></p>' +
        '<div class="ck-flow">' +
          ckFlow("签到", "到场核验") + ckFlow("活动", "按现场指引参与") +
        '</div>' +
        giftRowsHTML("checkin") +
        // 底部标识（原广告位）：只有体验版渲染，见 core.js techBadgeHTML。
        // 只放这一态——未开放/异常页不放，那些页是问题现场，别混进推广。
        techBadgeHTML() +
      '</div>';

    var cv = $("#cred-view"); if (cv) cv.onclick = openCredModal;
    publicNumbers().then(function (d) {
      // 与报名顺位同口径：以 99 为起点，按真实到场数递增，
      // 让「今天已有 N 人到场」和「你是第 N 位报名」用的是同一把尺子
      if (d) showRank("#checkin-rank", "今天已有 {n} 位来宾到场", displaySignupNo(d.today_checkin));
    });
    bindGiftRows("#checkin-state", "checkin");
  }

  // 闸门未开：给独立提示页 + 三份领取，别让扫码的人对着空白页退出
  function ckRenderGateClosed() {
    var box = $("#checkin-state");
    var g = (CONFIG.gate && CONFIG.gate.window) || {};
    var span = "";
    if (g.start && g.end) {
      span = fmtTime(g.start) + " 至 " + fmtTime(g.end);
    }
    box.innerHTML =
      // v127：与签到成功页同一套头部语言——图标在左、文案在右，
      // 省下的纵向空间全给领卡区。原来四段竖排把卡片顶上撑得很空。
      '<div class="ck-card ck-pad ck-card-notice">' +
        '<div class="ck-head">' +
          '<div class="ck-badge ck-badge-off" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
              '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.6V12l3 1.8"/></svg>' +
          '</div>' +
          '<div class="ck-head-txt">' +
            '<h2 class="ck-title">签到尚未开放</h2>' +
            // 副题只留一句短话：头部是「图标 + 两行字」的左右结构，
            // 副题一长，文字块就把整组撑宽，图标被顶到卡片最左边，
            // 和标题直接断开。时段这类长信息一律下沉到下面的 ck-lead。
            '<p class="ck-sub ck-sub-quiet">还没到签到时间</p>' +
          '</div>' +
        '</div>' +
        '<p class="ck-lead">' +
          (span ? '签到时段 ' + esc(span) + '。' : '') +
          '如有疑问，可联系下方客服咨询。</p>' +
        // 这一态人还没签到，别用 success 那套「报名成功」的语气
        giftRowsHTML("signup") +
      '</div>';
    bindGiftRows("#checkin-state", "signup");
    trackEvent("checkin_gate_closed", "checkin");
  }

  // 没报名：现场登记一条路，另给「已报名但查不到」的问询出口
  function ckRenderUnreg() {
    var box = $("#checkin-state");
    box.innerHTML =
      '<div class="ck-card ck-pad ck-card-notice">' +
        // v127：同样改左右结构。这一态没有可强调的图标语义，用「填写」的动作图标，
        // 让人一眼看出这页要你动手填东西，而不是只读提示。
        '<div class="ck-head">' +
          '<div class="ck-badge" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M4.6 19.4h14.8"/><path d="M15.8 5.7l2.5 2.5-8.2 8.2-3.3.7.8-3.3z"/></svg>' +
          '</div>' +
          '<div class="ck-head-txt">' +
            '<h2 class="ck-title">现场登记</h2>' +
            // 副题只讲「要准备什么」，下面 ck-lead 讲「还没报名怎么走」，
            // 两行各管一件事，不重复同一句意思
            '<p class="ck-sub ck-sub-quiet">只需姓名和手机号</p>' +
          '</div>' +
        '</div>' +
        '<p class="ck-lead">尚未报名？填写补录信息并签到入场</p>' +
        '<button type="button" class="btn-primary block" id="ck-walkin">填写信息并签到</button>' +
        '<p class="ck-hint">已在线上报名？让工作人员帮你核对手机号。</p>' +
        // 这一态原本只占半屏，下半截是空的。领卡是平台公共权益，
        // 和「有没有报名」无关，顺手把空出来的位置填上。
        giftRowsHTML("signup") +
      '</div>';
    var w = $("#ck-walkin");
    if (w) w.onclick = function () { go("walkin"); };
    bindGiftRows("#checkin-state", "signup");
  }

  // 已报名未签到：扫现场码即签。失败给重试——现场网络抖动是常态，
  // 让用户退出重扫是最差的兜底。
  function ckSubmit() {
    var box = $("#checkin-state");
    box.innerHTML = '<div class="ck-skel">正在为你签到…</div>';
    postResilient("/checkin", { openid: getOpenid() }).then(function (r) {
      if (r && r.body && (r.body.status === "checked" || r.body.status === "already")) {
        loadState().then(function () { ckRenderDone(); });
        return;
      }
      if (r && r.body && r.body.code === "gate_closed") {
        ckRenderGateClosed();     // 与服务端判定保持一致，统一落到提示页
        return;
      }
      ckRenderFail(r);
    }).catch(function () { ckRenderFail(null); });
  }

  function ckRenderFail(r) {
    trackEvent("checkin_fail", "checkin", { reason: r ? "http_" + r.status : "network" });
    var box = $("#checkin-state");
    box.innerHTML = ckWarn("这次没签上", "网络有点慢，再点一次就好。",
      '<button type="button" class="btn-primary block" id="ck-retry">重新签到</button>' +
      '<p class="ck-manual">也可以把报名手机号报给签到台，由工作人员手工登记。</p>');
    var b = $("#ck-retry");
    if (b) b.onclick = function () { ckSubmit(); };
  }

  function ckWarn(title, desc, extra) {
    return '<div class="ck-card ck-pad ck-card-warn">' +
      '<div class="ck-head">' +
        '<div class="ck-badge ck-badge-warn" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">' +
            '<path d="M12 7.2v6.4"/><circle cx="12" cy="17.4" r="1.35" fill="currentColor" stroke="none"/></svg>' +
        '</div>' +
        '<div class="ck-head-txt">' +
          '<h2 class="ck-title">' + esc(title) + '</h2>' +
          '<p class="ck-sub ck-sub-quiet">' + esc(desc) + '</p>' +
        '</div>' +
      '</div>' + (extra || '') +
      '</div>';
  }

  // ---- 补录 ----
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
  // P8-b 离线核销队列：断网时把「已核对身份、点了确认」的意图暂存本地，
  // 联网后自动补传。去重靠后端 registration_id 唯一索引（P8-a），
  // 前端只管存与传，不判断是否重复——那会引入客户端时钟与状态不一致。
  var OFFLINE_KEY = "checkin_offline_queue";
  var OFFLINE_MAX = 200;
  function offlineQueue() {
    try { return JSON.parse(localStorage.getItem(OFFLINE_KEY) || "[]") || []; }
    catch (e) { return []; }
  }
  function offlinePush(item) {
    var q = offlineQueue();
    if (q.length >= OFFLINE_MAX) return false;
    q.push(item);
    try { localStorage.setItem(OFFLINE_KEY, JSON.stringify(q)); return true; }
    catch (e) { return false; }
  }
  function offlineSave(q) {
    try { localStorage.setItem(OFFLINE_KEY, JSON.stringify(q)); } catch (e) {}
  }
  function syncOfflineQueue() {
    if (!navigator.onLine) return;
    var q = offlineQueue();
    if (!q.length) return;
    api("/verify/offline-sync", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: q })
    }).then(function (r) {
      if (!r.ok || !r.body.ok) return;
      var rows = (r.body.rows || []);
      // 只移除已确认入库的（checked / already）；rejected 留着等人工处理，
      // 但不能无限重试同一个坏凭证——记一次失败次数后丢弃
      var keep = [];
      rows.forEach(function (res, i) {
        if (res.status === "checked" || res.status === "already") return;
        var it = q[i];
        it._fail = (it._fail || 0) + 1;
        if (it._fail < 3) keep.push(it);
      });
      for (var i = rows.length; i < q.length; i++) keep.push(q[i]);
      offlineSave(keep);
      var s = r.body.summary || {};
      if (s.checked || s.already) {
        toast("离线核销已补传：成功 " + ((s.checked || 0) + (s.already || 0)) + " 条");
      }
    }).catch(function () {});
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
    // 联网时预取离线签名凭证（短时有效），断网点确认才能本地暂存
    var offlineToken = "";
    if (navigator.onLine && !r.checked_in) {
      api("/verify/offline-token?token=" + encodeURIComponent(token) +
          "&code=" + encodeURIComponent(code)).then(function (rr) {
        if (rr.ok && rr.body.ok) offlineToken = rr.body.offline_token || "";
      }).catch(function () {});
    }
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
        // P8-b：断网时把已核对身份的核销意图暂存本地，联网后自动补传。
        // 没有离线签名凭证（预取失败/过期）就不能暂存——宁可让工作人员
        // 走补录台，也不能存一个补传时会被拒的无效凭证。
        if (offlineToken && offlinePush({
              token: token, offline_token: offlineToken,
              checked_at: new Date().toISOString(), code: code
            })) {
          toast("已离线登记，联网后自动补传");
          var fc0 = $("#vf-code"); if (fc0) { fc0.value = ""; fc0.focus(); }
          box.innerHTML = '<div class="vf-card vf-empty"><b>已离线登记</b>' +
            '<span>网络恢复后会自动补传，请勿重复核销此人。</span></div>';
        } else {
          toast("网络异常，且无法离线登记，请稍后重试");
        }
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


  function loadState() {
    var oid = getOpenid();
    if (!oid) { ME_STATE = null; STAFF_INFO = null; return Promise.resolve(null); }
    return api("/me?openid=" + encodeURIComponent(oid)).then(function (r) {
      ME_STATE = (r.body && r.body.ok) ? r.body : null;
      return api("/staff/resolve?openid=" + encodeURIComponent(oid));
    }).then(function (s) {
      STAFF_INFO = s.body || { is_staff: false };
      return ME_STATE;
    }).catch(function () { ME_STATE = null; STAFF_INFO = null; return null; });
  }

  function rememberCred() {
    if (!ME_STATE) return;
    try {
      sessionStorage.setItem("cred", JSON.stringify({
        code: ME_STATE.credential_code || "", name: ME_STATE.name || ""
      }));
    } catch (e) {}
  }

  function openQrModal(title, src) {
    var m = $("#qr-modal"), img = $("#qr-modal-img"), t = $("#qr-modal-title");
    if (!m) return;
    if (t) t.textContent = title;
    if (img) img.src = src;
    m.style.display = "flex";
  }
  function bindQrModal() {
    var close = function () { var m = $("#qr-modal"); if (m) m.style.display = "none"; };
    var c = $("#qr-modal-close"), mask = $("#qr-mask");
    if (c) c.addEventListener("click", close);
    if (mask) mask.addEventListener("click", close);
  }

  // 报名成功页：三份领取直接铺在凭证下方，不再多跳一层领奖页
  function renderSuccessCta() {
    var box = $("#success-cta");
    if (!box) return;
    var scene = CONFIG.event_ended ? "ended" : "success";
    box.innerHTML = giftRowsHTML(scene);
    bindGiftRows("#success-cta", scene);
  }

  // 状态页覆盖六态：已签到 / 已报名 / 未报名 / 报名截止 / 记录被关闭 / 活动结束。
  // 每一态都给一条走得通的下一步，不写「未查询到记录」这类系统话。
  // 每种状态给专属图标：用户不用读字就能判断自己处在哪一态
  var ST_BADGE = {
    checked_in:   { c: "",        p: "M4.5 12.6 9.6 17.6 19.6 6.8" },
    registered:   { c: "st-info", p: "M12 7.4v5.4l3.6 2.1" },
    // 未报名原本用一支向上的箭头，读起来像「上传/分享」。
    // 换成铅笔——和签到页「现场登记」同一个语义：这页要你动手填表。
    unregistered: { c: "st-go",   p: "M4.6 19.4h14.8M15.8 5.7l2.5 2.5-8.2 8.2-3.3.7.8-3.3z" },
    closed:       { c: "st-off",  p: "M6 6l12 12M18 6L6 18" },
    ended:        { c: "st-end",  p: "M6 20V5m0 0h11l-2.4 3.4L17 12H6" }
  };
  function paintStatusBadge(st) {
    var b = document.querySelector("#view-status .ok-badge");
    if (!b) return;
    var cfg = ST_BADGE[st] || ST_BADGE.ended;
    b.className = "ok-badge " + cfg.c;
    var path = b.querySelector("svg path");
    if (path) path.setAttribute("d", cfg.p);
  }

  // 现场节奏条：与签到成功页同一条信息（9:30 / 10:00 / 全天）。
  // 已报名、已签到的人用得上；未报名与已结束不显示，别拿无关信息占位。
  function stFlow(show) {
    var f = $("#status-flow");
    if (!f) return;
    if (!show) { f.style.display = "none"; f.innerHTML = ""; return; }
    f.innerHTML = ckFlow("签到", "到场核验") + ckFlow("活动", "按现场指引参与");
    f.style.display = "";
  }

  function renderStatus() {
    var st = ME_STATE && ME_STATE.state;
    paintStatusBadge(st);
    var title = $("#status-title"), sub = $("#status-sub"), detail = $("#status-detail"),
        actions = $("#status-actions"), follow = $("#status-follow");
    if (!title) return;
    actions.innerHTML = "";
    if (follow) follow.style.display = "none";
    stFlow(false);

    // 活动后承接：活动结束不等于服务终点
    if (CONFIG.event_ended) {
      var came = st === "registered" || st === "checked_in";
      paintStatusBadge("ended");
      title.textContent = "本次活动已结束";
      sub.textContent = "活动资料与联系入口继续有效";
      detail.innerHTML = (came ? "感谢到场。" : "本场活动已结束，线上报名已关闭。") +
        "本页仅保留活动资料与咨询入口；如需后续通知，请关注主办方发布的信息。";
      actions.innerHTML = giftRowsHTML("ended");
      bindGiftRows("#status-actions", "ended");
      return;
    }

    if (st === "checked_in") {
      title.textContent = "已完成签到";
      sub.textContent = "欢迎参加本次活动";
      // 时间轴已经由 stFlow 单独铺成三列，这里不再重复写一遍场次
      detail.innerHTML = "签到时间：" + fmtTime(ME_STATE.checked_at);
      stFlow(true);
      actions.innerHTML = giftRowsHTML("checkin");
      bindGiftRows("#status-actions", "checkin");
      return;
    }
    if (st === "registered") {
      title.textContent = "报名成功";
      sub.textContent = "11 月 29 日，现场见";
      detail.innerHTML = "报名信息已记录，活动当天到场扫码即可签到。";
      rememberCred();
      stFlow(true);
      actions.innerHTML = giftRowsHTML("success");
      bindGiftRows("#status-actions", "success");
      return;
    }

    if (!CONFIG.registration_open) {
      paintStatusBadge("closed");
      title.textContent = "报名已截止";
      sub.textContent = "有疑问可联系下方客服";
      detail.innerHTML = "线上报名通道已关闭。<br>" +
        "如需协助，可联系下方客服，我们会尽快回复。";
      // 报名没成，别用「报名成功」那套成功语气
      actions.innerHTML = giftRowsHTML("signup");
      bindGiftRows("#status-actions", "signup");
      return;
    }

    title.textContent = "你还未报名";
    // 副题保持一句短话：头部是左右结构，副题过长会把整组撑宽、图标贴到最左。
    // 「怎么报名、当天怎么签到」这类长说明放下面 detail。
    sub.textContent = "需先完成线上报名";
    // 这一态比别的态多一个「回首页报名」按钮，667 上空间最紧，
    // 详情条压到两行以内，别让提示文案把领卡区挤出屏幕。
    detail.innerHTML = "这张凭证码属于他人，不能替别人签到。<br>" +
      "回首页填写报名信息，活动当天到场签到。";
    // 报名是首要动作，所以排在领卡区上面；下面照样挂领卡入口——
    // 未报名态：保留咨询与资料入口，不依赖本场报名。
    // scene 走 signup 而不是 success：success 的标题是「报名成功」，
    // 放到「还没报名」和「报名已截止」这两态上不成立。
    actions.innerHTML = '<button type="button" class="btn-primary block" id="status-go-signup">回首页报名</button>' +
      giftRowsHTML("signup");
    bindGiftRows("#status-actions", "signup");
    var b = $("#status-go-signup");
    if (b) b.addEventListener("click", function () { go("intro"); });
  }

  function applyStaffVerify() {
    var form = $("#verify-form"), who = $("#verify-who"), lab = $("#verify-token-label");
    if (!form || !STAFF_INFO) return;
    var view = $("#view-verify"); if (view) view.classList.add("active");
    if (who) who.textContent = "当前工作人员：" + (STAFF_INFO.username || "") + " · 核销凭证已自动带入";
    if (lab) lab.style.display = "none";
    form.token.value = STAFF_INFO.token || "";
    var pre = hashParam("code"), tip = $("#verify-result");
    if (pre) {
      form.code.value = pre;
      if (tip) tip.innerHTML = '<div class="state-box state-info">凭证码已带入，点「查询」核对后确认签到</div>';
    }
  }

  function doStaffBind() {
    var box = $("#staff-bind-result");
    if (!box) return;
    var ticket = hashParam("ticket"), oid = getOpenid();
    if (!ticket) { box.textContent = "绑定码缺失，请从后台重新扫码"; return; }
    if (!oid) { box.textContent = "未获取到微信身份，请在微信中重新打开"; return; }
    postJ("/staff/bind", { ticket: ticket, openid: oid }).then(function (r) {
      if (r.body && r.body.ok) {
        box.className = "state-box state-ok";
        box.innerHTML = "绑定成功：" + esc(r.body.username || "") +
          "<br>现在扫参会凭证码即可直接核销，凭证自动带入";
        loadState();
      } else {
        box.className = "state-box state-warn";
        box.textContent = (r.body && r.body.detail) || "绑定失败，请让管理员重新生成绑定码";
      }
    }).catch(function () { box.textContent = "网络异常，请重试"; });
  }

  function routeByState() {
    var route = currentRoute();
    // 后台已拆到 /admin/ 独立站点；用户端不再处理该路由
    // P6 查询页是公开自助入口，任何人（含已签到者）都能看，不被状态导流踢走
    if (route === "query") { renderQuery(); return; }
    if (route === "admin") { go("intro"); return; }
    if (route === "staff-bind") { doStaffBind(); return; }
    if (route === "verify") {
      if (STAFF_INFO && STAFF_INFO.is_staff) { applyStaffVerify(); return; }
      // 非白名单一律不进核销界面。但落地页要分两种：
      //   未报名 → 回首页走完整流程（介绍 → 上滑 → 报名），不直接甩到报名表单；
      //   已报名 → 状态页，按自己状态提示。
      if (ME_STATE && ME_STATE.state === "unregistered") { go("intro"); return; }
      go("status");
      return;
    }
    var st = ME_STATE && ME_STATE.state;
    if (route === "status") { renderStatus(); return; }
    // 活动结束后，已报名/已签到的人统一落在承接页，而不是回到一张过期的凭证
    if (CONFIG.event_ended && (st === "registered" || st === "checked_in")) { go("status"); return; }
    if (route === "checkin") { onCheckinEnter(); return; }
    // 修改信息模式：停在表单并预填，别按状态把人赶回成功页
    if (route === "signup") {
      if (hashParam("edit") === "1") { applyEditMode(); return; }
      resetSignupMode();
    }
    if (st === "checked_in") { go("status"); return; }
    if (st === "registered") {
      rememberCred();
      if (!route || route === "intro" || route === "signup") { go("success"); return; }
      // 状态接口回来后重绘凭证：从历史记录/收藏直接打开 #/success 时，
      // 首轮 render 还没有 sessionStorage 里的凭证码，不补一次会一直显示「—」。
      if (route === "success") { renderSuccess(); renderSuccessCta(); }
      return;
    }
    if (route === "success") go("intro");   // 未报名不该停在报名成功页
  }

  // ---- 后台：现场工作人员配置 ----
  function boot() {
    var start = function () {
      render();                        // 先落地，不等接口，避免白屏
      // 机构入口页（RD-13）：?org=<机构短码> 是明确指名，直接进门面、不进活动流。
      // 带了 ?a=（分享链接 / 物料码）时以活动为准——机构首页只是门面，
      // 不该把一个已经指名要报名某场活动的人拦在门口多点一次。
      var orgCode = getParam("org");
      if (orgCode && !getParam("a")) {
        loadOrgPortal(orgCode).then(renderOrgHome).catch(showOrgMiss);
        return;
      }
      // 先取配置再取状态：机构首页（RD-13）只看配置就够了。
      // 原来两者并行，机构域名下 /me、/staff/resolve 这些活动级接口会被中间件
      // 按设计 404（机构没有可用活动），控制台一屏红字、日志一堆噪音。
      // 串行的代价是活动页多一个 RTT——比每次落地都制造 5 条假错误划算。
      loadConfig().then(function () {
        // 站点/活动不存在（后端 404）：直接落「页面不存在」，不进任何业务流。
        // 泛解析下写错子域、扫到已归档活动的旧码都会走到这条。
        // 放在机构首页判断之前——这不是某家机构的门面，而是「这个地址没有站点」。
        if (CONFIG.loadError) { showVanish(CONFIG.loadError); return; }
        // 机构域名访问根路径：后端只回机构与活动列表（mode=org_home）。
        // 这条分支必须在这里断开——往下走会把默认活动的音乐、草稿角标、
        // 报名状态一并套到机构门面上。
        if (CONFIG.mode === "org_home") { renderOrgHome(CONFIG); return; }
        return loadState().then(function () {
          // 状态接口也可能 404（活动在配置之后被归档）：同样落「页面不存在」，
          // 不给一个字段全是空的报名页。
          if (CONFIG.loadError) { showVanish(CONFIG.loadError); return; }
          applyBgm();          // 配置到位后再决定播不播、用哪个文件
          // 草稿态：不拦访问（要能测报名与签到），只挂一条「预览模式」提示，
          // 让拿到链接的人一眼知道这不是正式活动。数据隔离在发布时做，不在这里。
          if (CONFIG.activity && CONFIG.activity.status === "draft") showDraftBadge();
          routeByState();
        });
      });
      // 来源标记：分享落地与物料码落地都带 from，统一写进 sessionStorage，
      // 后续事件能带上来源。但 share_landing 只给真正的分享——物料码走的是
      // 另一个渠道，混进来会污染「分享→报名」的转化统计。
      var from = getParam("from");
      if (from) {
        try { sessionStorage.setItem("src", from); } catch (e) {}
        if (from === "share") trackEvent("share_landing", "share", { from: from });
      }
    };
    // 微信回调：有 code 则换 openid 后再进入
    var code = getParam("code");
    if (code && isWeChat() && WX_ENABLED) {
      wxExchange(code).then(function (oid) {
        if (oid) { try { localStorage.setItem("openid", oid); } catch (e) {} }
        restoreAfterWx();
        start();
      }).catch(function () { restoreAfterWx(); start(); });
    } else {
      ensureOpenid();
      start();
    }
    $all("[data-go]").forEach(function (b) {
      b.addEventListener("click", function () { go(b.getAttribute("data-go")); });
    });
    // 品牌条返回：目标由 render() 按当前页写入，start() 可能被调用多次，只绑一次
    var brandBack = $("#brandBack");
    if (brandBack && !brandBack.dataset.bound) {
      brandBack.dataset.bound = "1";
      brandBack.addEventListener("click", function () {
        var t = brandBack.getAttribute("data-back-to");
        if (t) go(t);
      });
    }
    bindBgm(); bindSignup(); bindWalkin(); bindVerify();
    bindVenue(); bindSwipe(); bindMaterials();
    bindSuccess(); bindCalModal(); bindImgModal(); initWxSdk();
    bindQrModal(); bindQueryPage();
    // 咨询入口原来只在 loadConfig 的回调里绑。机构首页有两个分支根本不走
    // loadConfig（?org= 显式通道、机构域名下 config 提前返回），页脚
    // 「咨询主办方」就成了死链——这里无条件绑一次，函数内部有幂等保护。
    bindContact();
    // P8-b 离线核销：页面加载与网络恢复时各尝试补传一次
    if (typeof syncOfflineQueue === "function") {
      syncOfflineQueue();
      window.addEventListener("online", syncOfflineQueue);
    }
    // 这里从前还调了 bindAdminStaff / bindRegEdit / bindManualCheckin /
    // fillDtSelects / bindGateWindow / bindSwitchTime —— 六个都是后台函数，
    // 定义在 admin-config.js / admin-staff.js 里，app 产物根本没有。
    // 一行 ReferenceError 会把后面的 bindViewport、bindPick 全挡掉，整页交互半瘫
    // （表现是"点哪都没反应"，但页面看起来正常，很难查）。后台自己的
    // admin-boot 已经在调它们，app 这边不需要。
    bindViewport(); bindPick();
    window.addEventListener("hashchange", function () {
      trackFormAbandon(LAST_ROUTE, currentRoute());
      render();
      // 换页后重算分享悬浮球显隐（报名/签到/成功页不打扰）
      showShareFab();
      loadState().then(routeByState);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
