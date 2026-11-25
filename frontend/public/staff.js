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

