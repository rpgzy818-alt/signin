/* 活动链接的唯一实现（方向二，2026-11-25）
 *
 * 为什么单独一个文件：参与者端（index.html）与后台（admin/index.html）都要拼活动
 * 链接，而两边是被 build.py 分别打包的两份产物。写在任一侧的公共片段里，
 * 另一侧就引不到；两边各写一遍，形态迟早分叉——一处拼出路径式、一处还是 ?a=，
 * 运营印出去的物料码就有一半是错的，且错了收不回来。
 *
 * 两种形态：
 *   机构子域（<code>.<ORG_DOMAIN_SUFFIX>）：   https://demo.example.com/summit2026
 *   主站路径（/platform-staging/）：            https://your-site.example.com/platform-staging/?a=summit2026
 *
 * **?a= 形态永久保留**。已印出去的海报、推文、工单里的链接都是它，任何一次
 * 「统一改成路径式」都会让那些物料当场失效。
 *
 * 依赖 window.__SITE__（site-config.js）：base / api / orgSuffix。
 */
(function () {
  "use strict";

  function cfg() { return window.__SITE__ || {}; }

  function orgSuffix() {
    return String(cfg().orgSuffix || "").toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
  }

  // 当前是不是机构托管子域。orgSuffix 为空（本地开发、未配泛解析）一律 false。
  function onOrgHost() {
    var suf = orgSuffix();
    var h = String(location.hostname || "").toLowerCase();
    if (!suf || !h) return false;
    return h === suf || h.slice(-(suf.length + 1)) === "." + suf;
  }

  // 一级路径段里不能当活动码的：静态目录、后台入口、平台前缀。
  // 与 nginx 的 location 一一对应，加新目录时这里要同步，否则
  // `<子域>/新目录` 会被当成活动短码去查库（查不到就 404，看着像站点坏了）。
  var RESERVED = {
    admin: 1, api: 1, core: 1, flows: 1, js: 1, img: 1, audio: 1,
    media: 1, uploads: 1, p: 1, index: 1, "site-config.js": 1, "actlink.js": 1
  };

  // 只做**形态初筛**，刻意比后端新建校验（最短 5 位）宽松：
  // 历史 4 位老码（如 demo）仍要能在路径里被认出来，否则一次改规则
  // 就让老活动在机构子域下打不开。真伪由后端查库决定，多认一个不存在的码
  // 只是多一次 404，少认一个存在的码是活动打不开。
  var CODE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/i;

  // 机构子域下从路径取活动码：/<短码> → 短码。其余一律空串。
  function pathCode() {
    if (!onOrgHost()) return "";
    var seg = String(location.pathname || "").replace(/^\/+/, "").split("/")[0];
    if (!seg) return "";
    if (RESERVED[seg.toLowerCase()]) return "";
    if (!CODE_RE.test(seg)) return "";
    return seg.toLowerCase();
  }

  // 站点基址（拼链接用），与各端 siteUrl 的原口径一致：
  //   有 __SITE__.base 用它；否则按当前目录推导（后台在 /admin/ 下要先退一级）。
  function siteBase() {
    var c = cfg();
    if (c.base) return String(c.base).replace(/\/+$/, "") + "/";
    var dir = String(location.pathname || "/").replace(/[^\/]*$/, "");
    dir = dir.replace(/admin\/$/, "");
    if (!dir || dir === "/") dir = "/";
    return location.origin + dir;
  }

  /* 拼一个活动链接。
   *   code   活动短码；空串＝不指定活动（机构首页、演示入口）
   *   query  额外参数串，不带 ?，如 "from=material"；可空
   * 返回不带 hash 的地址，调用方按需再补 "#/intro" 这类路由。
   */
  function url(code, query) {
    var q = String(query || "").replace(/^[?&]+/, "");
    var c = String(code || "").trim();
    if (onOrgHost() && c) {
      return location.origin + "/" + encodeURIComponent(c) + (q ? "?" + q : "");
    }
    var qs = c ? "?a=" + encodeURIComponent(c) : "";
    if (q) qs = (qs ? qs + "&" : "?") + q;
    return siteBase() + qs;
  }

  window.__ACTLINK = {
    onOrgHost: onOrgHost,
    orgSuffix: orgSuffix,
    pathCode: pathCode,
    siteBase: siteBase,
    url: url
  };
})();
