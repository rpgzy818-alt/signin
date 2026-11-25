  // ============ P8-c 批量核销 / 最小数据集导出 ============
  function openBatchModal(id, name) {
    var old = $("#batch-modal");
    if (old) old.parentNode.removeChild(old);
    var wrap = document.createElement("div");
    wrap.id = "batch-modal";
    wrap.className = "gm-mask";
    wrap.innerHTML =
      '<div class="gm-box batch-box">' +
        '<h3>批量核销 · ' + esc(name) + '</h3>' +
        '<p class="gm-tip">每行一个 8 位凭证码。重复的码按「已核销」返回，不会出错；单次最多 200 条。</p>' +
        '<textarea id="batch-codes" rows="10" placeholder="A1B2C3D4\nE5F6G7H8" maxlength="2400"></textarea>' +
        '<div id="batch-result" class="gm-tip"></div>' +
        '<div class="gm-ops">' +
          '<button type="button" class="btn-ghost" id="batch-export">下载最小数据集</button>' +
          '<button type="button" class="btn-ghost" id="batch-cancel">关闭</button>' +
          '<button type="button" class="btn-primary" id="batch-go">确认核销</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    var close = function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); };
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    $("#batch-cancel").onclick = close;

    $("#batch-go").onclick = function () {
      var raw = $("#batch-codes").value.split(/[\s,，]+/).filter(Boolean);
      if (!raw.length) { toast("请先粘贴凭证码"); return; }
      var btn = this; btn.disabled = true;
      var out = $("#batch-result"); out.textContent = "核销中…";
      sendAdmin("POST", "/admin/activity/" + id + "/batch-verify", { codes: raw }).then(function (res) {
        btn.disabled = false;
        var b = res.body || {};
        if (!res.ok || !b.ok) { out.textContent = (b.detail || "核销失败"); return; }
        var s = b.summary || {};
        out.textContent = "成功 " + (s.checked || 0) + " 条 · 已核销 " + (s.already || 0) +
          " 条 · 未找到 " + (s.not_found || 0) + " 条" + (s.error ? " · 失败 " + s.error + " 条" : "");
        var bad = (b.rows || []).filter(function (r) {
          return r.status === "not_found" || r.status === "error";
        }).map(function (r) { return r.code; });
        if (bad.length) out.textContent += "\n未找到/失败：" + bad.slice(0, 20).join(" ") +
          (bad.length > 20 ? " 等 " + bad.length + " 条" : "");
        toast("批量核销完成");
      }).catch(function () { btn.disabled = false; out.textContent = "网络异常，请重试"; });
    };

    // 最小数据集：脱敏 CSV，后端记审计
    $("#batch-export").onclick = function () {
      var sep = "?";
      var u = API + "/admin/activity/" + id + "/minimal-export" +
              sep + "token=" + encodeURIComponent(ADMIN_TOKEN);
      window.open(u, "_blank");
    };
  }
