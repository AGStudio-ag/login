# AG 考勤后端：Node.js API + Python 考勤脚本
# 目标平台：Northflank / 任意支持 Dockerfile 的容器平台
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8080 \
    PYTHON_BIN=python3 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Debian bookworm 自带 Python 3.11；安装 pip 和时区数据
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        ca-certificates \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

# 先装 Node 依赖，利用 Docker 层缓存
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 再装 Python 依赖
COPY requirements.txt ./
RUN python3 -m pip install --no-cache-dir --break-system-packages -r requirements.txt

# 复制应用代码
COPY . .

RUN mkdir -p uploads \
    && chown -R node:node /app

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
