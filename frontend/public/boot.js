  function boot() {
    var start = function () {
      render();                        // 先落地，不等接口，避免白屏
      // 机构入口页（RD-13）：?org=<机构短码> 是明确指名，直接进门面、不进活动流。
      // 带了 ?a=（分享链接 / 物料码）时以活动为准——机构首页只是门面，
      // 不该把一个已经指名要报名某场活动的人拦在门口多点一次。
      var orgCode = getParam("org");
      if (orgCode && !getParam("a")) {
        if (typeof renderOrgHome === "function") loadOrgPortal(orgCode).then(renderOrgHome).catch(showOrgMiss);
        else showOrgMiss && showOrgMiss();
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
        // 单机构版没有机构门面页：后端不会返回 org_home，这里再兜一道，
        // 免得万一返回了却因渲染函数不存在而抛异常，把后面的路由监听一起带停。
        if (CONFIG.mode === "org_home" && typeof renderOrgHome === "function") { renderOrgHome(CONFIG); return; }
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
    bindQrModal();
    // 自助查询页不在本版功能内；函数不存在就跳过，不要让它把后面的绑定全挡掉
    if (typeof bindQueryPage === "function") bindQueryPage();
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
