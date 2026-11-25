# 签到会 —— 单容器镜像
# 一次构建同时包含接口与页面，`docker compose up -d` 就能完整跑起来。
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 先装依赖再拷代码：改代码不会让依赖层缓存失效，重建快很多
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt \
    && rm -rf /root/.cache/pip

COPY backend/ /app/backend/
COPY frontend/ /app/frontend/

# 数据库、上传附件、物料都落在 /data，挂卷后重建容器不丢
RUN mkdir -p /data

ENV DB_PATH=/data/signin_prod.db \
    WEB_ROOT=/data \
    FRONTEND_DIR=/app/frontend

WORKDIR /app/backend
EXPOSE 8087

# 健康检查打的是接口，不是端口探测——服务假死时端口仍可连
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8087/api/health',timeout=2)" || exit 1

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8087"]
