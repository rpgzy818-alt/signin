/* 站点配置 · 全站唯一的环境差异出口（平台化 P4-a，2026-11-19）
 *
 * 为什么要有这个文件：
 *   改造前「我是哪个站点」是靠 location.pathname 猜的（页面在 /meeting/ 就拼 /meeting/api，
 *   在 /platform-staging/ 就拼 /platform-staging/api，各处兜底还各不相同）。
 *   一旦绑独立域名（如 https://hd.xxx.com/ 指向站点目录），路径变成 "/"，
 *   猜出来的 API 前缀和分享链接全部指错——而错的地方恰是物料码、二维码这些
 *   「发出去就收不回」的场景，上线当天才发现就来不及了。
 *
 * 怎么用：
 *   部署时由 scripts/deploy.sh 按环境写入实际值（服务器上生成，不从本地传，
 *   免得把 staging 的地址带到 prod）。本地开发保持空值，各端自动回落到
 *   「按目录推导」的老逻辑，开发体验不变。
 *
 * 字段：
 *   env   环境标识：staging / prod / 空。空 = 不打测试环境角标。
 *   base  页面基址，末尾带 /。拼分享链接、物料二维码、核销绑定链接都用它。
 *         例：https://your-site.example.com/platform-staging/
 *         例：https://hd.example.com/            （独立域名指向站点根）
 *   api   接口基址，末尾不带 /。例：/platform-staging/api、/api
 *   orgSuffix 机构托管子域的父域（如 demo.example.com）。
 *         前端据此判断「我在机构子域上」：是则活动链接走路径式
 *         <子域>/<短码>，否则走 ?a=<短码>。空＝该环境不支持托管子域。
 *         必须与后端 config.ORG_DOMAIN_SUFFIX 同值，否则前端以为是机构子域、
 *         后端认不出来，访客会落默认活动。
 *
 * 约定：任何一处需要「本站绝对地址」都读这里，不要在业务代码里再写
 *       "platform-staging" / "/meeting/" 这类字面量。
 */
window.__SITE__ = window.__SITE__ || {
  env: "",
  base: "",
  api: "",
  orgSuffix: ""
};
