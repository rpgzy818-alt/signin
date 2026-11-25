  // ---- 后台 ----
  var ADMIN_TOKEN = null;
  var ACCOUNT = null;
  // 「完整信息」开关：开着才向接口要 ?full=1，姓名与手机号一起出原值；切页自动复位
  var SHOW_FULL_INFO = false;
  var WM_TIMER = null;         // 水印每分钟刷新时间戳
  var HIDE_TIMER = null;       // 页面隐藏计时：超时自动收回完整信息
  var SESSION_KEY = "adm_session";
  var CUR_TAB = "overview";
  var AD_TABS = {
    orghome: ["机构总台", "本机构的活动、配额、短信余量与到期时间"],
    orginfo: ["机构信息", "机构名称、域名与联系人；版本与续费在这里"],
    overview: ["工作台", "活动整体情况与现场签到控制"],
    review: ["活动复盘", "办完一屏交差：报名到场漏斗、来源归因、时段分布、礼品与异常"],
    stats: ["数据统计", "访问 UV/PV、渠道来源、设备分布与转化漏斗"],
    roster: ["报名名单", "全部报名记录、签到状态与来源渠道"],
    cards: ["领卡行为", "点击领取礼物 / 点击开卡 的行为留痕"],
    checkins: ["签到流水", "现场签到记录，按时间倒序"],
    agenda: ["日程议程", "活动日程与分时段议程，按排序展示在详情页"],
    speakers: ["嘉宾讲师", "专业版项：嘉宾姓名、职务与简介，按排序展示在详情页"],
    materials: ["推广二维码", "通用报名码 / 渠道码 / 通用核销码，扫码与报名归因"],
    bgm: ["背景音乐", "用户端背景音乐的开关与曲目更换"],
    logs: ["操作审计", "管理与导出动作留痕（仅机构管理员可见）"],
    accounts: ["账号管理", "本机构账号、角色与活动授权（仅机构负责人可见）"],
    staff: ["现场工作人员", "可辅助签到人员、微信绑定与专属核销凭证"],
    orgs: ["机构管理", "平台超管专用：开机构、定版本与配额、功能位、跨机构检索"],
    activities: ["活动管理", "切换活动、发布上线与回草稿（草稿期的数据仅用于测试）"],
    actperm: ["活动能力与成员", "本活动的能力开关与成员授权（按活动生效，机构管理员可改）"],
    riskwords: ["平台风控", "全平台禁用词库，报名文本命中即拒（仅平台超管可见）"],
    form: ["表单字段", "本活动的报名表结构；已收的报名永远按它当时那一版解释"]
  };
  // 顶部「显示完整信息 / 导出」只在三张数据表页出现，并各自控制本页
  var TAB_OPS = {
    roster: { exportPath: "/export", exportText: "导出名单 CSV" },
    cards: { exportPath: "/admin/card-actions/export", exportText: "导出行为记录" },
    checkins: { exportPath: "/admin/checkins/export", exportText: "导出签到流水" }
  };
  // 分页状态：后台各表独立，默认 20 条/页，可切 50/100
  var PG = {
    roster: { page: 1, size: 20, total: 0, q: "" },
    logs: { page: 1, size: 20, total: 0 },
    checkins: { page: 1, size: 20, total: 0 },
    cards: { page: 1, size: 20, total: 0 }
  };

  // 机构档位：后端 /admin/me 下发 org_role，前端不自己认角色字面量
  var ORG_MANAGER_ROLES = ["platform_admin", "org_owner", "org_admin"];
  var ORG_OWNER_ROLES = ["platform_admin", "org_owner"];
  var ORG_ROLE_LABEL = { platform_admin: "平台超管", org_owner: "机构负责人", org_admin: "机构管理员", org_user: "普通用户" };
  // 机构管理员档：能管本机构的活动/配置/数据。
  // C 批把判据从「role 字面量等于 admin」换成后端下发的 org_role——
  // 四档角色只在一处归一（orgctx），前端再写一份字面量判断就是两个口径。
  function isAdmin() { return !!(ACCOUNT && ORG_MANAGER_ROLES.indexOf(ACCOUNT.org_role) >= 0); }
  // 机构负责人档：账号管理、机构信息这类只有一家之主能改的事
  function isOrgOwner() { return !!(ACCOUNT && ORG_OWNER_ROLES.indexOf(ACCOUNT.org_role) >= 0); }
  // 平台超管：只有这一个账号能开机构、改版本、看跨机构检索（判据在后端 orgctx）
  function isPlatformAdmin() { return !!(ACCOUNT && ACCOUNT.is_platform_admin); }
  function canFullPhone() { return !!(ACCOUNT && ACCOUNT.can_full_phone); }
  function canExport() { return !!(ACCOUNT && ACCOUNT.can_export); }

  function saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: ADMIN_TOKEN, account: ACCOUNT }));
    } catch (e) {}
  }
  function readSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }

  // 后台请求统一带 token；会话过期（401）直接退回登录页，避免页面停在空白
  function apiAdmin(path, opts) {
    var sep = path.indexOf("?") >= 0 ? "&" : "?";
    return api(path + sep + "token=" + encodeURIComponent(ADMIN_TOKEN), opts).then(function (res) {
      if (res.status === 401) kickToLogin();
      return res;
    });
  }
  // 带 body 的写操作：token 仍走 query（后端签名是 token 作查询参数 + Pydantic body），
  // 所以不能沿用「token 塞进 body」那套旧写法
  function sendAdmin(method, path, body) {
    return apiAdmin(path, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  }
  function kickToLogin() {
    ADMIN_TOKEN = null; ACCOUNT = null; clearSession();
    var p = $("#admin-panel"), l = $("#admin-login-wrap");
    if (p) p.style.display = "none";
    if (l) l.style.display = "block";
    var m = $("#admin-msg"); if (m) m.textContent = "登录已失效，请重新登录";
    var ops = $("#ad-top-ops"); if (ops) ops.style.display = "none";
    stopWatermark();
  }

  // 权限落到界面：角色只从后端 org_role 读，不认字面量
  function applyPerms() {
    $all(".admin-only").forEach(function (el) { el.style.display = isAdmin() ? "" : "none"; });
    // 机构负责人专属（账号管理、机构信息写）：方案的口径是「不渲染」而不是
    // 灰掉——点一下弹"没权限"比根本不给入口更让人困惑。
    $all(".owner-only").forEach(function (el) { el.style.display = isOrgOwner() ? "" : "none"; });
    // 机构管理是平台超管专属：机构管理员即便是最高档也不该看到这个入口
    $all(".platform-only").forEach(function (el) { el.style.display = isPlatformAdmin() ? "" : "none"; });
    var pt = $("#phone-toggle"), ex = $("#admin-export");
    if (pt) pt.style.display = canFullPhone() ? "" : "none";
    if (ex) ex.style.display = canExport() ? "" : "none";
    // 数据统计页的两个导出按钮走同一套 can_export 权限，后端也会再校验一次
    var exSum = $("#ds-exp-summary"), exEvt = $("#ds-exp-events");
    if (exSum) exSum.style.display = canExport() ? "" : "none";
    if (exEvt) exEvt.style.display = canExport() ? "" : "none";
    if (!canFullPhone()) {
      SHOW_FULL_INFO = false;
      if (pt) pt.textContent = "显示完整信息";
    }
    var who = $("#ad-who");
    if (who && ACCOUNT) {
      // 谁 · 什么档 · 哪个机构：多机构之后，「我是谁的人」比「我叫什么」更该先看见
      var bits = [ACCOUNT.username, ORG_ROLE_LABEL[ACCOUNT.org_role] || ACCOUNT.org_role || "普通用户"];
      if (ACCOUNT.org_name) bits.splice(1, 0, ACCOUNT.org_name);
      who.textContent = bits.join(" · ");
    }
  }

  // ---- 账号水印：全屏平铺「账号 + 时间」，截图可溯源到人 ----
  function wmStamp() {
    var d = new Date(), p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }