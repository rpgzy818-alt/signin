/* 动态表单渲染器（P3-b）
 *
 * 报名页原本把 11 个字段名写死在四处：进度条、草稿、编辑回填、两步提交校验。
 * 运营想加一个字段就要改五处代码，于是「字段可配」这件事运营根本用不上。
 * 这里把「schema → DOM」和「DOM → 值」两个方向收成一个模块，signup.js 从此
 * 不再出现任何具体字段名。
 *
 * ## 值存在哪
 *
 * 每个字段在 DOM 里都有一个 `name=<key>` 的 input：
 *   · 文本 / 数字 / 邮箱：真实输入框
 *   · 选择类（下拉、分段、网格）：hidden input，点按钮组时把值写进去
 * 多选统一以「、」连接存单值（与后端 form.py 的口径一致，导出到 CSV 不用转义）。
 *
 * 这样 `form.elements` 依旧可用，草稿/回填/提交三处都能统一遍历，
 * 不需要再为某个字段名单独写一行。
 *
 * ## 与后端的分工
 *
 * 这里只做「让用户少犯错」的前端校验，最终校验在 backend/form.py。
 * 提示文案按 schema 的 label 拼，不硬编码「请填写姓名」——改了标签文案要跟着变。
 *
 * ## display 约定（决定视觉形态，不影响数据）
 *
 *   pick   按钮 + 底部选项弹层（下拉、年月）
 *   seg    是 / 否 两段式（标题在框外）
 *   grid   纯按钮网格，无标题（如留学国家）
 *   gridt  按钮网格 + 标题行 + 已选计数（如意向方向）
 */

var FR_SEP = "、";
var FR_FIELDS = [];          // 当前活动生效的字段定义，openPick 等处复用

function frSetFields(fields) { FR_FIELDS = fields || []; }

function frByName(key) {
  for (var i = 0; i < FR_FIELDS.length; i++) {
    if (FR_FIELDS[i].key === key) return FR_FIELDS[i];
  }
  return null;
}

function frEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* 展示形态：schema 没写 display 时按类型给默认值 */
function frDisplay(f) {
  if (f.display) return f.display;
  if (f.type === "select") return "pick";
  if (f.type === "date") return "pick";
  if (f.type === "radio") return "seg";
  if (f.type === "checkbox") return (f.options || []).length > 12 ? "grid" : "grid";
  return "input";
}

function frReq(f) { return f.required ? "<b>*</b>" : ""; }

/* 标题行（框外标签）：分段与带标题网格共用 */
function frHeadHtml(f, withCount) {
  var opt = f.required ? "" : '<span class="sec-opt">选填</span>';
  var cnt = withCount ? '<span class="cnt" data-cnt="' + frEsc(f.key) + '"></span>' : "";
  if (withCount) {
    return '<div class="sec-t"><b>' + frEsc(f.label) + " " + opt + "</b>" + cnt + "</div>";
  }
  return '<div class="fld-static"><span>' + frEsc(f.label) + (f.required ? '<b class="req">*</b>' : "") + "</span></div>";
}

/* ---------------- 渲染 ---------------- */

function frFieldEl(f) {
  var disp = frDisplay(f);
  var key = frEsc(f.key);
  var ph = f.placeholder ? frEsc(f.placeholder) : " ";
  var maxlen = f.max_len ? ' maxlength="' + f.max_len + '"' : "";

  // 手机号：区号与号码并排，区号固定 122px（与原版一致，避免号码被挤窄）
  if (f.type === "phone") {
    return '<div class="row2" style="grid-template-columns:122px 1fr" data-fr="' + key + '">' +
      '<label class="fld cc-fld">' +
        '<div class="cc-wrap"><span class="plus">+</span>' +
        '<input name="phone_code" id="cc-input" data-cc type="tel" inputmode="numeric" ' +
        'maxlength="5" value="86" autocomplete="off"></div>' +
        '<span class="fld-lb">国际区号<b>*</b></span>' +
      "</label>" +
      '<label class="fld float-lb">' +
        '<input name="phone" type="tel" inputmode="numeric" maxlength="11" ' +
        'placeholder=" " autocomplete="tel">' +
        '<span class="fld-lb">' + frEsc(f.label) + frReq(f) + "</span>" +
      "</label></div>";
  }

  // 按钮 + 弹层：值在 hidden 里，按钮只负责显示与唤起
  if (disp === "pick") {
    return '<label class="fld" data-fr="' + key + '">' +
      '<input type="hidden" name="' + key + '" value="">' +
      '<button type="button" class="fld-pick" data-pick="' + key + '">' +
      '<span class="fld-pick-v"></span><i class="fld-pick-arrow"></i></button>' +
      '<span class="fld-lb">' + frEsc(f.label) + frReq(f) + "</span></label>";
  }

  // 分段 / 网格：按钮组，单选写单值，多选写「、」串
  if (disp === "seg" || disp === "grid" || disp === "gridt") {
    var cls = disp === "seg" ? "seg2" : (f.type === "checkbox" || (f.options || []).length > 12 ? "grid2" : "grid4");
    var opts = f.options || [];
    var btns = opts.map(function (o, idx) {
      // wide_last：最后一项占整行（意向方向的「其他／暂未确定」就是，
      // 它是兜底选项，不该和具体方向并列）。由 schema 指定，不按字数猜。
      var isWide = (f.wide_last && idx === opts.length - 1) ? " wide" : "";
      return '<button type="button" data-v="' + frEsc(o) + '"' +
        (disp === "seg" ? "" : ' class="gcell' + isWide + '"') + ">" + frEsc(o) + "</button>";
    }).join("");
    var hint = "";
    if (f.hint || f.hint_link) {
      hint = '<p class="help-hint">' + frEsc(f.hint || "");
      if (f.hint_link) {
        hint += '<a href="#" class="help-link" data-modal="' + frEsc(f.hint_link.modal) + '">' +
          frEsc(f.hint_link.text) + "</a>";
      }
      hint += "</p>";
    }
    return '<div data-fr="' + key + '" data-kind="' + disp + '">' +
      (disp === "grid" ? "" : frHeadHtml(f, disp === "gridt" || f.type === "checkbox")) +
      '<input type="hidden" name="' + key + '" value="">' +
      '<div class="' + cls + '" data-group="' + key + '">' + btns + "</div>" +
      hint + "</div>";
  }

  // 文本类
  if (f.type === "textarea") {
    return '<label class="fld" data-fr="' + key + '">' +
      '<textarea name="' + key + '" rows="3" placeholder=" "' + maxlen + '></textarea>' +
      '<span class="fld-lb">' + frEsc(f.label) + frReq(f) + "</span></label>";
  }
  var itype = f.type === "email" ? "email" : (f.type === "number" ? "number" : "text");
  var imode = f.type === "number" ? ' inputmode="decimal"' : "";
  var auto = f.key === "name" ? ' autocomplete="name"' : "";
  return '<label class="fld' + (f.key === "name" ? " float-lb" : "") + '" data-fr="' + key + '">' +
    '<input name="' + key + '" type="' + itype + '"' + imode + ' placeholder="' + ph + '"' +
    maxlen + auto + ">" +
    '<span class="fld-lb">' + frEsc(f.label) + frReq(f) + "</span></label>";
}

/* 按 width 组装一行：两个连续的 half 字段并排（姓名+性别就是这种），
   其余整行。phone 自己就是两列结构，不参与配对。 */
function frFieldsHtml(fields) {
  var out = [], i = 0;
  while (i < fields.length) {
    var f = fields[i], g = fields[i + 1];
    if (f.width === "half" && f.type !== "phone" && g && g.width === "half" && g.type !== "phone") {
      out.push('<div class="row2">' + frFieldEl(f) + frFieldEl(g) + "</div>");
      i += 2;
    } else {
      out.push(frFieldEl(f));
      i += 1;
    }
  }
  return out.join("");
}

/* 把 steps 渲染进各自的 pane。panes 形如 {1: el, 2: el}。 */
function frRender(panes, steps) {
  var all = [];
  (steps || []).forEach(function (s) {
    var pane = panes[s.step];
    if (!pane) return;
    pane.innerHTML = frFieldsHtml(s.fields || []);
    all = all.concat(s.fields);
  });
  frSetFields(all);
  frBindGroups();
  frBindModalLinks();
  // 有上限的字段一开始就要显示「已选 0/N」，否则计数行是空的，
  // 用户点第一下才突然冒出来一段文字
  all.forEach(function (f) { if (f.max_select) frPaintGroup(f.key); });
  return all;
}

/* 说明弹层的入口：schema 指定打开哪个 modal，这里只按 id 找，不认字段名。
   全局绑一次——表单是异步渲染的，逐个绑会漏掉后渲染的那批。 */
function frBindModalLinks() {
  if (document.__frModalBound) return;
  document.__frModalBound = true;
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("[data-modal]") : null;
    if (!a) return;
    e.preventDefault();
    var m = document.getElementById(a.getAttribute("data-modal"));
    if (m) m.style.display = "flex";
  });
}

/* 按钮组点击：单选互斥、多选切换、多选有上限时拦一下 */
function frBindGroups() {
  $all("[data-group]").forEach(function (group) {
    if (group.dataset.frBound) return;
    group.dataset.frBound = "1";
    group.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button[data-v]") : null;
      if (!b) return;
      var key = group.getAttribute("data-group");
      var f = frByName(key);
      var input = group.parentNode.querySelector('input[name="' + key + '"]');
      if (!f || !input) return;
      var v = b.getAttribute("data-v");
      var max = f.max_select || (f.type === "checkbox" ? 99 : 1);

      if (f.type === "checkbox") {
        var arr = frSplit(input.value);
        var i = arr.indexOf(v);
        if (i >= 0) arr.splice(i, 1);
        else {
          if (arr.length >= max) { toast("最多选 " + max + " 项"); return; }
          arr.push(v);
        }
        input.value = arr.join(FR_SEP);
      } else {
        input.value = (input.value === v ? "" : v);
      }
      frPaintGroup(key);
      frAfterChange(key);
    });
  });
}

/* 按 hidden 的值刷新按钮的选中态与计数 */
function frPaintGroup(key) {
  var f = frByName(key);
  var wrap = document.querySelector('[data-fr="' + key + '"]');
  if (!f || !wrap) return;
  var input = wrap.querySelector('input[name="' + key + '"]');
  var cur = frSplit(input ? input.value : "");
  $all('[data-group="' + key + '"] button[data-v]').forEach(function (b) {
    b.classList.toggle("on", cur.indexOf(b.getAttribute("data-v")) >= 0);
  });
  var cnt = wrap.querySelector('[data-cnt]');
  if (cnt && f.max_select) cnt.textContent = "已选 " + cur.length + "/" + f.max_select;
}

function frAfterChange(key) {
  frApplyVisibility();
  saveDraft();
  refreshProgress();
  var f = frByName(key);
  if (f) trackEvent("field_fill", "signup", { field: key, value_len: 1 });
}

function frSplit(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s.slice();
  return String(s).split(FR_SEP).map(function (x) { return x.trim(); })
    .filter(function (x) { return !!x; });
}

/* ---------------- 取值 / 回填 ---------------- */

function frForm() { return $("#signup-form"); }

function frCollect() {
  var form = frForm(), out = {};
  if (!form) return out;
  FR_FIELDS.forEach(function (f) {
    if (f.type === "phone") {
      var p = form.elements[f.key];
      var c = form.elements["phone_code"];
      out[f.key] = p ? p.value : "";
      out["phone_code"] = c ? (c.value.replace(/\D/g, "") || "86") : "86";
      return;
    }
    var el = form.elements[f.key];
    out[f.key] = el ? el.value : "";
  });
  return out;
}

function frFill(values) {
  var form = frForm();
  if (!form || !values) return;
  FR_FIELDS.forEach(function (f) {
    var v = values[f.key];
    if (f.type === "phone") {
      if (form.elements[f.key]) form.elements[f.key].value = v || "";
      var cc = values["phone_code"] || "86";
      if (form.elements["phone_code"]) form.elements["phone_code"].value = cc;
      return;
    }
    if (v == null) v = "";
    if (form.elements[f.key]) form.elements[f.key].value = v;
  });
  FR_FIELDS.forEach(function (f) { frPaintGroup(f.key); });
  frApplyVisibility();
  syncSignupLabels();
  refreshProgress();
}

/* ---------------- 条件显示 ---------------- */

function frVisible(f, values) {
  var c = f.visible_when;
  if (!c) return true;
  var cur = values[c.key];
  var op = c.op || "eq";
  var t = c.value;
  var curArr = Array.isArray(cur) ? cur : frSplit(cur);
  if (op === "nonempty") return curArr.length > 0;
  if (op === "in") {
    var opts = Array.isArray(t) ? t : [t];
    return curArr.some(function (x) { return opts.indexOf(x) >= 0; });
  }
  var same = curArr.indexOf(t) >= 0;
  return op === "eq" ? same : !same;
}

/* 隐藏的字段：整块收起来，同时清空值。
   不清空会出现「选了是→填了国家→改回否」把美国带进库的脏数据。 */
function frApplyVisibility() {
  var vals = frCollect();
  FR_FIELDS.forEach(function (f) {
    var wrap = document.querySelector('[data-fr="' + f.key + '"]');
    if (!wrap) return;
    var vis = frVisible(f, vals);
    if (!vis && !wrap.hidden) {
      wrap.hidden = true;
      var form = frForm();
      if (f.type === "phone") {
        if (form.elements[f.key]) form.elements[f.key].value = "";
      } else if (form.elements[f.key]) {
        form.elements[f.key].value = "";
      }
      frPaintGroup(f.key);
    } else if (vis) {
      wrap.hidden = false;
    }
  });
  // 第一步出现条件字段时整页切紧凑档：多出一整块国家网格，
  // 不加 tight 会把提交按钮挤出首屏。判据是「有条件字段当前可见」，
  // 不是「有字段被隐藏」——后者在多数页面恒为真，等于永远紧凑。
  var p1 = $("#su-pane1");
  if (p1) {
    var extra = FR_FIELDS.some(function (f) {
      return f.visible_when && frVisible(f, vals);
    });
    p1.classList.toggle("tight", extra);
  }
}

/* ---------------- 进度 ---------------- */

function frProgress() {
  var vals = frCollect();
  var done = 0, total = 0;
  FR_FIELDS.forEach(function (f) {
    if (!frVisible(f, vals)) return;
    total++;
    var v = vals[f.key];
    if (f.type === "phone") v = vals["phone_code"] === "86" ? v : v;
    if (f.type === "checkbox") { if (frSplit(v).length) done++; return; }
    if (String(v == null ? "" : v).trim()) done++;
  });
  return { done: done, total: total || 1 };
}

/* ---------------- 前端校验 ---------------- */

/* 只校验指定步骤（跨步的必填由后端 missing_required 兜底），返回第一条错误。 */
function frValidate(step, values) {
  var err = null;
  FR_FIELDS.forEach(function (f) {
    if (err || (step && f.step !== step)) return;
    if (!frVisible(f, values)) return;
    var v = values[f.key];
    var empty = f.type === "checkbox" ? !frSplit(v).length : !String(v == null ? "" : v).trim();

    if (f.required && empty) {
      var verb = (f.type === "radio" || f.type === "select" || f.type === "checkbox" || f.type === "date") ? "请选择" : "请填写";
      err = { key: f.key, msg: verb + f.label };
      return;
    }
    if (empty) return;

    if (f.type === "phone") {
      var cc = values["phone_code"] || "86";
      var num = String(v).replace(/\D/g, "");
      if (cc === "86" && !/^1[3-9]\d{9}$/.test(num)) {
        err = { key: f.key, msg: "手机号格式不正确，请填写 11 位大陆手机号" };
      } else if (cc !== "86" && (num.length < 4 || num.length > 15)) {
        err = { key: f.key, msg: "请填写有效号码" };
      }
      return;
    }
    if (f.type === "text" || f.type === "textarea") {
      var s = String(v);
      if (f.min_len && s.length < f.min_len) err = { key: f.key, msg: f.label + "至少 " + f.min_len + " 字" };
      else if (f.max_len && s.length > f.max_len) err = { key: f.key, msg: f.label + "不能超过 " + f.max_len + " 字" };
      return;
    }
    if (f.type === "checkbox") {
      var n = frSplit(v).length;
      if (f.min_select && n < f.min_select) err = { key: f.key, msg: f.label + "至少选 " + f.min_select + " 项" };
      else if (f.max_select && n > f.max_select) err = { key: f.key, msg: f.label + "最多选 " + f.max_select + " 项" };
      return;
    }
    if (f.type === "date") {
      if (!/\d{4}/.test(String(v))) err = { key: f.key, msg: f.label + "格式不正确" };
      return;
    }
    if (f.type === "email") {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) err = { key: f.key, msg: f.label + "格式不正确" };
      return;
    }
  });
  return err;
}
