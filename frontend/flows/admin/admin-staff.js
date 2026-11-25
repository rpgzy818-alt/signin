  function loadAdminStaff() {
    if (!ADMIN_TOKEN) return;
    api("/admin/staff?token=" + encodeURIComponent(ADMIN_TOKEN)).then(function (res) {
      var rows = (res.body && res.body.rows) || [], box = $("#staff-rows");
      if (!box) return;
      box.innerHTML = rows.map(function (r) {
        var ops = '<button class="reg-btn" data-staff-act="ticket" data-id="' + r.id + '">绑定码</button> ' +
          '<button class="reg-btn" data-staff-act="toggle" data-id="' + r.id + '" data-on="' + (r.enabled ? 1 : 0) + '">' + (r.enabled ? "停用" : "启用") + "</button> " +
          '<button class="reg-btn" data-staff-act="reset" data-id="' + r.id + '">重置凭证</button> ' +
          '<button class="reg-btn reg-btn-danger" data-staff-act="unbind" data-id="' + r.id + '">解绑</button>';
        // 删除只在停用后出现：运行中的人直接删掉，核销现场会突然少人
        if (!r.enabled) {
          ops += ' <button class="reg-btn reg-btn-danger" data-staff-act="del" data-id="' + r.id +
            '" data-name="' + esc(r.username) + '">删除</button>';
        }
        return "<tr><td>" + esc(r.username) + "</td>" +
          '<td class="td-mono staff-token">' + esc(r.token) + "</td>" +
          "<td>" + (r.openid ? "已绑定" : "未绑定") + "</td>" +
          "<td>" + (r.enabled ? "启用" : "停用") + "</td>" +
          "<td>" + ops + "</td></tr>";
      }).join("");
      var cell = box;
      cell.onclick = function (e) {
        var b = e.target && e.target.closest ? e.target.closest("[data-staff-act]") : null;
        if (!b) return;
        var id = parseInt(b.getAttribute("data-id"), 10), act = b.getAttribute("data-staff-act"),
            payload = { token: ADMIN_TOKEN, id: id };
        if (act === "toggle") payload.enabled = b.getAttribute("data-on") !== "1";
        if (act === "reset") payload.reset_token = true;
        if (act === "unbind") payload.unbind = true;
        if (act === "del") {
          var nm = b.getAttribute("data-name") || "";
          askConfirm({
            title: "删除现场核销人员",
            text: "确定删除「" + nm + "」？\n" +
              "· 核销凭证立即失效，该人员不能再扫码核销\n" +
              "· 微信绑定解除，绑定码一并作废\n" +
              "· 历史核销流水保留，操作人姓名仍可追溯",
            okText: "确认删除"
          }).then(function (yes) {
            if (!yes) return;
            postJ("/admin/staff/delete", payload).then(function (res) {
              if (res.body && res.body.ok) { toast("已删除 " + nm); loadAdminStaff(); }
              else toast((res.body && res.body.detail) || "删除失败");
            }).catch(function () { toast("网络异常，未执行"); });
          });
          return;
        }
        if (act === "ticket") {
          postJ("/admin/staff/ticket", payload).then(function (r) {
            var t = r.body && r.body.ticket; if (!t) return;
            // 绑定页是参与者端路由（view-staff-bind），必须回站点根，不能用后台自己的
            // location.pathname —— 那会拼成 /admin/#/staff-bind，后台没有这条路由。
            var url = siteUrl("#/staff-bind?ticket=" + encodeURIComponent(t));
            var qr = $("#staff-bind-qr"); if (qr) qr.innerHTML = qrSvg(url, 6, 12);
            var p = $("#staff-bind-panel"); if (p) p.style.display = "block";
            var lk = $("#staff-bind-link"); if (lk) lk.textContent = url;
          });
          return;
        }
        postJ("/admin/staff/update", payload).then(function () { loadAdminStaff(); });
      };
    });
  }
  function bindAdminStaff() {
    var f = $("#staff-form"); if (!f) return;
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("#staff-msg");
      postJ("/admin/staff", { token: ADMIN_TOKEN, username: f.username.value.trim() })
        .then(function (res) {
          if (msg) msg.textContent = (res.body && res.body.ok)
            ? "已创建，专属核销凭证见下表" : ((res.body && res.body.detail) || "创建失败");
          if (res.body && res.body.ok) { f.reset(); loadAdminStaff(); }
        });
    });
  }

  // ---- 启动 ----