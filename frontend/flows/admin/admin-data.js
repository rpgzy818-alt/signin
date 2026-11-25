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
