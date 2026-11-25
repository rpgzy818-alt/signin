"""签到会（signin）后端主程序（FastAPI）。

路径前缀 /api/（Nginx 把站点子目录反代到本服务；直连时是 http://127.0.0.1:8087/api/）。

对外接口
  GET  /api/health                健康检查 + 时段闸门状态
  GET  /api/config                活动公开配置（名称、时间、场地、介绍）
  POST /api/register              报名
  GET  /api/me                    查询本人报名/签到状态
  POST /api/checkin               自助签到
  POST /api/walkin                现场补录 + 即时签到
  GET  /api/verify/lookup         核销查询（工作人员，脱敏）
  POST /api/verify/confirm        核销确认
  GET  /api/export                名单导出 CSV（管理员）
  GET  /api/admin/list            报名名单 + 分项统计（管理员）
  GET  /api/admin/logs            操作日志（管理员）
  GET  /api/admin/checkins        签到流水（管理员）
  GET  /api/admin/gate            时段闸门状态 / 调整（管理员）
  POST /api/track                 埋点

装配层只做三件事：建 app、挂中间件、注册路由。业务逻辑在 routers/ 与各内核模块里。
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

import limit
import logx
import riskword
from activity import ActivityMiddleware
from config import CORS_ORIGINS
from deps import validate  # 触发配置校验，非法即拒绝启动

from routers import admin, public, staff

logx.setup()

app = FastAPI(title="signin", version="0.1.0")

# 中间件从内到外：活动上下文 → 限流 → 日志 → CORS。
# Starlette 的 add_middleware 插到列表头部，**后加的在外层**；顺序反了会导致
# 429 响应缺 CORS 头、被限流拒绝的请求不进日志。
# 活动上下文放最内层：CORS 预检在外面就直接返回了，不必白跑一次活动解析。
app.add_middleware(ActivityMiddleware)
app.add_middleware(BaseHTTPMiddleware, dispatch=limit.middleware)
app.add_middleware(BaseHTTPMiddleware, dispatch=logx.middleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS if CORS_ORIGINS != ["*"] else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 参与者侧
app.include_router(public.router)
# 工作人员侧（核销、补录）
app.include_router(staff.router)
# 主办方后台
app.include_router(admin.router)

# 运营增强：按钮配置、批量核销与现场导出、议程、附件、物料
from routers import agenda, attachment, cta, material, p8

app.include_router(cta.router)
app.include_router(p8.router)
app.include_router(agenda.router)
app.include_router(attachment.router)
app.include_router(material.router)


# 风控命中 → 400。集中在这里转，各写接口只管调 riskword.guard()：
# 逐个 try/except 迟早漏一处，漏的那处就是 500，且前端只会说"保存失败"。
@app.exception_handler(riskword.Blocked)
async def _riskword_blocked(request, exc: riskword.Blocked):
    return JSONResponse(status_code=400,
                        content={"ok": False, "detail": exc.message})


# ---- 静态托管（可选）----
# 配了 FRONTEND_DIR 就让本服务一并把前端发出去，单容器即可完整运行；
# 不配则只提供接口，静态文件交给 Nginx 或任何 CDN。
# 必须放在最后：mount("/") 会兜住所有未命中路径，注册早了接口全被它吞掉。
import os as _os

_FRONTEND_DIR = _os.getenv("FRONTEND_DIR", "")
if _FRONTEND_DIR and _os.path.isdir(_FRONTEND_DIR):
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_FRONTEND_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8087)
