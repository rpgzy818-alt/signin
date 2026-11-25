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
