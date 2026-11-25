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