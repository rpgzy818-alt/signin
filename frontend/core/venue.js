  function mapUris() {
    var q = encodeURIComponent(EVT.poiName);
    var g = EVT.gcj, b = EVT.bd09, w = EVT.wgs84;
    return {
      // 高德 to = 经度,纬度,名称（GCJ-02）
      amap: "https://uri.amap.com/navigation?to=" + g.lng + "," + g.lat + "," + q +
            "&mode=car&policy=1&src=h5&coordinate=gaode&callnative=1",
      // 腾讯 tocoord = 纬度,经度（GCJ-02，顺序与高德相反）
      qq:   "https://apis.map.qq.com/uri/v1/routeplan?type=drive&to=" + q +
            "&tocoord=" + g.lat + "," + g.lng + "&referer=h5",
      // 百度 destination = 纬度,经度，必须声明 bd09ll
      baidu: "https://api.map.baidu.com/direction?destination=latlng:" + b.lat + "," + b.lng +
             "|name:" + q + "&mode=driving&coord_type=bd09ll&output=html&src=h5",
      // Apple / geo 用 WGS-84，顺序 纬度,经度
      apple: "https://maps.apple.com/?daddr=" + w.lat + "," + w.lng + "&dirflg=d&q=" + q,
      geo:   "geo:" + w.lat + "," + w.lng + "?q=" + w.lat + "," + w.lng + "(" + q + ")"
    };
  }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function openWxLocation() {
    // wx.openLocation 依赖 wx.config 注入签名；未就绪返回 false，改走 URI 链路
    if (!window.wx || !window.wx.openLocation) return false;
    try {
      window.wx.openLocation({
        latitude: EVT.gcj.lat, longitude: EVT.gcj.lng,   // GCJ-02，顺序 纬度,经度
        name: EVT.poiName, address: EVT.poiAddress, scale: 18
      });
      return true;
    } catch (e) { return false; }
  }
  // 预留：直接唤起高德（当前导航按钮改为拉起选择面板，此函数备用）
  function openNav() {
    var u = mapUris();
    // 主链路＝高德（callnative=1 由高德 H5 唤起 App）；微信内也先走高德，不用微信内置地图顶掉它
    var left = false;
    function onVis() { if (document.hidden) left = true; }
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", function () { left = true; }, { once: true });
    location.href = u.amap;
    // 3 秒兜底：仅当页面仍可见（高德未拉起）才换下一条，避免已进高德又被二次跳转
    setTimeout(function () {
      document.removeEventListener("visibilitychange", onVis);
      if (left || document.hidden) return;
      if (isWeChat() && EVT.wxSdkReady && openWxLocation()) return;  // 微信内先试原生地图
      if (isWeChat()) location.href = u.qq;        // 再退腾讯（微信内不支持 geo）
      else if (isIOS()) location.href = u.apple;   // iOS 直接 Apple 地图
      else location.href = u.geo;                  // 安卓系统地图
    }, 3000);
  }
  function copyAddress() {
    var text = EVT.address + "，" + EVT.poiAddress;
    function done() { toast("地址已复制，可粘贴到地图 App"); }
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove(); done();
      } catch (e) { toast("复制失败，请长按地址手动复制"); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
  }
  function openMoreMaps() {
    // 微信内点 https 地图链接只会开网页版，还得跳应用市场，地址也带不过去；
    // 唯一能直接导航的是 JSSDK 的 openLocation（打开微信内置地图，坐标用 GCJ-02）。
    if (isWeChat() && WX_SDK_OK && window.wx && wx.openLocation) {
      wx.openLocation({
        latitude: EVT.gcj.lat,
        longitude: EVT.gcj.lng,
        name: EVT.venueName,
        address: "数智北京创新中心 46 号楼展示中心",
        scale: 17
      });
      return;
    }
    var p = $("#map-panel"); if (!p) return;
    var u = mapUris();
    $all("[data-map]", p).forEach(function (a) { a.href = u[a.getAttribute("data-map")] || "#"; });
    p.style.display = "flex";
  }
  function closeMoreMaps() { var p = $("#map-panel"); if (p) p.style.display = "none"; }
  function bindVenue() {
    var ac = $("#add-cal"); if (ac) ac.addEventListener("click", addToCalendar);
    // 导航＝拉起地图选项面板，由用户选具体地图（高德排首、标推荐）
    var nb = $("#nav-btn"); if (nb) nb.addEventListener("click", openMoreMaps);
    var ca = $("#copy-addr"); if (ca) ca.addEventListener("click", function (e) { e.preventDefault(); copyAddress(); });
    var mc = $("#map-close"); if (mc) mc.addEventListener("click", closeMoreMaps);
    var mk = $("#map-mask"); if (mk) mk.addEventListener("click", closeMoreMaps);
  }

  // ---- 首页上滑进报名（手势 + 滚轮 + 点击提示三路兜底，任一可用即可）----