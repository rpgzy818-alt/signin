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
