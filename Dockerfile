# KOSPI 백테스트 웹 — Synology Container Manager / Docker 용
# amd64(인텔·AMD NAS)와 arm64(Realtek RTD1619B 등) 모두 빌드됩니다.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TZ=Asia/Seoul
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# 캐시·CSV 폴더 (compose 에서 NAS 폴더로 연결)
RUN mkdir -p .cache data/csv && chmod 777 .cache data/csv
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "server.js"]
