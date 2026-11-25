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