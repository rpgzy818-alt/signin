/* 运营控制台 · 公共基础（前后台拆分后独立维护）
 * 后台只用到 core.js 里的 6 个工具函数 + API/CONFIG，在这里各放一份，
 * 不抽共享文件——平台化后两端要能独立演进，共享文件会互相牵制。
 * 本文件是后台 IIFE 的开头（与 core.js 片段同角色），裸函数名对后续片段可见。
 * 关键差异：接口前缀固定指向 /api，不用 core.js「跟随页面目录」那套
 * ——后台挂在 /admin/ 下会拼成 /admin/api，是错的。
 */
(function () {
  "use strict";

  // ============ 平台化配置块（约束 1 & 2：所有环境差异集中在这里）============
  // 平台化时只需改这里：把 API_BASE 指向平台网关，把活动标识接入平台上下文，
  // 下面所有业务函数不用动。不要在别处散布 "meeting" / "admin" 字面量。
  var PLATFORM = {
    // 接口基址：本项目前后端同域部署，接口固定在站点根的 /api 下。
    // 页面可能挂在 / 或 /admin/，按目录推导会得到 /admin/api（错的），
    // 所以这里不推导，直接给同域路径。要跨域就改 site-config.js 的 api 字段。
    devApi: "/api",
    // 当前活动标识：单机构版只有一个活动，服务端按默认活动处理
    activityId: getParam("activity") || "current"
  };
  function apiBaseFromPath() {
    // 站点配置优先：绑独立域名或前后端分域时，配置里写死才可靠（见 site-config.js）
    var c = window.__SITE__ || {};
    if (c.api) return String(c.api).replace(/\/+$/, "");
    return PLATFORM.devApi;
  }
  var isLocal = (location.hostname === "127.0.0.1" || location.hostname === "localhost");
  // 本地可用 ?api= 覆盖，其余一律走上面的推导（本地与线上同一条路，避免两套逻辑）
  var API = getParam("api") || apiBaseFromPath();

  function getParam(name) {
    var m = new RegExp("[?&]" + name + "=([^&#]*)").exec(location.search);
    return m ? decodeURIComponent(m[1]) : "";
  }
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmtTime(s) {
    if (!s) return "";
    var m = String(s).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return m ? (m[1] + " " + m[2]) : String(s);
  }
  function toast(msg) {
    var t = $("#toast");
    if (!t) return;
    t.textContent = msg; t.classList.add("on");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove("on"); }, 2200);
  }
  // ============ 当前活动（平台化的中枢）============
  // 后台每个请求都要说明「我在哪个活动下干活」，后端按 X-Activity-Code > Host > 默认活动
  // 解析（见 backend/activity.py）。这里只存 code 不存 id：code 是给人看的、也是接口认的。
  // 存 localStorage 而不是内存变量——刷新页面、开新标签页都要还在同一个活动里。
  var ACT_KEY = "adm_activity_code";
  function currentActivityCode() {
    try { return localStorage.getItem(ACT_KEY) || ""; } catch (e) { return ""; }
  }
  function setActivityCode(code) {
    try {
      if (code) localStorage.setItem(ACT_KEY, String(code));
      else localStorage.removeItem(ACT_KEY);
    } catch (e) {}
  }

  function api(path, opts) {
    var o = {}, k;
    if (opts) for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    var code = currentActivityCode();
    if (code) {
      // 合并而不是覆盖 headers：POST 要带 Content-Type，直接换掉会把它冲掉
      var h = {};
      var src = o.headers || {};
      for (k in src) if (Object.prototype.hasOwnProperty.call(src, k)) h[k] = src[k];
      h["X-Activity-Code"] = code;
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
  var CONFIG = { registration_open: true, event_ended: false, env: null };
  function loadConfig() {
    return api("/config").then(function (r) {
      if (r.body && r.body.ok) {
        CONFIG.env = r.body.env || null;
        CONFIG.registration_open = r.body.registration_open !== false;
        CONFIG.event_ended = r.body.event_ended === true;
        CONFIG.gate = r.body.gate || null;
        CONFIG.bgm = r.body.bgm || null;
      }
      return CONFIG;
    }).catch(function () { return CONFIG; });
  }
