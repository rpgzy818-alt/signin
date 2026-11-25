  // 后台专属的二维码 / 物料链接工具。
  // 拆分前这些函数散在参与者端 core/material.js 与 flows/signup/signup.js 里，
  // 后台单产物没引入 → 物料码不渲染、绑定码不显示。后台只需要的这几支单独抽出，
  // 不把 material.js 整份拖进来（其余日历/领卡/地图函数后台用不到）。

  function hasQr() { return typeof window.qrcode === "function"; }

  // ---- 自绘下拉：干掉原生 <select> 点开后菜单弹层飘走的漂移 ----
  // 原生 select 的外观能用 appearance:none 自绘，但点开后的选项菜单是浏览器系统层渲染的，
  // 位置不受 CSS 控制（实测 Chrome/Safari 都会把菜单弹到远离控件处，见 2026-11-18 录屏）。
  // 这里保留原 select 元素（值读取处仍用 sel.value），只是隐藏它、加一层自绘控件：
  // 点显示框 → 弹出绝对定位的选项列表（相对包裹层，不受 .modal-box 的 overflow 裁剪）→
  // 选中后同步 select.value。这样控件外观与选项定位全由我们自己掌控。
  //
  // 【必须用 mousedown 而不是 click】真实鼠标点击时，mousedown 会让浏览器把焦点移到
  // 带 tabindex 的控件并可能触发滚动，导致 mouseup 后 click 的 target 已漂移到包裹层外，
  // 点击事件根本到不了控件——表现为"点一下下拉没反应/闪一下就关"。mousedown 是点击链里
  // 最早且最可靠的事件，preventDefault 还能顺带阻止焦点滚动，故打开/选择/关闭全部改由它驱动。
  function enhanceSelect(sel) {
    if (!sel || sel.dataset.enhanced) return;
    sel.dataset.enhanced = "1";
    var wrap = document.createElement("div");
    wrap.className = "esel";
    var view = document.createElement("div");
    view.className = "esel-view";
    view.setAttribute("tabindex", "0");
    view.setAttribute("role", "combobox");
    var list = document.createElement("div");
    list.className = "esel-list";
    var arrow = document.createElement("span");
    arrow.className = "esel-arrow";
    arrow.innerHTML = '<svg width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="#5b7180" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var textNode = document.createElement("span");
    textNode.className = "esel-val";
    function currentLabel() {
      var o = sel.options[sel.selectedIndex];
      return o ? o.textContent : "";
    }
    textNode.textContent = currentLabel();
    view.appendChild(textNode);
    view.appendChild(arrow);
    wrap.appendChild(view);
    wrap.appendChild(list);

    function buildList() {
      list.innerHTML = "";
      Array.prototype.forEach.call(sel.options, function (o) {
        var it = document.createElement("div");
        it.className = "esel-item" + (o.selected ? " is-sel" : "");
        it.textContent = o.textContent;
        it.setAttribute("data-val", o.value);
        // 选择同样走 mousedown：真实鼠标下 click 的目标会漂移，点选项会落空。
        it.addEventListener("mousedown", function (e) {
          e.preventDefault();
          e.stopPropagation();
          sel.value = o.value;
          if (sel.onchange) sel.onchange();
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          textNode.textContent = o.textContent;
          close();
        });
        list.appendChild(it);
      });
    }
    function open() {
      buildList();
      wrap.classList.add("open");
      view.setAttribute("aria-expanded", "true");
      // 打开时把选中项滚动进可视区
      var cur = list.querySelector(".is-sel");
      if (cur) list.scrollTop = cur.offsetTop - list.offsetTop;
    }
    function close() {
      wrap.classList.remove("open");
      view.setAttribute("aria-expanded", "false");
    }
    view.addEventListener("mousedown", function (e) {
      e.preventDefault();
      if (wrap.classList.contains("open")) close(); else open();
    });
    view.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        if (wrap.classList.contains("open")) close(); else open();
      }
      if (e.key === "Escape") close();
    });
    // 点外部关闭也用 mousedown（click 会因 target 漂移而漏判）。
    document.addEventListener("mousedown", function (e) {
      if (!wrap.contains(e.target)) close();
    });

    sel.style.display = "none";
    sel.parentNode.insertBefore(wrap, sel);
  }

  // 物料二维码指向参与者端，不是后台自己。
  // 后台挂在站点 /admin/ 子目录下，要退到站点根再拼哈希路由；
  // 站点根优先取站点配置（site-config.js），绑独立域名后路径推不出来，缺失才按目录退一级。
  function siteUrl(hashPath) {
    var c = window.__SITE__ || {};
    var hp = String(hashPath || "");
    var base = "";
    if (c.base) {
      base = String(c.base).replace(/\/+$/, "") + "/";
    } else {
      var dir = location.pathname.replace(/[^\/]*$/, "");     // /platform-staging/admin/
      dir = dir.replace(/admin\/$/, "");                       // → /platform-staging/
      if (!dir || dir === "/") dir = "/platform-staging/";
      base = location.origin + dir;
    }
    return base + hp.replace(/^\/+/, "");
  }

  function qrSvg(text, cell, margin) {
    var q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: cell || 6, margin: margin || 12 });
  }

  function saveBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  // ---- 两张固定码：通用报名码 / 通用核销码 ----
  // 拆分前在 core/material.js，后台产物没引入该文件 → 两个码面板空白。
  // 术语与后台「推广二维码」页一致：通用码（不区分渠道）+ 渠道码（每个物料一个）。
  // 下载文件名也走这里，运营拿到手一眼知道是哪张。
  // 这两支连同 loadMaterials/bindMaterials 一起补进后台共享工具。
  // query 与 hash 分开拼：query 段必须带活动上下文（多机构下不带就落默认活动），
  // hash 段固定收尾。链接形态由 core/actlink.js 统一决定——机构子域走
  // /<短码>，主站走 ?a=<短码>，这里不重复判断。
  var MATS = {
    signup:  { path: "#/intro",   query: "from=material", name: "通用报名码" },
    checkin: { path: "#/checkin", query: "from=material", name: "通用核销码" }
  };
  function matUrl(kind) {
    var m = MATS[kind] || MATS.signup;
    return window.__ACTLINK.url(currentActivityCode(), m.query) + m.path;
  }

  function loadMaterials() {
    if (!hasQr()) {
      $all("#mat-qr-signup, #mat-qr-checkin").forEach(function (b) {
        b.innerHTML = '<p class="muted">二维码组件未加载</p>';
      });
      return;
    }
    Object.keys(MATS).forEach(function (kind) {
      var u = matUrl(kind);
      var box = $("#mat-qr-" + kind), urlBox = $("#mat-url-" + kind);
      if (urlBox) urlBox.textContent = u;
      if (box) box.innerHTML = qrSvg(u, 8, 20);
    });
  }
  function downloadQr(matKey, fmt) {
    var u = matUrl(matKey), label = (MATS[matKey] || MATS.signup).name;
    downloadQrUrl(u, label, fmt);
  }
  function bindMaterials() {
    $all("[data-mat-dl]").forEach(function (b) {
      b.addEventListener("click", function () {
        downloadQr(b.getAttribute("data-mat-dl"), b.getAttribute("data-mat-kind") || "png");
      });
    });
    $all("[data-mat-copy]").forEach(function (b) {
      b.addEventListener("click", function () {
        var u = matUrl(b.getAttribute("data-mat-copy"));
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(u).then(function () { toast("链接已复制"); },
            function () { toast("复制失败，请手动选中链接"); });
          return;
        }
        var ta = document.createElement("textarea");
        ta.value = u; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); toast("链接已复制"); }
        catch (e) { toast("复制失败，请手动选中链接"); }
        ta.remove();
      });
    });
  }

  // 任意链接出码：投放物料码（PNG/SVG 下载）
  function downloadQrUrl(u, label, fmt) {
    if (!hasQr()) { toast("二维码组件未加载"); return; }
    var q = qrcode(0, "M");
    q.addData(u);
    q.make();
    var svg = q.createSvgTag({ cellSize: 12, margin: 24 });
    if (fmt === "svg") {
      saveBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), label + ".svg");
      return;
    }
    var img = new Image();
    img.onload = function () {
      var size = 1000;
      var cv = document.createElement("canvas");
      cv.width = cv.height = size;
      var cx = cv.getContext("2d");
      cx.fillStyle = "#ffffff";
      cx.fillRect(0, 0, size, size);
      cx.drawImage(img, 0, 0, size, size);
      cv.toBlob(function (b) { saveBlob(b, label + ".png"); }, "image/png");
    };
    img.onerror = function () { toast("导出失败，请改用 SVG"); };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
