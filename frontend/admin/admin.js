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
    // 本地联调默认后端；线上按目录推导，规则见 apiBaseFromPath
    devApi: "http://127.0.0.1:8088/platform/api",
    // 后台所在目录（相对站点根）→ API 基址。
    // 按完整目录映射而不是只取末段：/platform/admin/ 与 /platform-staging/admin/
    // 末段都是 admin，只取末段分不出生产与测试，会把测试后台打到生产接口上。
    siteToApi: {
      "platform/admin": "/platform/api",
      "platform-staging/admin": "/platform-staging/api"
    },
    // 当前活动标识：平台化后从平台上下文/URL 注入；现在默认当前活动
    activityId: getParam("activity") || "current"
  };
  function apiBaseFromPath() {
    // 站点配置优先：绑独立域名后后台不在 /xxx/admin/ 这种可推导的目录下，
    // 按路径猜必然错，配置里写死才可靠（见 site-config.js）。
    var c = window.__SITE__ || {};
    if (c.api) return String(c.api).replace(/\/+$/, "");
    var dir = location.pathname.replace(/[^\/]*$/, "").replace(/^\/+|\/+$/g, "");  // platform/admin
    var target = PLATFORM.siteToApi[dir];
    if (!target) target = "/" + (dir.split("/")[0] || "platform") + "/api";  // 兜底取首段
    return target;
  }
  var isLocal = (location.hostname === "127.0.0.1" || location.hostname === "localhost");
  // 本地可用 ?api= 覆盖；线上走配置块推导
  var API = (isLocal && getParam("api")) || (isLocal ? PLATFORM.devApi : apiBaseFromPath());

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
    orghome: ["机构总台", "本机构的活动、配额、短信余量与到期时间"],
    orginfo: ["机构信息", "机构名称、域名与联系人；版本与续费在这里"],
    overview: ["工作台", "活动整体情况与现场签到控制"],
    review: ["活动复盘", "办完一屏交差：报名到场漏斗、来源归因、时段分布、礼品与异常"],
    stats: ["数据统计", "访问 UV/PV、渠道来源、设备分布与转化漏斗"],
    roster: ["报名名单", "全部报名记录、签到状态与来源渠道"],
    cards: ["领卡行为", "点击领取礼物 / 点击开卡 的行为留痕"],
    checkins: ["签到流水", "现场签到记录，按时间倒序"],
    agenda: ["日程议程", "活动日程与分时段议程，按排序展示在详情页"],
    speakers: ["嘉宾讲师", "专业版项：嘉宾姓名、职务与简介，按排序展示在详情页"],
    materials: ["推广二维码", "通用报名码 / 渠道码 / 通用核销码，扫码与报名归因"],
    bgm: ["背景音乐", "用户端背景音乐的开关与曲目更换"],
    logs: ["操作审计", "管理与导出动作留痕（仅机构管理员可见）"],
    accounts: ["账号管理", "本机构账号、角色与活动授权（仅机构负责人可见）"],
    staff: ["现场工作人员", "可辅助签到人员、微信绑定与专属核销凭证"],
    orgs: ["机构管理", "平台超管专用：开机构、定版本与配额、功能位、跨机构检索"],
    activities: ["活动管理", "切换活动、发布上线与回草稿（草稿期的数据仅用于测试）"],
    actperm: ["活动能力与成员", "本活动的能力开关与成员授权（按活动生效，机构管理员可改）"],
    riskwords: ["平台风控", "全平台禁用词库，报名文本命中即拒（仅平台超管可见）"],
    form: ["表单字段", "本活动的报名表结构；已收的报名永远按它当时那一版解释"]
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

  // 机构档位：后端 /admin/me 下发 org_role，前端不自己认角色字面量
  var ORG_MANAGER_ROLES = ["platform_admin", "org_owner", "org_admin"];
  var ORG_OWNER_ROLES = ["platform_admin", "org_owner"];
  var ORG_ROLE_LABEL = { platform_admin: "平台超管", org_owner: "机构负责人", org_admin: "机构管理员", org_user: "普通用户" };
  // 机构管理员档：能管本机构的活动/配置/数据。
  // C 批把判据从「role 字面量等于 admin」换成后端下发的 org_role——
  // 四档角色只在一处归一（orgctx），前端再写一份字面量判断就是两个口径。
  function isAdmin() { return !!(ACCOUNT && ORG_MANAGER_ROLES.indexOf(ACCOUNT.org_role) >= 0); }
  // 机构负责人档：账号管理、机构信息这类只有一家之主能改的事
  function isOrgOwner() { return !!(ACCOUNT && ORG_OWNER_ROLES.indexOf(ACCOUNT.org_role) >= 0); }
  // 平台超管：只有这一个账号能开机构、改版本、看跨机构检索（判据在后端 orgctx）
  function isPlatformAdmin() { return !!(ACCOUNT && ACCOUNT.is_platform_admin); }
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
  function apiAdmin(path, opts) {
    var sep = path.indexOf("?") >= 0 ? "&" : "?";
    return api(path + sep + "token=" + encodeURIComponent(ADMIN_TOKEN), opts).then(function (res) {
      if (res.status === 401) kickToLogin();
      return res;
    });
  }
  // 带 body 的写操作：token 仍走 query（后端签名是 token 作查询参数 + Pydantic body），
  // 所以不能沿用「token 塞进 body」那套旧写法
  function sendAdmin(method, path, body) {
    return apiAdmin(path, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  }
  function kickToLogin() {
    ADMIN_TOKEN = null; ACCOUNT = null; clearSession();
    var p = $("#admin-panel"), l = $("#admin-login-wrap");
    if (p) p.style.display = "none";
    if (l) l.style.display = "block";
    var m = $("#admin-msg"); if (m) m.textContent = "登录已失效，请重新登录";
    var ops = $("#ad-top-ops"); if (ops) ops.style.display = "none";
    stopWatermark();
  }

  // 权限落到界面：角色只从后端 org_role 读，不认字面量
  function applyPerms() {
    $all(".admin-only").forEach(function (el) { el.style.display = isAdmin() ? "" : "none"; });
    // 机构负责人专属（账号管理、机构信息写）：方案的口径是「不渲染」而不是
    // 灰掉——点一下弹"没权限"比根本不给入口更让人困惑。
    $all(".owner-only").forEach(function (el) { el.style.display = isOrgOwner() ? "" : "none"; });
    // 机构管理是平台超管专属：机构管理员即便是最高档也不该看到这个入口
    $all(".platform-only").forEach(function (el) { el.style.display = isPlatformAdmin() ? "" : "none"; });
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
      // 谁 · 什么档 · 哪个机构：多机构之后，「我是谁的人」比「我叫什么」更该先看见
      var bits = [ACCOUNT.username, ORG_ROLE_LABEL[ACCOUNT.org_role] || ACCOUNT.org_role || "普通用户"];
      if (ACCOUNT.org_name) bits.splice(1, 0, ACCOUNT.org_name);
      who.textContent = bits.join(" · ");
    }
  }

  // ---- 账号水印：全屏平铺「账号 + 时间」，截图可溯源到人 ----
  function wmStamp() {
    var d = new Date(), p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  // 后台专属的二维码 / 物料链接工具。
  // 拆分前这些函数散在参与者端 core/material.js 与 flows/signup/signup.js 里，
  // 后台单产物没引入 → 物料码不渲染、绑定码不显示。后台只需要的这几支单独抽出，
  // 不把 material.js 整份拖进来（其余日历/领卡/地图函数后台用不到）。

  function hasQr() { return typeof window.qrcode === "function"; }

  // ---- 自绘下拉：干掉原生 <select> 点开后菜单弹层飘走的漂移 ----
  // 原生 select 的外观能用 appearance:none 自绘，但点开后的选项菜单是浏览器系统层渲染的，
  // 位置不受 CSS 控制（实测 Chrome/Safari 都会把菜单弹到远离控件处，见 2026-11-18 录屏）。
  // 这里保留原 select 元素（值读取处仍用 sel.value），只是隐藏它、加一层自绘控件：
  // 点显示框 → 弹出绝对定位的选项列表（相对包裹层，不受 .modal-box 的 overflow 裁剪）→
  // 选中后同步 select.value。这样控件外观与选项定位全由我们自己掌控。
  //
  // 【必须用 mousedown 而不是 click】真实鼠标点击时，mousedown 会让浏览器把焦点移到
  // 带 tabindex 的控件并可能触发滚动，导致 mouseup 后 click 的 target 已漂移到包裹层外，
  // 点击事件根本到不了控件——表现为"点一下下拉没反应/闪一下就关"。mousedown 是点击链里
  // 最早且最可靠的事件，preventDefault 还能顺带阻止焦点滚动，故打开/选择/关闭全部改由它驱动。
  function enhanceSelect(sel) {
    if (!sel || sel.dataset.enhanced) return;
    sel.dataset.enhanced = "1";
    var wrap = document.createElement("div");
    wrap.className = "esel";
    var view = document.createElement("div");
    view.className = "esel-view";
    view.setAttribute("tabindex", "0");
    view.setAttribute("role", "combobox");
    var list = document.createElement("div");
    list.className = "esel-list";
    var arrow = document.createElement("span");
    arrow.className = "esel-arrow";
    arrow.innerHTML = '<svg width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="#5b7180" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var textNode = document.createElement("span");
    textNode.className = "esel-val";
    function currentLabel() {
      var o = sel.options[sel.selectedIndex];
      return o ? o.textContent : "";
    }
    textNode.textContent = currentLabel();
    view.appendChild(textNode);
    view.appendChild(arrow);
    wrap.appendChild(view);
    wrap.appendChild(list);

    function buildList() {
      list.innerHTML = "";
      Array.prototype.forEach.call(sel.options, function (o) {
        var it = document.createElement("div");
        it.className = "esel-item" + (o.selected ? " is-sel" : "");
        it.textContent = o.textContent;
        it.setAttribute("data-val", o.value);
        // 选择同样走 mousedown：真实鼠标下 click 的目标会漂移，点选项会落空。
        it.addEventListener("mousedown", function (e) {
          e.preventDefault();
          e.stopPropagation();
          sel.value = o.value;
          if (sel.onchange) sel.onchange();
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          textNode.textContent = o.textContent;
          close();
        });
        list.appendChild(it);
      });
    }
    function open() {
      buildList();
      wrap.classList.add("open");
      view.setAttribute("aria-expanded", "true");
      // 打开时把选中项滚动进可视区
      var cur = list.querySelector(".is-sel");
      if (cur) list.scrollTop = cur.offsetTop - list.offsetTop;
    }
    function close() {
      wrap.classList.remove("open");
      view.setAttribute("aria-expanded", "false");
    }
    view.addEventListener("mousedown", function (e) {
      e.preventDefault();
      if (wrap.classList.contains("open")) close(); else open();
    });
    view.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        if (wrap.classList.contains("open")) close(); else open();
      }
      if (e.key === "Escape") close();
    });
    // 点外部关闭也用 mousedown（click 会因 target 漂移而漏判）。
    document.addEventListener("mousedown", function (e) {
      if (!wrap.contains(e.target)) close();
    });

    sel.style.display = "none";
    sel.parentNode.insertBefore(wrap, sel);
  }

  // 物料二维码指向参与者端，不是后台自己。
  // 后台挂在站点 /admin/ 子目录下，要退到站点根再拼哈希路由；
  // 站点根优先取站点配置（site-config.js），绑独立域名后路径推不出来，缺失才按目录退一级。
  function siteUrl(hashPath) {
    var c = window.__SITE__ || {};
    var hp = String(hashPath || "");
    var base = "";
    if (c.base) {
      base = String(c.base).replace(/\/+$/, "") + "/";
    } else {
      var dir = location.pathname.replace(/[^\/]*$/, "");     // /platform-staging/admin/
      dir = dir.replace(/admin\/$/, "");                       // → /platform-staging/
      if (!dir || dir === "/") dir = "/platform-staging/";
      base = location.origin + dir;
    }
    return base + hp.replace(/^\/+/, "");
  }

  function qrSvg(text, cell, margin) {
    var q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: cell || 6, margin: margin || 12 });
  }

  function saveBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  // ---- 两张固定码：通用报名码 / 通用核销码 ----
  // 拆分前在 core/material.js，后台产物没引入该文件 → 两个码面板空白。
  // 术语与后台「推广二维码」页一致：通用码（不区分渠道）+ 渠道码（每个物料一个）。
  // 下载文件名也走这里，运营拿到手一眼知道是哪张。
  // 这两支连同 loadMaterials/bindMaterials 一起补进后台共享工具。
  // query 与 hash 分开拼：query 段必须带活动上下文（多机构下不带就落默认活动），
  // hash 段固定收尾。链接形态由 core/actlink.js 统一决定——机构子域走
  // /<短码>，主站走 ?a=<短码>，这里不重复判断。
  var MATS = {
    signup:  { path: "#/intro",   query: "from=material", name: "通用报名码" },
    checkin: { path: "#/checkin", query: "from=material", name: "通用核销码" }
  };
  function matUrl(kind) {
    var m = MATS[kind] || MATS.signup;
    return window.__ACTLINK.url(currentActivityCode(), m.query) + m.path;
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
  function downloadQr(matKey, fmt) {
    var u = matUrl(matKey), label = (MATS[matKey] || MATS.signup).name;
    downloadQrUrl(u, label, fmt);
  }
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
        var ta = document.createElement("textarea");
        ta.value = u; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); toast("链接已复制"); }
        catch (e) { toast("复制失败，请手动选中链接"); }
        ta.remove();
      });
    });
  }

  // 任意链接出码：投放物料码（PNG/SVG 下载）
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

  function loadStats() {
    apiAdmin("/stats").then(function (res) {
      if (!res.body.ok) return;
      var s = res.body;
      $("#admin-stats").innerHTML =
        '<div class="stat"><b>' + s.registered + '</b>报名</div>' +
        '<div class="stat"><b>' + s.checked_in + '</b>签到</div>' +
        '<div class="stat"><b>' + (s.rate * 100).toFixed(0) + '%</b>签到率</div>';
    });
  }

  // 报名画像：性别分布 + 来源渠道，通用活动口径（不再讲学历/院校等具体行业字段）
  function loadProfile() {
    apiAdmin("/admin/profile").then(function (res) {
      var box = $("#admin-profile");
      if (!box || !res.body.ok) return;
      var d = res.body, total = d.total || 0;
      var genders = d.gender || [], channels = d.channels || [];
      var max = 1;
      genders.concat(channels).forEach(function (x) { if (x.n > max) max = x.n; });
      var bar = function (n) {
        return '<div class="profile-bar"><i style="width:' +
          Math.round(n / max * 100) + '%"></i></div>';
      };
      var topChannel = channels.length ? channels[0] : null;
      var items =
        '<div class="profile-item"><span>有效报名</span><b>' + total + ' 人</b></div>' +
        genders.map(function (x) {
          return '<div class="profile-item"><span>性别 · ' + esc(x.k) + '</span><b>' + x.n +
            ' 人</b>' + bar(x.n) + '</div>';
        }).join("") +
        channels.map(function (x) {
          return '<div class="profile-item"><span>渠道 · ' + esc(x.k) + '</span><b>' + x.n +
            ' 人</b>' + bar(x.n) + '</div>';
        }).join("");
      var sentence = '<p class="profile-sentence" style="grid-column:1 / -1">本次活动累计报名 <b>' +
        total + '</b> 人' + (topChannel ? '，主要来自「' + esc(topChannel.k) + '」（' +
        topChannel.n + ' 人）' : '') + '。</p>';
      box.innerHTML = sentence + items;
    }).catch(function () {});
  }
  function loadGate() {
    apiAdmin("/admin/gate").then(function (res) {
      if (res.body.ok) renderGate(res.body);
    });
  }
  function loadAdmin() {
    loadStats();
    loadProfile();
    loadRoster();
    loadGate();
    loadCardActions();
    loadCheckins();
    if (isAdmin()) loadLogs();
  }
  function loadRoster() {
    var st = PG.roster;
    apiAdmin("/admin/list?page=" + st.page + "&size=" + st.size +
        (SHOW_FULL_INFO ? "&full=1" : "") +
        (st.q ? "&q=" + encodeURIComponent(st.q) : "")).then(function (res) {
      if (!res.body.ok) return;
      st.total = res.body.matched != null ? res.body.matched : (res.body.total || 0);
      st.page = res.body.page || st.page;
      renderAdminList(res.body);
      renderAdminSum(res.body);
      // 「全部」用记录总数（含已关闭），与「筛选出」同一口径；有效报名数另在分项统计里
      renderPager("roster", "roster-pager", loadRoster,
                  (res.body.total || 0) + (res.body.closed_total || 0));
    });
  }

  // 名单行操作：关闭 / 恢复。tbody 只改内容不重建，所以委托绑一次就够。
  function bindRosterRows() {
    var tb = $("#admin-list");
    if (!tb || tb.getAttribute("data-bound")) return;
    tb.setAttribute("data-bound", "1");
    tb.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-reg-act]") : null;
      if (!b) return;
      var id = parseInt(b.getAttribute("data-id"), 10);
      var act = b.getAttribute("data-reg-act");
      if (act === "edit") { openRegEdit(id); return; }
      if (act === "close") {
        if (!window.confirm("关闭后：该用户在前端视为未报名，可以重新提交报名。\n后台记录保留、导出带状态列，随时可恢复。\n\n确认关闭？")) return;
        postJ("/admin/registration/close", { token: ADMIN_TOKEN, id: id }).then(function (res) {
          if (res.body && res.body.ok) { toast("已关闭"); loadRoster(); loadStats(); }
          else toast((res.body && res.body.detail) || "关闭失败");
        }).catch(function () { toast("网络异常，请重试"); });
      } else {
        postJ("/admin/registration/reopen", { token: ADMIN_TOKEN, id: id }).then(function (res) {
          if (res.body && res.body.ok) { toast("已恢复"); loadRoster(); loadStats(); }
          else toast((res.body && res.body.detail) || "恢复失败");
        }).catch(function () { toast("网络异常，请重试"); });
      }
    });
  }

  // 后台：修改报名信息。列表里是脱敏值，所以先按 id 取一次完整记录再预填
  // 毕业年月下拉：只在首次打开弹窗时填充，避免每次重复插入
  function fillGradSelects() {
    var y = $("#reg-grad-year"), mo = $("#reg-grad-month");
    if (!y || !mo || y.options.length) return;
    var hy = '<option value="">未填</option>', hm = '<option value="">未填</option>';
    for (var i = 2028; i >= 2000; i--) hy += '<option value="' + i + '">' + i + " 年</option>";
    for (var j = 1; j <= 12; j++) hm += '<option value="' + j + '">' + j + " 月</option>";
    y.innerHTML = hy; mo.innerHTML = hm;
  }
  function setGradSelects(gradTime) {
    var y = $("#reg-grad-year"), mo = $("#reg-grad-month");
    if (!y || !mo) return;
    var mt = String(gradTime || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    y.value = mt ? String(Number(mt[1])) : "";
    mo.value = mt ? String(Number(mt[2])) : "";
  }
  // 留学国家只在「海外经历＝是」时出现，避免后台补录时误填无关信息
  function syncRegCountry() {
    var sel = $("#reg-overseas"), row = $("#reg-country-row");
    if (!sel || !row) return;
    row.style.display = sel.value === "是" ? "" : "none";
  }

  function openRegEdit(id) {
    var m = $("#reg-edit-modal"), form = $("#reg-edit-form");
    if (!m || !form) return;
    apiAdmin("/admin/registration?id=" + id).then(function (res) {
      if (!res.body || !res.body.ok) { toast((res.body && res.body.detail) || "读取失败"); return; }
      var d = res.body.row || {};
      // form.name / form.id 取到的是表单自身属性，必须走 form.elements
      var el = form.elements;
      el.id.value = d.id || id;
      el.name.value = d.name || "";
      el.phone_code.value = d.phone_code || "86";
      el.phone.value = d.phone || "";
      el.gender.value = d.gender || "";
      // 自定义字段以 JSON 展示，管理员可直接改——字段由活动 schema 决定，
      // 后台不再写死任何行业字段（行业专属字段均已删除）。
      el.answers.value = d.answers ? JSON.stringify(d.answers, null, 2) : "";
      var msg = $("#reg-edit-msg"); if (msg) msg.textContent = "";
      m.style.display = "flex";
    }).catch(function () { toast("网络异常，请重试"); });
  }
  // ---- 后台：背景音乐管理 ----
  // 开关 + 上传 + 恢复默认。配置走后端 site_config，用户端从 /api/config 读，
  // 平台化时这套「后端存配置 + 前端读配置 + 后台改配置」可以直接复用。
  var BGM_RELOAD = null;      // 进「背景音乐」分区时才拉状态，避免页面初始化时抢在登录态之前请求

  function bindAdminBgm() {
    var wrap = $("#tab-bgm");
    if (!wrap) return;
    var statusEl = $("#bgm-status"), nameEl = $("#bgm-name"), infoEl = $("#bgm-info");
    var tipEl = $("#bgm-tip"), dot = $("#bgm-dot"), btn = $("#bgm-toggle");
    var fileEl = $("#bgm-file"), previewEl = $("#bgm-preview"), resetEl = $("#bgm-reset");
    var previewAudio = null, CUR = null;

    function fmtSize(n) {
      if (!n) return "";
      return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + " MB" : Math.round(n / 1024) + " KB";
    }
    function render(d) {
      CUR = d;
      if (statusEl) statusEl.textContent = d.enabled ? "已启用（用户端会播放）" : "已关闭（用户端不加载）";
      if (dot) dot.classList.toggle("on", !!d.enabled);
      if (btn) btn.textContent = d.enabled ? "关闭" : "启用";
      if (nameEl) nameEl.textContent = d.custom ? (d.name || "自定义曲目") : (d.default_name + "（内置默认）");
      if (infoEl) {
        var bits = [d.custom ? "自定义上传" : "内置默认"];
        if (d.size) bits.push(fmtSize(d.size));
        if (d.updated_at) bits.push("更新于 " + String(d.updated_at).replace("T", " ").slice(0, 16));
        infoEl.textContent = bits.join(" · ");
      }
      if (tipEl) tipEl.textContent = d.writable === false
        ? "注意：音频目录不可写，上传会失败，需要服务器给后端写权限" : "";
    }
    function load() {
      // 登录态还没恢复时先不请求：否则会拿到 401，既污染面板提示，还会触发一次踢线
      if (!ADMIN_TOKEN) { if (statusEl) statusEl.textContent = "读取中…"; return; }
      apiAdmin("/admin/bgm").then(function (res) {
        if (!res.body || !res.body.ok) {
          if (statusEl) statusEl.textContent = (res.body && res.body.detail) || "读取失败";
          return;
        }
        render(res.body);
      }).catch(function () { if (statusEl) statusEl.textContent = "网络异常"; });
    }
    if (btn) btn.addEventListener("click", function () {
      if (!CUR) return;
      btn.disabled = true;
      postJ("/admin/bgm", { token: ADMIN_TOKEN, enabled: !CUR.enabled }).then(function (res) {
        btn.disabled = false;
        if (!res.body || !res.body.ok) { toast((res.body && res.body.detail) || "操作失败"); return; }
        render(res.body);
        toast(res.body.enabled ? "背景音乐已启用" : "背景音乐已关闭");
        if (typeof loadLogs === "function") loadLogs();
      }).catch(function () { btn.disabled = false; toast("网络异常，请重试"); });
    });
    if (fileEl) fileEl.addEventListener("change", function () {
      var f = this.files && this.files[0];
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) { toast("文件超过 5MB，请先压缩"); this.value = ""; return; }
      if (tipEl) tipEl.textContent = "正在上传 " + Math.round(f.size / 1024) + " KB…";
      // 走原始二进制 body：后端没装 python-multipart，不为此加依赖
      fetch(API + "/admin/bgm/upload?token=" + encodeURIComponent(ADMIN_TOKEN) +
            "&filename=" + encodeURIComponent(f.name), {
        method: "POST", headers: { "Content-Type": "audio/mpeg" }, body: f
      }).then(function (r) { return r.json(); }).then(function (j) {
        fileEl.value = "";
        if (!j.ok) {
          if (tipEl) tipEl.textContent = j.detail || "上传失败";
          toast(j.detail || "上传失败");
          return;
        }
        render(j);
        if (tipEl) tipEl.textContent = "已上传并启用，点「试听」确认效果";
        toast("背景音乐已更新");
        if (typeof loadLogs === "function") loadLogs();
      }).catch(function () {
        fileEl.value = "";
        if (tipEl) tipEl.textContent = "网络异常，上传失败";
      });
    });
    if (resetEl) resetEl.addEventListener("click", function () {
      if (!CUR || !CUR.custom) { toast("当前已是默认曲目"); return; }
      postJ("/admin/bgm/reset", { token: ADMIN_TOKEN }).then(function (res) {
        if (!res.body || !res.body.ok) { toast("操作失败"); return; }
        render(res.body);
        toast("已恢复默认曲目");
      }).catch(function () { toast("网络异常，请重试"); });
    });
    if (previewEl) previewEl.addEventListener("click", function () {
      if (!CUR) return;
      if (!previewAudio) { previewAudio = new Audio(); previewAudio.volume = 0.35; }
      if (!previewAudio.paused) { previewAudio.pause(); previewEl.textContent = "试听"; return; }
      // 加时间戳：换曲/恢复默认后同名文件不吃缓存
      previewAudio.src = CUR.url + (CUR.url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
      previewAudio.onended = function () { previewEl.textContent = "试听"; };
      previewAudio.play().then(function () { previewEl.textContent = "停止试听"; })
        .catch(function () { toast("浏览器拦了播放，再点一次"); });
    });
    // 不在初始化时 load：那时 ADMIN_TOKEN 可能还没恢复，会拿到 401 并把「登录已失效」
    // 显示在面板上，还可能触发一次多余的踢线。改为切到本分区时再拉。
    BGM_RELOAD = load;
  }

  function bindRegEdit() {
    var m = $("#reg-edit-modal"), form = $("#reg-edit-form");
    if (!m || !form) return;
    var close = function () { m.style.display = "none"; };
    var mask = $("#reg-edit-mask"), cls = $("#reg-edit-close");
    if (mask) mask.addEventListener("click", close);
    if (cls) cls.addEventListener("click", close);
    var ovs = $("#reg-overseas");
    if (ovs) ovs.addEventListener("change", syncRegCountry);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("#reg-edit-msg");
      if (msg) msg.textContent = "";
      var el = form.elements;
      // answers 框必须是合法 JSON，否则不让提交（后端收到的是对象，不是字符串）
      var answers = {};
      var raw = (el.answers.value || "").trim();
      if (raw) {
        try { answers = JSON.parse(raw); }
        catch (err) { if (msg) msg.textContent = "其它信息不是合法 JSON，请检查"; return; }
        if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
          if (msg) msg.textContent = "其它信息必须是 JSON 对象"; return;
        }
      }
      var body = {
        token: ADMIN_TOKEN, id: Number(el.id.value),
        name: (el.name.value || "").trim(),
        phone_code: (el.phone_code.value || "").replace(/\D/g, "") || "86",
        phone: (el.phone.value || "").trim(),
        gender: el.gender.value,
        answers: answers
      };
      postJ("/admin/registration/update", body).then(function (res) {
        if (!res.body || !res.body.ok) {
          if (msg) msg.textContent = (res.body && res.body.detail) || "保存失败";
          return;
        }
        toast(res.body.status === "unchanged" ? "没有改动" : "已保存");
        close();
        loadRoster();
        loadLogs();
      }).catch(function () { if (msg) msg.textContent = "网络异常，请重试"; });
    });
  }

  // 搜索：输入停顿 300ms 自动查，回车立即查，清空即还原全量
  function bindRosterSearch() {
    var el = $("#roster-q");
    if (!el) return;
    var tmr = null;
    function apply() {
      var v = el.value.trim();
      if (v === PG.roster.q) return;
      PG.roster.q = v;
      PG.roster.page = 1;
      loadRoster();
    }
    el.addEventListener("input", function () {
      clearTimeout(tmr);
      tmr = setTimeout(apply, 300);
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); clearTimeout(tmr); apply(); }
      if (e.key === "Escape") { el.value = ""; clearTimeout(tmr); apply(); }
    });
    el.addEventListener("search", function () { clearTimeout(tmr); apply(); });   // 原生清空按钮
  }

  // ---- 分页器：共 N 条 / 每页 20·50·100 / 上一页·下一页 ----
  // allTotal 传了就在筛选时额外提示「全部 M 条」
  function renderPager(key, boxId, reload, allTotal) {
    var st = PG[key], box = $("#" + boxId);
    if (!box) return;
    var pages = Math.max(1, Math.ceil(st.total / st.size));
    if (st.page > pages) st.page = pages;
    if (st.page < 1) st.page = 1;
    var opts = [20, 50, 100].map(function (n) {
      return '<option value="' + n + '"' + (n === st.size ? " selected" : "") + ">" + n + " 条/页</option>";
    }).join("");
    var totalTxt = "共 " + st.total + " 条";
    if (allTotal != null && st.q) totalTxt = "筛选出 " + st.total + " 条 / 全部 " + allTotal + " 条";
    box.innerHTML =
      '<span class="pg-total">' + totalTxt + "</span>" +
      '<span class="pg-ops">' +
      '<select class="pg-size">' + opts + "</select>" +
      '<button class="pg-btn" data-pg="prev"' + (st.page <= 1 ? " disabled" : "") + ">上一页</button>" +
      '<span class="pg-cur">' + st.page + " / " + pages + "</span>" +
      '<button class="pg-btn" data-pg="next"' + (st.page >= pages ? " disabled" : "") + ">下一页</button>" +
      "</span>";
    var sel = box.querySelector(".pg-size");
    if (sel) sel.addEventListener("change", function () {
      st.size = parseInt(sel.value, 10) || 20;
      st.page = 1;
      reload();
    });
    var prev = box.querySelector('[data-pg="prev"]');
    if (prev) prev.addEventListener("click", function () {
      if (st.page > 1) { st.page -= 1; reload(); }
    });
    var next = box.querySelector('[data-pg="next"]');
    if (next) next.addEventListener("click", function () {
      if (st.page < pages) { st.page += 1; reload(); }
    });
  }

  // ---- 操作日志（独立页，仅 admin）----
  // 审计筛选状态：切页不重置，回到列表还是上次的筛选，方便边查边翻
  var LOG_F = { action: "", operator: "", start: "", end: "", sensitive: 0 };
  var LOG_FACETED = false;

  function logParams() {
    var p = "&action=" + encodeURIComponent(LOG_F.action) +
            "&operator=" + encodeURIComponent(LOG_F.operator) +
            "&sensitive=" + (LOG_F.sensitive ? 1 : 0);
    // 日期按自然日给边界：选 11-17 就要包含当天 23:59，不能只到 00:00
    if (LOG_F.start) p += "&start=" + encodeURIComponent(LOG_F.start + "T00:00:00+08:00");
    if (LOG_F.end) p += "&end=" + encodeURIComponent(LOG_F.end + "T23:59:59+08:00");
    return p;
  }

  function fillLogFacets(facets) {
    var sel = $("#log-action"), opSel = $("#log-operator");
    if (!sel || !opSel) return;
    // 动作选项只在第一次进来时铺；之后保持原样，免得用户选了又被刷新回「全部」
    if (!LOG_FACETED) {
      var keep = sel.value;
      sel.innerHTML = '<option value="">全部动作</option>' +
        (facets.actions || []).map(function (a) {
          return '<option value="' + esc(a.action) + '">' +
            esc(ACTION_CN[a.action] || a.action) + "（" + a.count + "）</option>";
        }).join("");
      sel.value = keep;
      var keepOp = opSel.value;
      opSel.innerHTML = '<option value="">全部操作人</option>' +
        (facets.operators || []).map(function (o) {
          return '<option value="' + esc(o.operator) + '">' +
            esc(o.operator) + "（" + o.count + "）</option>";
        }).join("");
      opSel.value = keepOp;
      LOG_FACETED = true;
    }
  }

  function loadLogs() {
    if (!isAdmin()) return;
    var st = PG.logs;
    apiAdmin("/admin/logs?page=" + st.page + "&size=" + st.size + logParams()).then(function (res) {
      if (!res.body.ok) return;
      st.total = res.body.total || 0;
      st.page = res.body.page || st.page;
      fillLogFacets(res.body.facets || {});
      var tb = $("#admin-logs"), html = "";
      (res.body.rows || []).forEach(function (l) {
        var kind = ACT_KIND[l.action] || "read";
        html += '<tr><td class="td-mono">' + esc(fmtTime(l.created_at)) + "</td>" +
                '<td><span class="act-tag act-' + kind + '">' +
                  esc(ACTION_CN[l.action] || l.action) + "</span></td>" +
                "<td>" + esc(l.detail || "") + "</td>" +
                "<td>" + esc(l.operator || "") + "</td></tr>";
      });
      if (!(res.body.rows || []).length) {
        html = '<tr><td colspan="4" class="td-empty">' +
          (LOG_F.action || LOG_F.operator || LOG_F.start || LOG_F.end || LOG_F.sensitive
            ? "当前筛选条件下没有记录" : "暂无操作记录") + "</td></tr>";
      }
      if (tb) tb.innerHTML = html;
      var hint = $("#log-hint");
      if (hint) {
        var on = [];
        if (LOG_F.sensitive) on.push("只看敏感操作");
        if (LOG_F.action) on.push("动作：" + (ACTION_CN[LOG_F.action] || LOG_F.action));
        if (LOG_F.operator) on.push("操作人：" + LOG_F.operator);
        if (LOG_F.start) on.push("起：" + LOG_F.start);
        if (LOG_F.end) on.push("止：" + LOG_F.end);
        hint.textContent = on.length
          ? "筛选：" + on.join(" · ") + " ｜ 共 " + st.total + " 条"
          : "共 " + st.total + " 条，按时间倒序";
      }
      renderPager("logs", "logs-pager", loadLogs);
    });
  }

  // 筛选栏只在第一次进页面时绑定；改条件即回到第 1 页重新查
  var LOG_BOUND = false;
  function bindLogsPage() {
    if (LOG_BOUND) return;
    LOG_BOUND = true;
    var reload = function () { PG.logs.page = 1; loadLogs(); };
    var act = $("#log-action"), op = $("#log-operator"),
        st = $("#log-start"), en = $("#log-end"), se = $("#log-sensitive");
    if (act) act.addEventListener("change", function () { LOG_F.action = act.value; reload(); });
    if (op) op.addEventListener("change", function () { LOG_F.operator = op.value; reload(); });
    if (st) st.addEventListener("change", function () { LOG_F.start = st.value; reload(); });
    if (en) en.addEventListener("change", function () { LOG_F.end = en.value; reload(); });
    if (se) se.addEventListener("change", function () { LOG_F.sensitive = se.checked ? 1 : 0; reload(); });

    var rs = $("#log-reset");
    if (rs) rs.addEventListener("click", function () {
      LOG_F = { action: "", operator: "", start: "", end: "", sensitive: 0 };
      if (act) act.value = ""; if (op) op.value = "";
      if (st) st.value = ""; if (en) en.value = ""; if (se) se.checked = false;
      reload();
    });
    var ex = $("#log-export");
    if (ex) ex.addEventListener("click", function () {
      // 导出走当前筛选，与服务端同一套条件，导出的就是屏幕上这批
      window.open(API + "/admin/logs/export?token=" + encodeURIComponent(ADMIN_TOKEN) +
        logParams(), "_blank");
    });
  }

  // ---- 签到流水（独立页）----
  function loadCheckins() {
    var st = PG.checkins;
    apiAdmin("/admin/checkins?page=" + st.page + "&size=" + st.size +
        (SHOW_FULL_INFO ? "&full=1" : "")).then(function (res) {
      if (!res.body.ok) return;
      st.total = res.body.total || 0;
      st.page = res.body.page || st.page;
      var tb = $("#admin-checkins"), html = "";
      (res.body.rows || []).forEach(function (c) {
        html += '<tr><td class="td-mono">' + esc(fmtTime(c.checked_at)) + "</td>" +
                "<td>" + esc(METHOD_CN[c.method] || c.method) + "</td>" +
                "<td>" + esc(c.name || "") + "</td>" +
                '<td class="td-mono">' + esc(c.phone || "") + "</td>" +
                '<td class="td-mono">' + esc(c.credential_code || "") + "</td>" +
                "<td>" + esc(c.staff_name || "") + "</td></tr>";
      });
      if (!(res.body.rows || []).length) html = '<tr><td colspan="6" class="td-empty">暂无签到记录</td></tr>';
      if (tb) tb.innerHTML = html;
      renderPager("checkins", "checkins-pager", loadCheckins);
    });
  }

  // 名单表列多，时间用「MM-DD HH:mm」紧凑格式，把宽度让给业务列
  function fmtShort(t) {
    var f = fmtTime(t);
    return f ? f.replace(/^\d{4}-/, "") : "";
  }

  function renderAdminList(d) {
    var tb = $("#admin-list");
    if (!tb) return;
    var rows = d.rows || [];
    var gfOn = rows.some(function (r) {
      return r.gift_state !== null && r.gift_state !== undefined;
    });
    var th = $("#gift-th"); if (th) th.style.display = gfOn ? "" : "none";
    var html = "";
    rows.forEach(function (r) {
      html += '<tr>' +
        '<td class="td-name">' + esc(r.name) + '</td>' +
        '<td class="td-mono">' + esc("+" + (r.phone_code || "86") + "-" + r.phone) + '</td>' +
        '<td>' + esc(r.gender || "—") + '</td>' +
        '<td>' + esc(r.channel) + '</td>' +
        '<td class="td-mono">' + esc(r.code) + '</td>' +
        '<td class="td-mono td-time">' + esc(fmtShort(r.created_at).split(" ")[0] || "") +
        '<div class="td-sub">' + esc(fmtShort(r.created_at).split(" ")[1] || "") + '</div></td>' +
        (gfOn ? '<td>' + esc(r.gift_state || "未领") + '</td>' : '') +
        '<td>' + (r.status === "closed"
            ? '<span class="td-closed">已关闭</span>'
            : r.checked
              ? '<span class="td-ok">已签到</span><div class="td-sub">' + esc(fmtShort(r.checked_at)) + '</div>'
              : '<span class="td-no">未签到</span>') + '</td>' +
        '<td><button class="reg-btn" data-reg-act="edit" data-id="' + r.id + '">编辑</button> ' +
        (r.status === "closed"
            ? '<button class="reg-btn" data-reg-act="reopen" data-id="' + r.id + '">恢复</button>'
            : '<button class="reg-btn reg-btn-danger" data-reg-act="close" data-id="' + r.id + '">关闭</button>') +
        '</td>' +
        '</tr>';
    });
    if (!(d.rows || []).length) {
      html = '<tr><td colspan="' + (gfOn ? 9 : 8) + '" class="td-empty">' +
        (d.q ? "没有匹配「" + esc(d.q) + "」的报名记录" : "暂无报名记录") + "</td></tr>";
    }
    tb.innerHTML = html;
  }
  function renderAdminSum(d) {
    var box = $("#admin-sum");
    if (!box) return;
    var pairs = function (obj, empty) {
      var ks = Object.keys(obj || {});
      if (!ks.length) return empty || "—";
      return ks.map(function (k) { return k + " " + obj[k]; }).join("　");
    };
    var hours = Object.keys(d.by_hour || {}).sort();
    var hourTxt = hours.length
      ? hours.map(function (k) { return k + "时 " + d.by_hour[k] + "人"; }).join("　")
      : "尚无签到";
    box.innerHTML =
      '<div class="sum-row"><span>来源渠道</span><b>' + esc(pairs(d.by_channel)) + '</b></div>' +
      '<div class="sum-row"><span>签到时段</span><b>' + esc(hourTxt) + '</b></div>' +
      '<div class="sum-row"><span>应届构成</span><b>' + esc(pairs(d.fresh)) + '</b></div>' +
      '<div class="sum-row"><span>性别构成</span><b>' + esc(pairs(d.gender_mix)) + '</b></div>' +
      (d.closed_total
        ? '<div class="sum-row"><span>已关闭</span><b>' + esc(d.closed_total) + ' 条（名单中保留，不计入报名数）</b></div>'
        : '');
  }

  var ACTION_CN = { export: "导出明细", verify_confirm: "人工核销", walkin: "现场补录",
                    gate: "闸门与时效", view_full_phone: "查看完整信息", login: "登录后台",
                    password_change: "修改密码", account_create: "新增账号",
                    account_update: "修改账号", account_delete: "删除账号",
                    staff_create: "新增工作人员", staff_ticket: "重置核销凭据",
                    registration_update: "修改报名", material_create: "新建投放码",
                    material_update: "修改投放码", registration_close: "关闭报名记录",
                    staff_update: "修改工作人员", staff_delete: "删除工作人员",
                    material_delete: "删除投放码", bgm: "背景音乐开关",
                    bgm_upload: "上传背景音乐", bgm_reset: "重置背景音乐",
                    purge_test_data: "清除测试数据" };
  // 分类色：改配置橙、看数据灰、导出蓝、权限类红——扫一眼就知道这次是改了什么性质的事
  var ACT_KIND = {
    gate: "cfg", material_create: "cfg", material_update: "cfg", registration_update: "cfg",
    export: "exp",
    account_create: "sec", account_update: "sec", account_delete: "sec",
    staff_create: "sec", staff_ticket: "sec", password_change: "sec",
    staff_update: "sec", staff_delete: "sec", material_delete: "sec",
    purge_test_data: "sec",
    registration_close: "cfg", bgm: "cfg", bgm_upload: "cfg", bgm_reset: "cfg",
    view_full_phone: "read", login: "read"
  };
  var METHOD_CN = { self: "自助签到", verify: "人工核销", walkin: "现场补录" };
  var CARD_ACTION_CN = { gift_claim: "点击领取礼物", card_click: "点击开卡" };
  var SOURCE_CN = { signup: "报名成功页", checkin: "签到结果页", card: "领卡引导页", success: "报名成功页" };

  // ---- 领卡行为（点击口径）----
  function loadCardActions() {
    var st = PG.cards;
    apiAdmin("/admin/card-actions?page=" + st.page + "&size=" + st.size +
        (SHOW_FULL_INFO ? "&full=1" : "")).then(function (res) {
      if (!res.body.ok) return;
      st.total = res.body.total || 0;
      st.page = res.body.page || st.page;
      renderCardStats(res.body);
      renderPager("cards", "cards-pager", loadCardActions);
    });
  }
  function renderCardStats(d) {
    var box = $("#card-stats"), tb = $("#card-rows");
    if (box) {
      var g = (d.stats && d.stats.gift_claim) || { count: 0, users: 0 };
      var c = (d.stats && d.stats.card_click) || { count: 0, users: 0 };
      var rate = g.users ? Math.round(c.users / g.users * 100) : 0;
      // success / signup 是同一个页面的两种写法，展示时合并，避免出现两行「报名成功页」
      var merged = {};
      Object.keys(d.by_source || {}).forEach(function (k) {
        var label = SOURCE_CN[k] || k;
        merged[label] = (merged[label] || 0) + d.by_source[k];
      });
      var src = Object.keys(merged).map(function (k) { return k + " " + merged[k]; }).join("　");
      box.innerHTML =
        '<div class="cs-card"><b>' + esc(g.count) + '</b><span>点击领取礼物 · 共 ' + esc(g.users) + ' 人</span></div>' +
        '<div class="cs-card"><b>' + esc(c.count) + '</b><span>点击开卡 · 共 ' + esc(c.users) + ' 人</span></div>' +
        '<div class="cs-card"><b>' + rate + '%</b><span>领取→开卡（按人去重）</span></div>' +
        '<div class="cs-card wide"><b>' + esc(src || "暂无记录") + '</b><span>来源页分布</span></div>' +
        '<p class="cs-note">口径说明：本页记录的是用户在 H5 内「点击领取礼物」「点击开卡」的点击行为，' +
        '含身份、时间、行为与访问 ID，可导出与报名签到记录逐人比对。' +
        '小程序侧未接入回传，故此处不等于真实开卡数，对外表述请勿当作开卡量使用。</p>';
    }
    if (tb) {
      var html = "";
      (d.rows || []).forEach(function (r) {
        html += '<tr>' +
          '<td class="td-mono td-time">' + esc(fmtShort(r.created_at).split(" ")[0] || "") +
        '<div class="td-sub">' + esc(fmtShort(r.created_at).split(" ")[1] || "") + '</div></td>' +
          '<td>' + esc(r.name || "—") + '</td>' +
          '<td class="td-mono">' + esc(r.phone || "") + '</td>' +
          '<td>' + esc(CARD_ACTION_CN[r.action] || r.action) + '</td>' +
          '<td>' + esc(SOURCE_CN[r.source] || r.source || "—") + '</td>' +
          '<td class="td-mono">' + esc(r.visit_id || "") + '</td></tr>';
      });
      if (!(d.rows || []).length) html = '<tr><td colspan="6" class="td-empty">暂无领卡行为记录</td></tr>';
      tb.innerHTML = html;
    }
  }

  // ---- 账号管理 ----
  // ---- 数据统计（v130）----
  // 渠道值在库里是英文标识，这里统一映射成中文；unknown 也给出可读名
  var DS_CHANNEL_CN = {
    material: "渠道码扫码", share: "分享链接", direct: "活动链接",
    signup: "报名成功页", checkin: "签到结果页", card: "领卡引导页"
  };
  var DS_RANGE_LABEL = { today: "今日", "7d": "近 7 天", "30d": "近 30 天", all: "全部" };
  var DS = { range: "30d", start: "", end: "", channel: "", os: "", attr: "last", data: null };
  var DS_REQ_SEQ = 0;   // 防竞态：快速切筛选时只认最后一次响应

  function dsTodayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }
  function dsDaysAgo(n) {
    var d = new Date(); d.setDate(d.getDate() - n);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }
  function dsDateLabel(s) { return (s || "").slice(5).replace("-", "/"); }
  function dsFmt(n) { return (n == null ? 0 : n).toLocaleString("zh-CN"); }
  function dsPct(v) {
    if (v == null) return "—";
    return (v > 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
  }
  function dsDeltaHTML(v) {
    if (v == null) return '<span class="ds-delta ds-d-flat">较上期 —</span>';
    var cls = v > 0 ? "ds-d-up" : (v < 0 ? "ds-d-down" : "ds-d-flat");
    var arrow = v > 0 ? "↑" : (v < 0 ? "↓" : "—");
    return '<span class="ds-delta ' + cls + '">' + arrow + " " + dsPct(Math.abs(v)) + ' 较上期</span>';
  }

  function dsParams() {
    var start = DS.start, end = DS.end;
    if (DS.range !== "custom") {
      if (DS.range === "today") { start = dsTodayISO(); end = start; }
      else if (DS.range === "7d") { start = dsDaysAgo(6); end = dsTodayISO(); }
      else if (DS.range === "30d") { start = dsDaysAgo(29); end = dsTodayISO(); }
      else { start = ""; end = ""; }
    }
    return "start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end) +
      "&channel=" + encodeURIComponent(DS.channel) + "&os=" + encodeURIComponent(DS.os) +
      "&attribution=" + encodeURIComponent(DS.attr);
  }
  function dsWindowText() {
    var r = DS_RANGE_LABEL[DS.range] || "自定义";
    if (DS.range === "custom") r = (DS.start || "起始") + " — " + (DS.end || "至今");
    return r + " · " + (DS.attr === "first" ? "首次触点归因" : "末次触点归因") +
      (DS.channel ? " · " + (DS_CHANNEL_CN[DS.channel] || DS.channel) : "") +
      (DS.os ? " · " + DS.os : "");
  }

  function loadStatsPage() {
    var seq = ++DS_REQ_SEQ;
    var tip = $("#ds-window-tip"); if (tip) tip.textContent = "统计中…";
    apiAdmin("/admin/stats/overview?" + dsParams()).then(function (res) {
      if (seq !== DS_REQ_SEQ) return;             // 有更新的请求在飞，丢弃旧结果
      if (!res.body || !res.body.ok) {
        if (tip) tip.textContent = "统计加载失败";
        return;
      }
      DS.data = res.body;
      renderStatsPage(res.body);
    }).catch(function () {
      if (seq !== DS_REQ_SEQ) return;
      if (tip) tip.textContent = "网络异常，请重试";
    });
  }

  function renderStatsPage(d) {
    var tip = $("#ds-window-tip"); if (tip) tip.textContent = dsWindowText();
    var k = d.kpi || {}, dl = d.delta || {};
    // KPI 卡：大号是区间累计，下面给当日值与环比——总数与单日一屏都能看到
    var cards = [
      { lb: "访客 UV", v: dsFmt(k.uv), sub: "今日 " + dsFmt((d.today || {}).uv), delta: dl.uv },
      { lb: "页面 PV", v: dsFmt(k.pv), sub: "今日 " + dsFmt((d.today || {}).pv), delta: dl.pv },
      { lb: "会话数", v: dsFmt(k.sessions), sub: "人均 " + (k.page_per_uv || 0) + " 页 / 人", delta: dl.sessions },
      { lb: "识别用户", v: dsFmt(k.users), sub: "已拿到微信身份的访客", delta: null },
      { lb: "访客报名转化率", v: ((k.signup_rate || 0) * 100).toFixed(1) + "%", sub: "提交报名 / 访客 UV", delta: null }
    ];
    var kb = $("#ds-kpi");
    if (kb) kb.innerHTML = cards.map(function (c) {
      return '<div class="ds-kpi-card"><p class="ds-lb">' + esc(c.lb) + '</p>' +
        '<p class="ds-nm">' + esc(c.v) + '</p><p class="ds-sub">' + esc(c.sub) + '</p>' +
        dsDeltaHTML(c.delta) + '</div>';
    }).join("");

    renderDSTrend(d.trend || []);
    var chLabel = DS.attr === "first" ? "首次来源" : "本次来源";
    var chTitle = $("#ds-ch-title");
    if (chTitle) chTitle.innerHTML = "渠道来源 <span class=\"ad-panel-hint\">" + chLabel + "</span>";
    renderDSBars("#ds-channels", DS.attr === "first" ? (d.first_channels || []) : (d.channels || []), true);
    renderDSBars("#ds-devices", d.devices || [], false);
    renderDSFunnel(d.funnel || []);
    renderDSModels(d.models || []);
  }

  // 折线图：纯 SVG，不引第三方图表库（后台是低频页面，避免多一个 CDN 依赖）
  function renderDSTrend(rows) {
    var box = $("#ds-trend"); if (!box) return;
    if (!rows.length) { box.innerHTML = '<p class="ds-empty">所选条件下暂无访问数据</p>'; return; }
    var W = 900, H = 190, PL = 42, PR = 12, PT = 14, PB = 30;
    var max = Math.max.apply(null, rows.map(function (r) { return Math.max(r.uv, r.pv); })) || 1;
    max = Math.ceil(max * 1.15);
    var n = rows.length;
    var x = function (i) { return PL + (n === 1 ? (W - PL - PR) / 2 : i * (W - PL - PR) / (n - 1)); };
    var y = function (v) { return PT + (H - PT - PB) * (1 - v / max); };
    var line = function (key) {
      return rows.map(function (r, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(r[key]).toFixed(1); }).join(" ");
    };
    var grid = "";
    for (var g = 0; g <= 4; g++) {
      var gv = Math.round(max * g / 4), gy = y(gv);
      grid += '<line x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) +
        '" stroke="var(--ds-grid)" stroke-width="1"/>' +
        '<text x="' + (PL - 8) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end" class="ds-axis">' + gv + '</text>';
    }
    var labels = "";
    var step = Math.max(1, Math.ceil(n / 8));
    rows.forEach(function (r, i) {
      if (i % step === 0 || i === n - 1) {
        labels += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" class="ds-axis">' +
          esc(dsDateLabel(r.date)) + '</text>';
      }
    });
    var dots = rows.filter(function (r, i) { return i % step === 0 || i === n - 1; }).map(function (r) {
      var i = rows.indexOf(r);
      return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(r.pv).toFixed(1) + '" r="2.8" fill="var(--ds-blue)"/>';
    }).join("");
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" class="ds-svg" role="img" aria-label="每日 UV 与 PV 趋势">' +
      grid +
      '<path d="' + line("pv") + '" fill="none" stroke="var(--ds-blue)" stroke-width="2"/>' +
      '<path d="' + line("uv") + '" fill="none" stroke="var(--ds-teal)" stroke-width="2" stroke-dasharray="5 4"/>' +
      dots + labels + '</svg>' +
      '<div class="ds-legend"><span><i class="ds-dot ds-dot-blue"></i>页面 PV</span>' +
      '<span><i class="ds-dot ds-dot-teal"></i>访客 UV</span>' +
      '<span class="ds-legend-note">共 ' + n + ' 天</span></div>';
  }

  function renderDSBars(sel, rows, isChannel) {
    var box = $(sel); if (!box) return;
    if (!rows.length) { box.innerHTML = '<p class="ds-empty">暂无数据</p>'; return; }
    var max = rows[0].uv || 1;
    box.innerHTML = rows.map(function (r) {
      var name = isChannel ? (DS_CHANNEL_CN[r.name] || r.name) : r.name;
      var pct = Math.round(r.uv / max * 100);
      return '<div class="ds-bar-row"><div class="ds-bar-name">' + esc(name) + '</div>' +
        '<div class="ds-bar-track"><div class="ds-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="ds-bar-num">' + dsFmt(r.uv) + '</div>' +
        '<div class="ds-bar-pv">' + dsFmt(r.pv) + ' PV</div></div>';
    }).join("");
  }

  function renderDSFunnel(rows) {
    var box = $("#ds-funnel"); if (!box) return;
    if (!rows.length) { box.innerHTML = '<p class="ds-empty">暂无数据</p>'; return; }
    var max = rows[0].uv || 1;
    box.innerHTML = rows.map(function (f, i) {
      var w = Math.max(8, Math.round(f.uv / max * 100));
      return '<div class="ds-fn-step"><div class="ds-fn-label">' + esc(f.label) + '</div>' +
        '<div class="ds-fn-track"><div class="ds-fn-fill ds-fn-' + i + '" style="width:' + w + '%"></div></div>' +
        '<div class="ds-fn-num">' + dsFmt(f.uv) + '</div>' +
        '<div class="ds-fn-rate">' + (i === 0 ? "100%" : (f.rate * 100).toFixed(1) + "%") + '</div></div>';
    }).join("");
  }

  function renderDSModels(models) {
    // 机型明细挂到设备面板底部，作为「大类下钻」的落点
    var box = $("#ds-devices"); if (!box || !models.length) return;
    var top = models.slice(0, 6);
    var html = '<div class="ds-model-line">机型 Top：' + top.map(function (m) {
      return esc(m.name) + ' ' + dsFmt(m.uv);
    }).join(" · ") + '</div>';
    box.insertAdjacentHTML("beforeend", html);
  }

  var DS_BOUND = false;
  function bindStatsPage() {
    if (DS_BOUND) return;      // 反复切 tab 不能重复挂事件，否则一次点击发多次请求
    DS_BOUND = true;
    $all("#ds-quick button").forEach(function (b) {
      b.addEventListener("click", function () {
        DS.range = b.getAttribute("data-range");
        if (DS.range !== "custom") { DS.start = ""; DS.end = ""; }
        $all("#ds-quick button").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        var si = $("#ds-start"), ei = $("#ds-end");
        if (si) si.value = DS.start; if (ei) ei.value = DS.end;
        loadStatsPage();
      });
    });
    var si = $("#ds-start"), ei = $("#ds-end");
    if (si) si.addEventListener("change", function () { DS.start = si.value; DS.range = "custom";
      $all("#ds-quick button").forEach(function (x) { x.classList.remove("on"); }); });
    if (ei) ei.addEventListener("change", function () { DS.end = ei.value; DS.range = "custom";
      $all("#ds-quick button").forEach(function (x) { x.classList.remove("on"); }); });
    var ch = $("#ds-channel"), os = $("#ds-os"), at = $("#ds-attr");
    if (ch) ch.addEventListener("change", function () { DS.channel = ch.value; });
    if (os) os.addEventListener("change", function () { DS.os = os.value; });
    if (at) at.addEventListener("change", function () { DS.attr = at.value; loadStatsPage(); });
    var ap = $("#ds-apply"); if (ap) ap.addEventListener("click", loadStatsPage);

    var ex1 = $("#ds-exp-summary"), ex2 = $("#ds-exp-events");
    var doExport = function (kind) {
      if (!ADMIN_TOKEN) return;
      window.open(API + "/admin/stats/export?token=" + encodeURIComponent(ADMIN_TOKEN) +
        "&" + dsParams() + "&kind=" + kind, "_blank");
    };
    if (ex1) ex1.addEventListener("click", function () { doExport("summary"); });
    if (ex2) ex2.addEventListener("click", function () { doExport("events"); });

    // 指标字典弹层：弱提示入口，点开是独立说明页，不打断当前筛选状态
    var dm = $("#dict-modal");
    var dictToggle = function (on) { if (dm) dm.style.display = on ? "flex" : "none"; };
    var dOpen = $("#ds-dict-open"), dClose = $("#dict-close"),
        dOk = $("#dict-ok"), dMask = $("#dict-mask"), dPrint = $("#dict-print");
    if (dOpen) dOpen.addEventListener("click", function () { dictToggle(true); });
    if (dClose) dClose.addEventListener("click", function () { dictToggle(false); });
    if (dOk) dOk.addEventListener("click", function () { dictToggle(false); });
    if (dMask) dMask.addEventListener("click", function () { dictToggle(false); });
    if (dPrint) dPrint.addEventListener("click", function () { window.print(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && dm && dm.style.display === "flex") dictToggle(false);
    });
  }

  // ---- 渠道码（v138）：一张海报一个码，扫码与报名分开归因 ----
  // 扫码人数按设备去重（events.did），与 UV 同口径；
  // 报名数取 source_code=该码且仍在生效的记录，关闭过的报名不算转化。
  var MAT_ROWS = [];
  var MAT_BOUND = false;

  // from=material 决定「物料扫码」这个分类，m 才是具体哪一张物料
  function matLinkOf(row) {
    // 渠道码也要带活动上下文：一张海报只属于一场活动，脱离活动就归不了因
    return window.__ACTLINK.url(currentActivityCode(),
      "from=material&m=" + encodeURIComponent(row.code)) +
      (row.kind === "checkin" ? "#/checkin" : "#/intro");
  }

  function findMat(id) {
    for (var i = 0; i < MAT_ROWS.length; i++) {
      if (String(MAT_ROWS[i].id) === String(id)) return MAT_ROWS[i];
    }
    return null;
  }

  function copyPlain(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("链接已复制"); },
        function () { toast("复制失败，请手动选中"); });
      return;
    }
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("链接已复制"); }
    catch (e) { toast("复制失败，请手动选中"); }
    ta.remove();
  }

  function renderMaterialCodes() {
    var tb = $("#mat-body");
    if (!tb) return;
    if (!MAT_ROWS.length) {
      tb.innerHTML = '<tr><td colspan="8" class="td-empty">还没有渠道码。' +
        '建一个，再把链接印到海报或推文里；不想分渠道就直接用上面的通用报名码。</td></tr>';
      return;
    }
    tb.innerHTML = MAT_ROWS.map(function (r) {
      // 没人扫码时显示「—」而不是 0%：0% 会让人以为码坏了，其实是还没投放
      var rate = (r.rate === null || typeof r.rate === "undefined") ? "—" : r.rate + "%";
      return '<tr>' +
        '<td class="td-wrap">' + esc(r.name) + '</td>' +
        '<td>' + esc(r.scene || "—") + '</td>' +
        '<td class="td-mono">' + esc(r.code) + '</td>' +
        '<td class="num">' + (r.scans || 0) + '</td>' +
        '<td class="num">' + (r.regs || 0) + '</td>' +
        '<td class="num">' + rate + '</td>' +
        '<td>' + (r.enabled ? '<span class="mat-on">启用</span>' : '<span class="mat-off">已停用</span>') + '</td>' +
        '<td class="mat-row-ops">' +
          '<button type="button" class="btn-ghost" data-mat-act="png" data-mid="' + r.id + '">PNG</button>' +
          '<button type="button" class="btn-ghost" data-mat-act="svg" data-mid="' + r.id + '">SVG</button>' +
          '<button type="button" class="btn-ghost" data-mat-act="copy" data-mid="' + r.id + '">复制链接</button>' +
          '<button type="button" class="btn-ghost" data-mat-act="toggle" data-mid="' + r.id + '">' +
            (r.enabled ? "停用" : "启用") + '</button>' +
          // 删除只在停用后出现：启用中的码还印在外面，删了就查不到投放效果
          (r.enabled ? "" :
            '<button type="button" class="btn-ghost acct-btn is-danger" data-mat-act="del" data-mid="' + r.id + '">删除</button>') +
        '</td></tr>';
    }).join("");
  }

  function loadMaterialCodes() {
    apiAdmin("/admin/materials").then(function (res) {
      if (!res.body || !res.body.ok) return;
      MAT_ROWS = res.body.rows || [];
      // 多通道核销是专业版能力位（RD-23）：没权限时只留默认兜底码，
      // 界面把 checkin 选项置灰并说明原因，避免运营点下去才吃 403。
      var canMulti = !!(res.body.features && res.body.features.checkin_multi);
      var opt = $("#mat-kind option[value='checkin']");
      if (opt) {
        opt.disabled = !canMulti;
        opt.textContent = canMulti ? "签到页（现场核销用）" : "签到页（现场核销用 · 专业版）";
        if (!canMulti && $("#mat-kind").value === "checkin") $("#mat-kind").value = "signup";
      }
      var note = $("#mat-checkin-note");
      if (note) note.style.display = canMulti ? "none" : "";
      renderMaterialCodes();
    });
  }

  function bindMaterialsPage() {
    if (MAT_BOUND) return;
    MAT_BOUND = true;

    var tb = $("#mat-body");
    if (tb) tb.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-mat-act]") : null;
      if (!btn) return;
      var row = findMat(btn.getAttribute("data-mid"));
      if (!row) return;
      var act = btn.getAttribute("data-mat-act");
      if (act === "png" || act === "svg") {
        downloadQrUrl(matLinkOf(row), row.name + "-" + row.code, act);
        return;
      }
      if (act === "copy") { copyPlain(matLinkOf(row)); return; }
      if (act === "del") {
        askConfirm({
          title: "删除投放码",
          text: "确定删除「" + row.name + "」？\n" +
            "· 短码 " + row.code + "，已有 " + (row.scans || 0) + " 人扫码、" + (row.regs || 0) + " 条报名\n" +
            "· 删除后渠道名不再显示，历史数据仍按短码 " + row.code + " 记录\n" +
            "· 已印出去的物料照旧能打开，但不再计入该渠道",
          okText: "确认删除"
        }).then(function (yes) {
          if (!yes) return;
          postJ("/admin/materials/delete?token=" + encodeURIComponent(ADMIN_TOKEN),
            { id: row.id }).then(function (res) {
              if (res.body && res.body.ok) { toast("已删除 " + row.code); loadMaterialCodes(); }
              else toast((res.body && res.body.detail) || "删除失败");
            }).catch(function () { toast("网络异常，未执行"); });
        });
        return;
      }
      if (act === "toggle") {
        postJ("/admin/materials/update?token=" + encodeURIComponent(ADMIN_TOKEN),
          { id: row.id, enabled: row.enabled ? 0 : 1 }).then(function (res) {
            if (res.body && res.body.ok) {
              toast(row.enabled ? "已停用，扫码仍可访问但不再计入该码" : "已启用");
              loadMaterialCodes();
            } else {
              toast((res.body && res.body.detail) || "操作失败");
            }
          }).catch(function () { toast("网络异常，未执行"); });
      }
    });

    var modal = $("#mat-modal");
    var toggle = function (on) { if (modal) modal.style.display = on ? "flex" : "none"; };
    var nw = $("#mat-new");
    if (nw) nw.addEventListener("click", function () {
      var nm = $("#mat-name"), msg = $("#mat-msg");
      if (nm) nm.value = "";
      if (msg) msg.textContent = "";
      // 首次打开时把两个原生 select 升级成自绘下拉，避开 Safari 菜单弹到屏幕底部的漂移。
      // enhanceSelect 内部幂等（dataset.enhanced），重复打开无副作用。
      enhanceSelect($("#mat-scene"));
      enhanceSelect($("#mat-kind"));
      toggle(true);
      if (nm) nm.focus();
    });
    ["#mat-cancel", "#mat-mask"].forEach(function (sel) {
      var el = $(sel);
      if (el) el.addEventListener("click", function () { toggle(false); });
    });

    var save = $("#mat-save");
    if (save) save.addEventListener("click", function () {
      var nm = $("#mat-name"), msg = $("#mat-msg");
      var name = nm ? (nm.value || "").trim() : "";
      if (name.length < 2) {
        if (msg) msg.textContent = "请填写渠道名称（至少 2 字）";
        return;
      }
      var sceneEl = $("#mat-scene"), kindEl = $("#mat-kind");
      save.disabled = true;
      postJ("/admin/materials?token=" + encodeURIComponent(ADMIN_TOKEN), {
        name: name,
        scene: sceneEl ? sceneEl.value : "",
        kind: kindEl ? kindEl.value : "signup"
      }).then(function (res) {
        save.disabled = false;
        if (res.body && res.body.ok) {
          toggle(false);
          toast("已创建，短码 " + res.body.code);
          loadMaterialCodes();
        } else if (msg) {
          msg.textContent = (res.body && res.body.detail) || "创建失败";
        }
      }).catch(function () {
        save.disabled = false;
        if (msg) msg.textContent = "网络异常，请重试";
      });
    });
  }

  // ---- 运营工作台（v142）：今日三数 + 异常体检 + 最近动态 ----
  // 一次请求拿全，不让前端串四个接口——现场用手机热点时，少一个往返就少一次转圈。
  function wbDelta(cur, prev) {
    var d = (cur || 0) - (prev || 0);
    if (!d) return '<span class="wb-d flat">持平</span>';
    // 不套红绿涨跌：这是业务量不是行情，「涨」就是好，用绿；跌用橙提醒但不刺眼
    return '<span class="wb-d ' + (d > 0 ? "up" : "down") + '">' +
      (d > 0 ? "↑" : "↓") + Math.abs(d) + "</span>";
  }

  function renderWorkbench(d) {
    var box = $("#wb-today");
    if (box) {
      var t = d.today || {}, y = d.yesterday || {}, all = d.total || {};
      var cards = [
        ["今日报名", t.reg, y.reg, "累计 " + (all.reg || 0) + " 人"],
        ["今日签到", t.checkin, y.checkin, "累计 " + (all.checkin || 0) + " 人"],
        ["今日领卡", t.card, y.card, "累计 " + (all.card || 0) + " 人"]
      ];
      box.innerHTML = cards.map(function (c) {
        return '<div class="wb-card">' +
          '<div class="wb-k">' + c[0] + '</div>' +
          '<div class="wb-v">' + (c[1] || 0) + wbDelta(c[1], c[2]) + '</div>' +
          '<div class="wb-sub">' + c[3] + '</div></div>';
      }).join("");
    }

    var al = $("#wb-alerts");
    if (al) {
      var list = d.alerts || [];
      if (!list.length) {
        al.innerHTML = '<div class="wb-ok">✓ 一切正常，没有需要处理的事</div>';
      } else {
        al.innerHTML = list.map(function (a) {
          return '<div class="wb-alert ' + (a.level === "info" ? "info" : "warn") + '">' +
            "<i>" + (a.level === "info" ? "·" : "!") + "</i><span>" +
            esc(a.text) + "</span></div>";
        }).join("");
      }
    }

    var rc = $("#wb-recent");
    if (rc) {
      var rows = d.recent || [];
      rc.innerHTML = rows.length ? rows.map(function (r) {
        // 闸门那条详情会带完整窗口串，一行能铺满屏；摘要里截断，全量去审计页看
        var d = r.detail || "";
        if (d.length > 56) d = d.slice(0, 56) + "…";
        return '<div class="wb-item">' +
          '<span class="t">' + esc(fmtTime(r.created_at)) + "</span>" +
          '<span class="what">' + esc(ACTION_CN[r.action] || r.action) +
            (d ? " · " + esc(d) : "") + "</span>" +
          '<span class="who">' + esc(r.operator || "") + "</span></div>";
      }).join("") : '<div class="td-empty">暂无动态</div>';
    }
  }

  function loadWorkbench() {
    apiAdmin("/admin/workbench").then(function (res) {
      if (!res.body || !res.body.ok) return;
      renderWorkbench(res.body);
    });
  }

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

  // ============ P8-c 批量核销 / 最小数据集导出 ============
  function openBatchModal(id, name) {
    var old = $("#batch-modal");
    if (old) old.parentNode.removeChild(old);
    var wrap = document.createElement("div");
    wrap.id = "batch-modal";
    wrap.className = "gm-mask";
    wrap.innerHTML =
      '<div class="gm-box batch-box">' +
        '<h3>批量核销 · ' + esc(name) + '</h3>' +
        '<p class="gm-tip">每行一个 8 位凭证码。重复的码按「已核销」返回，不会出错；单次最多 200 条。</p>' +
        '<textarea id="batch-codes" rows="10" placeholder="A1B2C3D4\nE5F6G7H8" maxlength="2400"></textarea>' +
        '<div id="batch-result" class="gm-tip"></div>' +
        '<div class="gm-ops">' +
          '<button type="button" class="btn-ghost" id="batch-export">下载最小数据集</button>' +
          '<button type="button" class="btn-ghost" id="batch-cancel">关闭</button>' +
          '<button type="button" class="btn-primary" id="batch-go">确认核销</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    var close = function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); };
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    $("#batch-cancel").onclick = close;

    $("#batch-go").onclick = function () {
      var raw = $("#batch-codes").value.split(/[\s,，]+/).filter(Boolean);
      if (!raw.length) { toast("请先粘贴凭证码"); return; }
      var btn = this; btn.disabled = true;
      var out = $("#batch-result"); out.textContent = "核销中…";
      sendAdmin("POST", "/admin/activity/" + id + "/batch-verify", { codes: raw }).then(function (res) {
        btn.disabled = false;
        var b = res.body || {};
        if (!res.ok || !b.ok) { out.textContent = (b.detail || "核销失败"); return; }
        var s = b.summary || {};
        out.textContent = "成功 " + (s.checked || 0) + " 条 · 已核销 " + (s.already || 0) +
          " 条 · 未找到 " + (s.not_found || 0) + " 条" + (s.error ? " · 失败 " + s.error + " 条" : "");
        var bad = (b.rows || []).filter(function (r) {
          return r.status === "not_found" || r.status === "error";
        }).map(function (r) { return r.code; });
        if (bad.length) out.textContent += "\n未找到/失败：" + bad.slice(0, 20).join(" ") +
          (bad.length > 20 ? " 等 " + bad.length + " 条" : "");
        toast("批量核销完成");
      }).catch(function () { btn.disabled = false; out.textContent = "网络异常，请重试"; });
    };

    // 最小数据集：脱敏 CSV，后端记审计
    $("#batch-export").onclick = function () {
      var sep = "?";
      var u = API + "/admin/activity/" + id + "/minimal-export" +
              sep + "token=" + encodeURIComponent(ADMIN_TOKEN);
      window.open(u, "_blank");
    };
  }

  // ============ 平台：表单字段配置（P4-b3）============
  // 这一页是整个后台里唯一「改完还得让历史数据解释得通」的配置：
  // 字段名换了、选项删了，老报名里存的值就成了孤儿。
  //
  // 三条界面原则：
  //   1. 后果写在动手之前——顶部常驻一句「有 N 条报名，保存会升版本」，
  //      而不是保存完才告诉人升了版本。
  //   2. 本地先校验一遍再提交。后端也会拦（同一套 form.validate_fields_def），
  //      但往返一次只说一句 detail 太慢，定位不到是哪个字段。
  //   3. 「载入这一版」只灌进编辑器，不直接存——回滚本身也是保存，
  //      同样受冻结规则约束，不该有第二条绕过它的路径。

  var FR_FIELDS = [];       // 正在编辑的字段定义（工作副本）
  var FR_META = null;       // /admin/form 的元信息：version / frozen / types / required_core
  var FR_EDIT = -1;         // 当前展开编辑的字段下标，-1 表示都收起
  var FR_TYPES = {};        // key -> {label, attrs}
  var FR_OPTS = [[1, "第 1 步"], [2, "第 2 步"]];

  function frClone(o) { return JSON.parse(JSON.stringify(o)); }

  function frTypeLabel(t) { return (FR_TYPES[t] && FR_TYPES[t].label) || t; }

  function frTypeOpts() {
    var out = [];
    for (var k in FR_TYPES) out.push([k, FR_TYPES[k].label]);
    return out;
  }

  // 必须保留的 core（后端 REQUIRE_CORE 下发），删了会让报名写入直接失败
  function frMustKeep(f) {
    return !!(f.core && FR_META && FR_META.required_core && FR_META.required_core[f.core]);
  }

  function frAttrFields(f) {
    var a = (FR_TYPES[f.type] && FR_TYPES[f.type].attrs) || [];
    return a;
  }

  function frField(name, label, value, extra, hint) {
    return '<label class="fr-f"><span>' + esc(label) + '</span>' +
      '<input type="text" data-f="' + name + '" value="' + esc(value == null ? "" : value) + '"' +
      (extra || "") + '>' +
      (hint ? '<i class="fr-fhint">' + esc(hint) + '</i>' : '') + '</label>';
  }

  function frSelField(name, label, value, opts, hint) {
    var o = [];
    for (var i = 0; i < opts.length; i++) {
      o.push('<option value="' + esc(opts[i][0]) + '"' +
             (String(opts[i][0]) === String(value) ? " selected" : "") + '>' +
             esc(opts[i][1]) + '</option>');
    }
    return '<label class="fr-f"><span>' + esc(label) + '</span>' +
      '<select data-f="' + name + '">' + o.join("") + '</select>' +
      (hint ? '<i class="fr-fhint">' + esc(hint) + '</i>' : '') + '</label>';
  }

  // 行头：一屏能扫完的关键信息。标签+标识+类型+步骤，右侧操作。
  function frHeadHtml(f, i) {
    var tags = [];
    if (f.required) tags.push('<span class="fr-tag on">必填</span>');
    if (f.core) tags.push('<span class="fr-tag core" title="值写入报名的固定列">主表</span>');
    if (f.visible_when) tags.push('<span class="fr-tag cond" title="按条件显示">条件</span>');
    var dis = FR_META && FR_META.can_edit === false;
    return '<div class="fr-row-hd">' +
      '<span class="fr-ord">' + (i + 1) + '</span>' +
      '<b>' + esc(f.label || "(未命名)") + '</b>' +
      '<span class="act-code">' + esc(f.key) + '</span>' +
      '<span class="fr-type">' + esc(frTypeLabel(f.type)) + '</span>' +
      '<span class="fr-tag step">第 ' + (f.step || 1) + ' 步</span>' +
      tags.join("") +
      '<div class="fr-row-ops">' +
      (dis ? "" :
        '<button type="button" class="acct-btn" data-act="up" title="上移">↑</button>' +
        '<button type="button" class="acct-btn" data-act="down" title="下移">↓</button>' +
        '<button type="button" class="acct-btn fr-toggle" data-act="edit">' +
        (FR_EDIT === i ? "收起" : "编辑") + '</button>' +
        (frMustKeep(f)
          ? '<span class="fr-lock" title="报名主表的必填列，不能删除">必留</span>'
          : '<button type="button" class="acct-btn fr-danger" data-act="del">删除</button>')) +
      '</div></div>';
  }

  function frEditHtml(f, i) {
    var h = ['<div class="fr-edit">', '<div class="fr-grid">'];
    h.push(frField("label", "标签", f.label, ' maxlength="30"'));
    h.push(frField("key", "字段标识", f.key, ' maxlength="32"',
                   f.core ? "改标识不影响历史值（值在固定列）" : "改标识后，历史数据仍挂在旧标识下"));
    h.push(frSelField("type", "类型", f.type, frTypeOpts()));
    h.push(frSelField("step", "所在步骤", f.step || 1, FR_OPTS));
    h.push(frSelField("width", "宽度", f.width || "full",
                      [["full", "整行"], ["half", "半行（与下一个半行并排）"]]));
    h.push('<label class="fr-f fr-f-chk"><span>必填</span>' +
           '<input type="checkbox" data-f="required"' + (f.required ? " checked" : "") + '></label>');
    h.push('</div>');

    // 类型专属属性
    var attrs = frAttrFields(f);
    if (attrs.length) {
      h.push('<div class="fr-grid">');
      if (attrs.indexOf("options") >= 0) {
        // 行数跟着选项数走：12 个国家只给 5 行，得滚半天才看得完，
        // 而只有两个选项的字段给 8 行又白占地方
        var rows = Math.min(8, Math.max(3, (f.options || []).length + 1));
        h.push('<label class="fr-f fr-f-wide"><span>选项（一行一个）</span>' +
               '<textarea data-f="options" rows="' + rows + '">' +
               esc((f.options || []).join("\n")) + '</textarea></label>');
      }
      if (attrs.indexOf("max_select") >= 0) {
        h.push(frField("max_select", "最多可选", f.max_select || "", ' type="number" min="1"',
                       "留空表示不限（等于选项数）"));
      }
      if (attrs.indexOf("min_len") >= 0) h.push(frField("min_len", "最少字数", f.min_len || "", ' type="number"'));
      if (attrs.indexOf("max_len") >= 0) h.push(frField("max_len", "最多字数", f.max_len || "", ' type="number"'));
      if (attrs.indexOf("min_year") >= 0) h.push(frField("min_year", "最早年份", f.min_year || "", ' type="number"'));
      if (attrs.indexOf("max_year") >= 0) h.push(frField("max_year", "最晚年份", f.max_year || "", ' type="number"'));
      if (attrs.indexOf("min") >= 0) h.push(frField("min", "最小值", f.min || "", ' type="number"'));
      if (attrs.indexOf("max") >= 0) h.push(frField("max", "最大值", f.max || "", ' type="number"'));
      h.push('</div>');
    }

    // 通用两项
    h.push('<div class="fr-grid">');
    h.push(frField("placeholder", "输入框占位提示", f.placeholder || "", ' maxlength="60"'));
    h.push(frField("hint", "字段下方的说明", f.hint || "", ' maxlength="80"'));
    h.push('</div>');

    // 条件显示：只支持单层比较（与 form.py 的 visible_when 一致，不做表达式）
    var others = [];
    for (var k = 0; k < FR_FIELDS.length; k++) {
      if (k !== i) others.push([FR_FIELDS[k].key, FR_FIELDS[k].label]);
    }
    var cond = f.visible_when || null;
    h.push('<div class="fr-grid fr-cond">');
    h.push(frSelField("cond_key", "显示条件：依赖字段", cond ? cond.key : "",
                      [["", "（始终显示）"]].concat(others)));
    h.push(frSelField("cond_op", "运算符", cond ? (cond.op || "eq") : "eq",
                      [["eq", "等于"], ["ne", "不等于"], ["in", "属于其中之一"], ["nonempty", "已填写"]]));
    var cv = cond && cond.value != null ? (Array.isArray(cond.value) ? cond.value.join("、") : cond.value) : "";
    h.push(frField("cond_value", "比较值", cv, ' maxlength="60"',
                   "「属于其中之一」用顿号分隔多个值"));
    h.push('</div>');

    h.push('</div>');
    return h.join("");
  }

  function frRowHtml(f, i) {
    var open = FR_EDIT === i;
    return '<div class="fr-row' + (open ? " open" : "") + '" data-i="' + i + '">' +
      frHeadHtml(f, i) + (open ? frEditHtml(f, i) : "") + '</div>';
  }

  function frRenderList() {
    var box = $("#fr-list");
    if (!box) return;
    if (!FR_FIELDS.length) { box.innerHTML = '<p class="ad-empty">还没有字段</p>'; return; }
    var h = [];
    for (var i = 0; i < FR_FIELDS.length; i++) h.push(frRowHtml(FR_FIELDS[i], i));
    box.innerHTML = h.join("");
  }

  // 只刷行头，不重渲染编辑器——重渲染会让正在输入的输入框失焦
  function frRefreshHead(i) {
    var row = document.querySelector('#fr-list .fr-row[data-i="' + i + '"]');
    if (!row) return;
    var old = row.querySelector(".fr-row-hd");
    if (!old) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = frHeadHtml(FR_FIELDS[i], i);
    row.replaceChild(tmp.firstChild, old);
  }

  function frRenderMeta() {
    var box = $("#fr-meta");
    if (!box || !FR_META) return;
    var m = FR_META;
    var h = ['<span class="act-badge active">v' + m.version + '</span>'];
    if (m.self_healed) h.push('<span class="act-badge">模板</span>');
    box.innerHTML = h.join("");

    // RD-22：文案由后端下发，界面只渲染（textContent，杜绝注入）
    var pii = $("#fr-pii");
    if (pii) pii.textContent = m.pii_notice || "";

    var tip = $("#fr-tip");
    if (tip) {
      if (m.can_edit === false) {
        tip.innerHTML = '当前账号没有「修改活动配置」权限，以下内容只读。' +
          '需要改动请让活动管理员操作，或在「平台设置」里给自己授权。';
      } else if (m.frozen) {
        // 这句必须准确：表单结构变更与「发布闸门」是两套独立机制。
        // 保存后新报名立刻按新版采集，不用等发布；旧报名按它自己那一版解释。
        // 别写成「要先切回草稿才生效」——那会让人误以为不切就不生效。
        tip.innerHTML = '已有 <b>' + m.registration_count + '</b> 条报名：保存会发布 ' +
          '<b>v' + (m.version + 1) + '</b>。新报名立刻按新版采集；已收的 ' +
          m.registration_count + ' 条仍按 v' + m.version +
          ' 解释（报名页回填、导出列、详情都读各自那一版），不会错乱。';
      } else {
        tip.innerHTML = '还没有报名：保存直接改 v' + m.version +
          '，不升版本号（免得调个错字就涨一版）。';
      }
    }

    var addBtn = $("#fr-add"), defBtn = $("#fr-default"), saveBtn = $("#fr-save");
    var ro = m.can_edit === false;
    if (addBtn) addBtn.disabled = ro;
    if (defBtn) defBtn.disabled = ro;
    if (saveBtn) saveBtn.disabled = ro;
  }

  function loadFormSchema() {
    var box = $("#fr-list");
    if (!box) return;
    box.innerHTML = '<p class="ad-empty">加载中…</p>';
    apiAdmin("/admin/form").then(function (res) {
      var d = res.body || {};
      if (!d.ok) {
        box.innerHTML = '<p class="ad-empty">' +
          esc(d.detail || "表单配置加载失败") + '</p>';
        return;
      }
      FR_META = d;
      FR_TYPES = {};
      for (var i = 0; i < (d.types || []).length; i++) {
        FR_TYPES[d.types[i].key] = d.types[i];
      }
      FR_FIELDS = frClone(d.fields || []);
      FR_EDIT = -1;
      frRenderMeta();
      frRenderList();
      loadFormVersions();
    }).catch(function () {
      box.innerHTML = '<p class="ad-empty">表单配置加载失败，请刷新重试</p>';
    });
  }

  function loadFormVersions() {
    var box = $("#fr-vers");
    if (!box) return;
    apiAdmin("/admin/form/versions").then(function (res) {
      var rows = (res.body && res.body.rows) || [];
      if (!rows.length) {
        box.innerHTML = '<tr><td colspan="4" class="ad-empty">还没有版本记录</td></tr>';
        return;
      }
      var h = [];
      var ro = FR_META && FR_META.can_edit === false;
      for (var i = 0; i < rows.length; i++) {
        var v = rows[i];
        h.push('<tr><td>v' + v.version + '</td>');
        h.push('<td>' + (v.status === "published" ? '<span class="act-badge active">生效中</span>'
                          : '<span class="act-badge archived">已归档</span>') + '</td>');
        h.push('<td>' + esc(v.note || "") + '</td>');
        h.push('<td>' + esc(fmtTime(v.created_at)) + '</td>');
        // 只读账号不给「载入」：点了只会填进编辑器，而保存按钮是禁用的，
        // 白点一趟还以为是坏了
        h.push('<td>' + (ro ? '<span class="pf-off-tag">—</span>'
          : '<button type="button" class="acct-btn fr-load" data-v="' + v.version +
            '">载入这一版</button>') + '</td></tr>');
      }
      box.innerHTML = h.join("");
    });
  }

  // ---------- 编辑：改即写回 FR_FIELDS ----------
  function frSetValue(i, name, val) {
    var f = FR_FIELDS[i];
    if (!f) return;
    if (name === "required") { f.required = !!val; return; }
    if (name === "options") {
      var arr = String(val || "").split("\n");
      var out = [];
      for (var k = 0; k < arr.length; k++) {
        var s = arr[k].trim();
        if (s && out.indexOf(s) < 0) out.push(s);
      }
      f.options = out;
      return;
    }
    if (name === "step") { f.step = parseInt(val, 10) || 1; return; }
    if (["max_select", "min_len", "max_len", "min_year", "max_year", "min", "max"].indexOf(name) >= 0) {
      if (val === "" || val == null) delete f[name];
      else f[name] = parseFloat(val);
      return;
    }
    if (name === "cond_key" || name === "cond_op" || name === "cond_value") {
      var cur = f.visible_when || { key: "", op: "eq", value: "" };
      if (name === "cond_key") cur.key = val;
      if (name === "cond_op") cur.op = val;
      if (name === "cond_value") {
        // 「属于其中之一」存数组，其余存字符串——与 form.is_visible 的语义对齐
        cur.value = cur.op === "in"
          ? String(val).split("、").map(function (x) { return x.trim(); }).filter(Boolean)
          : val;
      }
      // 依赖字段清空＝这一项不设条件，整体去掉，别在 schema 里留一个空壳
      if (!cur.key) delete f.visible_when;
      else f.visible_when = cur;
      return;
    }
    if (val === "" || val == null) delete f[name];
    else f[name] = val;
  }

  function frBindList() {
    var box = $("#fr-list");
    if (!box || box.getAttribute("data-bound")) return;
    box.setAttribute("data-bound", "1");

    box.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-act]");
      if (!b) return;
      var row = b.closest(".fr-row");
      if (!row) return;
      var i = parseInt(row.getAttribute("data-i"), 10);
      var act = b.getAttribute("data-act");

      if (act === "edit") {
        FR_EDIT = (FR_EDIT === i) ? -1 : i;
        frRenderList();
        return;
      }
      if (act === "up" || act === "down") {
        var j = act === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= FR_FIELDS.length) return;
        var tmp = FR_FIELDS[i];
        FR_FIELDS[i] = FR_FIELDS[j];
        FR_FIELDS[j] = tmp;
        if (FR_EDIT === i) FR_EDIT = j;
        else if (FR_EDIT === j) FR_EDIT = i;
        frRenderList();
        return;
      }
      if (act === "del") {
        var f = FR_FIELDS[i];
        if (frMustKeep(f)) return;
        var msg = f.core
          ? "删除「" + f.label + "」？\n\n· 这个字段的值写的是报名主表的 " + f.core +
            " 列，删掉后新报名不再采集它\n· 已经收上来的报名数据不受影响，导出的这一列仍会有值"
          : "删除「" + f.label + "」？\n\n· 新报名不再出现这一项\n· 已收的报名里这一项的值还在（存在附加字段里），不会消失";
        askConfirm({ title: "删除字段", text: msg, okText: "确认删除" }).then(function (yes) {
          if (!yes) return;
          FR_FIELDS.splice(i, 1);
          FR_EDIT = -1;
          frRenderList();
        });
      }
    });

    // 改即写：input 与 change 都要接，select/checkbox 只发 change
    function onEdit(e) {
      var t = e.target;
      if (!t || !t.getAttribute || !t.getAttribute("data-f")) return;
      var row = t.closest(".fr-row");
      if (!row) return;
      var i = parseInt(row.getAttribute("data-i"), 10);
      var name = t.getAttribute("data-f");
      frSetValue(i, name, t.type === "checkbox" ? t.checked : t.value);
      // 类型改了，属性区要跟着换（选项/字数/年份）
      if (name === "type") frRenderList();
      else frRefreshHead(i);
    }
    box.addEventListener("input", onEdit);
    box.addEventListener("change", onEdit);
  }

  function frAddField() {
    var maxStep = 1, n = 1;
    for (var i = 0; i < FR_FIELDS.length; i++) {
      if ((FR_FIELDS[i].step || 1) > maxStep) maxStep = FR_FIELDS[i].step || 1;
    }
    // 标识要唯一：extra_1、extra_2……被占用就往后找
    var used = {};
    for (var k = 0; k < FR_FIELDS.length; k++) used[FR_FIELDS[k].key] = 1;
    while (used["extra_" + n]) n++;

    FR_FIELDS.push({
      key: "extra_" + n, type: "text", label: "新字段", required: false,
      step: maxStep, width: "full", placeholder: "", hint: ""
    });
    FR_EDIT = FR_FIELDS.length - 1;
    frRenderList();
    var row = document.querySelector('#fr-list .fr-row[data-i="' + FR_EDIT + '"]');
    if (row) {
      row.scrollIntoView({ block: "center" });
      var inp = row.querySelector('input[data-f="label"]');
      if (inp) { inp.focus(); inp.select(); }
    }
  }

  function frLoadDefault() {
    askConfirm({
      title: "载入默认模板",
      text: "把字段恢复成系统默认的 11 项？\n\n" +
        "· 只会填进编辑区，还没有保存，你可以先看一遍再决定\n" +
        "· 保存后若已有报名，会发布新版本（旧报名仍按旧版解释）",
      okText: "载入模板",
      danger: false
    }).then(function (yes) {
      if (!yes) return;
      apiAdmin("/admin/form/default").then(function (res) {
        var d = res.body || {};
        if (!d.ok) { toast(d.detail || "模板读取失败"); return; }
        FR_FIELDS = frClone(d.fields || []);
        FR_EDIT = -1;
        frRenderList();
        frSetMsg("已载入默认模板，尚未保存", "warn");
      });
    });
  }

  function frSetMsg(text, kind) {
    var m = $("#fr-save-msg");
    if (!m) return;
    m.textContent = text || "";
    m.className = "fr-save-msg" + (kind ? " " + kind : "");
  }

  // 本地预检：把「哪个字段的哪个属性不对」直接说出来。
  // 后端也会拦，但它的报错是一条 detail，往返一次才知道，体验差得多。
  function frValidateLocal() {
    var seen = {}, coreSeen = {};
    for (var i = 0; i < FR_FIELDS.length; i++) {
      var f = FR_FIELDS[i], where = "第 " + (i + 1) + " 项「" + (f.label || "未命名") + "」";
      var key = String(f.key || "").trim();
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) {
        return where + "的字段标识不合法（小写字母开头，字母数字下划线，≤32 位）";
      }
      if (seen[key]) return "字段标识重复：" + key;
      seen[key] = 1;
      if (!String(f.label || "").trim()) return where + "缺少标签";
      if (String(f.label).length > 30) return where + "的标签超过 30 字";
      if (["select", "radio", "checkbox"].indexOf(f.type) >= 0 &&
          (!f.options || !f.options.length)) {
        return where + "是" + frTypeLabel(f.type) + "，必须至少有一个选项";
      }
      if (f.core) {
        if (coreSeen[f.core]) return "主表列 " + f.core + " 被两个字段占用";
        coreSeen[f.core] = 1;
      }
      if (f.visible_when) {
        var dep = null;
        for (var k = 0; k < FR_FIELDS.length; k++) {
          if (k !== i && FR_FIELDS[k].key === f.visible_when.key) dep = FR_FIELDS[k];
        }
        if (!dep) return where + "的显示条件引用了不存在或自身的字段";
      }
    }
    var req = (FR_META && FR_META.required_core) || {};
    for (var c in req) {
      if (!coreSeen[c]) return "必须保留" + req[c] + "字段（主表列 " + c + "）";
    }
    return "";
  }

  function frSave() {
    var bad = frValidateLocal();
    if (bad) { frSetMsg(bad, "err"); return; }

    var btn = $("#fr-save");
    var prevVersion = FR_META ? FR_META.version : 0;
    if (btn) { btn.disabled = true; btn.textContent = "保存中…"; }
    frSetMsg("");

    sendAdmin("POST", "/admin/form", {
      fields: FR_FIELDS,
      note: ($("#fr-note") ? $("#fr-note").value : "").trim()
    }).then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = "保存字段配置"; }
      var d = res.body || {};
      if (!d.ok) { frSetMsg(d.detail || "保存失败", "err"); return; }
      var noteInput = $("#fr-note");
      if (noteInput) noteInput.value = "";
      if (d.unchanged) {
        // 点了保存但什么都没改：说清是「没变」而不是「没存上」，
        // 否则人会以为按钮坏了，接着多点几次
        frSetMsg("字段定义与当前 v" + d.version + " 完全一致，没有新建版本。", "warn");
      } else if (d.bumped) {
        frSetMsg("已发布 v" + d.version + "：新报名已按 v" + d.version +
                 " 采集；已收的 " + d.registration_count + " 条仍按 v" + prevVersion + " 解释。", "ok");
      } else {
        frSetMsg("已就地更新 v" + d.version + "（还没有报名，不升版本号）。", "ok");
      }
      toast(d.bumped ? "已发布 v" + d.version : "已保存 v" + d.version);
      // 重新拉一次：版本号、冻结状态、报名数都可能变了
      loadFormSchema();
    });
  }

  function bindFormPage() {
    frBindList();
    var addBtn = $("#fr-add"), defBtn = $("#fr-default"), saveBtn = $("#fr-save");
    if (addBtn && !addBtn.getAttribute("data-bound")) {
      addBtn.setAttribute("data-bound", "1");
      addBtn.addEventListener("click", frAddField);
    }
    if (defBtn && !defBtn.getAttribute("data-bound")) {
      defBtn.setAttribute("data-bound", "1");
      defBtn.addEventListener("click", frLoadDefault);
    }
    if (saveBtn && !saveBtn.getAttribute("data-bound")) {
      saveBtn.setAttribute("data-bound", "1");
      saveBtn.addEventListener("click", frSave);
    }
    var vers = $("#fr-vers");
    if (vers && !vers.getAttribute("data-bound")) {
      vers.setAttribute("data-bound", "1");
      vers.addEventListener("click", function (e) {
        var b = e.target.closest(".fr-load");
        if (!b) return;
        var v = b.getAttribute("data-v");
        askConfirm({
          title: "载入 v" + v,
          text: "把 v" + v + " 的字段定义填进编辑区？\n\n" +
            "· 只是填进编辑区，还没有保存\n" +
            "· 保存后若已有报名，会再发布一个新版本",
          okText: "载入",
          danger: false
        }).then(function (yes) {
          if (!yes) return;
          apiAdmin("/admin/form/versions/" + v).then(function (res) {
            var d = res.body || {};
            if (!d.ok) { toast(d.detail || "读取失败"); return; }
            FR_FIELDS = frClone(d.fields || []);
            FR_EDIT = -1;
            frRenderList();
            frSetMsg("已载入 v" + v + " 的字段定义，尚未保存", "warn");
          });
        });
      });
    }
    loadFormSchema();
  }

  function loadAdminStaff() {
    if (!ADMIN_TOKEN) return;
    api("/admin/staff?token=" + encodeURIComponent(ADMIN_TOKEN)).then(function (res) {
      var rows = (res.body && res.body.rows) || [], box = $("#staff-rows");
      if (!box) return;
      box.innerHTML = rows.map(function (r) {
        var ops = '<button class="reg-btn" data-staff-act="ticket" data-id="' + r.id + '">绑定码</button> ' +
          '<button class="reg-btn" data-staff-act="toggle" data-id="' + r.id + '" data-on="' + (r.enabled ? 1 : 0) + '">' + (r.enabled ? "停用" : "启用") + "</button> " +
          '<button class="reg-btn" data-staff-act="reset" data-id="' + r.id + '">重置凭证</button> ' +
          '<button class="reg-btn reg-btn-danger" data-staff-act="unbind" data-id="' + r.id + '">解绑</button>';
        // 删除只在停用后出现：运行中的人直接删掉，核销现场会突然少人
        if (!r.enabled) {
          ops += ' <button class="reg-btn reg-btn-danger" data-staff-act="del" data-id="' + r.id +
            '" data-name="' + esc(r.username) + '">删除</button>';
        }
        return "<tr><td>" + esc(r.username) + "</td>" +
          '<td class="td-mono staff-token">' + esc(r.token) + "</td>" +
          "<td>" + (r.openid ? "已绑定" : "未绑定") + "</td>" +
          "<td>" + (r.enabled ? "启用" : "停用") + "</td>" +
          "<td>" + ops + "</td></tr>";
      }).join("");
      var cell = box;
      cell.onclick = function (e) {
        var b = e.target && e.target.closest ? e.target.closest("[data-staff-act]") : null;
        if (!b) return;
        var id = parseInt(b.getAttribute("data-id"), 10), act = b.getAttribute("data-staff-act"),
            payload = { token: ADMIN_TOKEN, id: id };
        if (act === "toggle") payload.enabled = b.getAttribute("data-on") !== "1";
        if (act === "reset") payload.reset_token = true;
        if (act === "unbind") payload.unbind = true;
        if (act === "del") {
          var nm = b.getAttribute("data-name") || "";
          askConfirm({
            title: "删除现场核销人员",
            text: "确定删除「" + nm + "」？\n" +
              "· 核销凭证立即失效，该人员不能再扫码核销\n" +
              "· 微信绑定解除，绑定码一并作废\n" +
              "· 历史核销流水保留，操作人姓名仍可追溯",
            okText: "确认删除"
          }).then(function (yes) {
            if (!yes) return;
            postJ("/admin/staff/delete", payload).then(function (res) {
              if (res.body && res.body.ok) { toast("已删除 " + nm); loadAdminStaff(); }
              else toast((res.body && res.body.detail) || "删除失败");
            }).catch(function () { toast("网络异常，未执行"); });
          });
          return;
        }
        if (act === "ticket") {
          postJ("/admin/staff/ticket", payload).then(function (r) {
            var t = r.body && r.body.ticket; if (!t) return;
            // 绑定页是参与者端路由（view-staff-bind），必须回站点根，不能用后台自己的
            // location.pathname —— 那会拼成 /admin/#/staff-bind，后台没有这条路由。
            var url = siteUrl("#/staff-bind?ticket=" + encodeURIComponent(t));
            var qr = $("#staff-bind-qr"); if (qr) qr.innerHTML = qrSvg(url, 6, 12);
            var p = $("#staff-bind-panel"); if (p) p.style.display = "block";
            var lk = $("#staff-bind-link"); if (lk) lk.textContent = url;
          });
          return;
        }
        postJ("/admin/staff/update", payload).then(function () { loadAdminStaff(); });
      };
    });
  }
  function bindAdminStaff() {
    var f = $("#staff-form"); if (!f) return;
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("#staff-msg");
      postJ("/admin/staff", { token: ADMIN_TOKEN, username: f.username.value.trim() })
        .then(function (res) {
          if (msg) msg.textContent = (res.body && res.body.ok)
            ? "已创建，专属核销凭证见下表" : ((res.body && res.body.detail) || "创建失败");
          if (res.body && res.body.ok) { f.reset(); loadAdminStaff(); }
        });
    });
  }

  // ---- 启动 ----
  // 运营控制台启动入口：独立站点，无微信授权、无用户端路由
  function adminBoot() {
    // 独立站点没有用户端路由的 render()，这里自己把视图设为可见
    var view = $("#view-admin"); if (view) view.classList.add("active");
    document.body.setAttribute("data-route", "admin");
    renderWatermark();
    bindAdmin();
    // 一次性绑定：这些原本写在参与者端启动函数里，拆分时函数定义跟过来了、
    // 调用却留在了旧启动函数，导致对应按钮点了没反应。后台没有 switchTab 逐页绑定，
    // 必须在这里一次性挂上（gate/switch 那几个在 switchTab 里已有，别重复）。
    bindAdminBgm();
    bindAdminStaff();
    bindRegEdit();
    bindManualCheckin();
    fillDtSelects();
    // 刷新页面时按会话自动恢复登录，不用重输密码
    if (restoreSession()) return;
    // 没有会话：确保登录页可见
    var wrap = $("#admin-login-wrap"), panel = $("#admin-panel");
    if (wrap) wrap.style.display = "flex";
    if (panel) panel.style.display = "none";
    loadConfig().catch(function () {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", adminBoot);
  else adminBoot();
})();

