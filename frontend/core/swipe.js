  function introActive() {
    var v = $("#view-intro");
    return !!v && v.classList.contains("active");
  }
  function bindSwipe() {
    var view = $("#view-intro");
    var hint = $("#swipe-hint");
    // 提示区本身就是按钮：点它也进，不依赖手势
    if (hint) hint.addEventListener("click", function () { go("event"); });
    // 活动页 → 报名页；报名页顶部返回活动页
    var gs = $("#go-signup");
    if (gs) gs.addEventListener("click", function () {
      // 后台关掉报名（或活动已结束）时，不再放人进表单——进去填完才被拒是最差的体验
      if (CONFIG.event_ended || !CONFIG.registration_open) { go("status"); return; }
      go("signup");
    });
    var be = $("#back-event");
    if (be) be.addEventListener("click", function () { go("event"); });
    if (!view) return;
    var screenEl = view.querySelector(".intro-screen");

    var sy = 0, sx = 0, up = false, lock = false;
    function enter() {
      if (lock || !introActive()) return;
      lock = true; go("event");
      setTimeout(function () { lock = false; }, 600);   // 防抖：一次滑动只跳一次
    }
    view.addEventListener("touchstart", function (e) {
      if (!introActive() || !e.touches.length) return;
      sy = e.touches[0].clientY; sx = e.touches[0].clientX; up = false;
      if (screenEl) screenEl.classList.add("dragging");   // 拖动期间不要过渡，否则跟手发黏
    }, { passive: true });
    view.addEventListener("touchmove", function (e) {
      if (!introActive() || !e.touches.length) return;
      var dy = sy - e.touches[0].clientY;              // 向上为正
      var dx = Math.abs(sx - e.touches[0].clientX);
      if (dy > 28 && dy > dx) up = true;               // 竖向滑动且方向朝上
      // 整屏跟着手指走一小段：位移上限 46px，越推越淡。
      // 目的是「推得动」的回应感，不是真把页面拖出去。
      if (dy > 0 && dy > dx && screenEl) {
        // 缩小而不是上移：上移会在底部拽出一条边，缩小只是四边各让出几像素，
        // 露出的是同图虚化底，看起来像页面被「抬起来」。
        var k = Math.min(dy * 0.3, 34);
        screenEl.style.transform = "scale(" + (1 - k / 1500).toFixed(4) + ")";
      }
    }, { passive: true });
    view.addEventListener("touchend", function () {
      if (screenEl) {
        screenEl.classList.remove("dragging");          // 松手交给 CSS 回弹
        screenEl.style.transform = "";
        screenEl.style.opacity = "";
      }
      if (up) enter();
    }, { passive: true });
    view.addEventListener("touchcancel", function () {
      if (screenEl) {
        screenEl.classList.remove("dragging");
        screenEl.style.transform = ""; screenEl.style.opacity = "";
      }
    }, { passive: true });
    // 桌面/微信 PC 端预览：往下滚即进
    view.addEventListener("wheel", function (e) {
      if (introActive() && e.deltaY > 12) enter();
    }, { passive: true });
  }

  // ---- 签到 ----
  // 签到页只有一张卡：状态、现场节奏、下一步都渲染在同一个容器里，
  // 不再「上面一个结果盒、下面一个按钮」两块拼接（那样像两个模块硬拼在一起）。