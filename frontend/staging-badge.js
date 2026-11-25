/* 测试环境临时标识（2026-11-11，2026-11-18 增 platform-staging）
   按访问路径判定：/meeting-staging/ 与 /platform-staging/ 都给 <html> 加 env-staging，
   样式随之生效。平台化副本挂在 /platform-staging/，原正则只认 meeting-staging，
   导致新环境前后台角标都不显示。本地预览可加 ?env=staging 强制显示。 */
(function () {
  // 判定顺序：站点配置 > URL 强制 > 路径特征。
  // 绑独立域名后路径里不再有 -staging 字样，只能靠部署时写入的 site-config.js；
  // 路径判定保留，兼容还没生成站点配置的旧环境。
  var site = window.__SITE__ || {};
  var path = location.pathname || "";
  var forced = /[?&]env=staging(?:&|$)/.test(location.search || "");
  var isStaging = forced || site.env === "staging" ||
                  /(?:^|\/)(?:meeting|platform)-staging(?:\/|$)/.test(path);
  if (!isStaging) return;

  var root = document.documentElement;
  root.classList.add("env-staging");
  root.setAttribute("data-env", "staging");

  var TAG = "【测试环境】";
  function markTitle() {
    var t = document.title || "";
    if (t.indexOf(TAG) !== 0) document.title = TAG + t;
  }
  markTitle();

  var titleEl = document.querySelector("title");
  if (titleEl && window.MutationObserver) {
    new MutationObserver(markTitle).observe(titleEl, {
      childList: true, characterData: true, subtree: true
    });
  }
  window.addEventListener("hashchange", markTitle);
})();
