# 功能：构建并运行隔离账号的 Morrow Web 服务。
# 作者：xuanli
# 创建时间：2026-10-25 23:44:46
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:web

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production MORROW_HOST=0.0.0.0 MORROW_DATA_DIR=/app/data PORT=3000
COPY --from=build /app/dist ./dist
COPY server ./server
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "server/healthcheck.mjs"]
CMD ["node", "server/index.mjs"]
