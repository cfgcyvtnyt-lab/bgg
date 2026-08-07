# 웹앱을 빌드해서 서버 이미지 안에 넣고, 한 컨테이너가 앱과 API를 함께 내보낸다.
#
# 데이터(기록·컬렉션·사진·이미지 캐시)는 이 이미지에 절대 넣지 않는다.
# 볼륨으로 붙인다 - docker-compose.yml 참고. 이미지에 구우면 컨테이너를 다시 만들 때마다
# 그때의 데이터로 되돌아가고, 구매가·사진이 이미지째 돌아다니게 된다.

# ---------- 1단계: 웹앱 빌드 ----------
FROM node:24-alpine AS web
WORKDIR /build
# 의존성을 먼저 받아두면 소스만 바뀌었을 때 이 레이어를 재사용한다
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- 2단계: 실행 ----------
FROM node:24-alpine
WORKDIR /app

# 서버는 express 하나만 쓴다. devDependencies는 받지 않는다.
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

COPY server/src ./src
COPY --from=web /build/dist ./web-dist

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/app/data/app.db
ENV IMAGE_CACHE_DIR=/app/data/cache/images
ENV PHOTO_DIR=/app/data/photos
ENV WEB_DIST=/app/web-dist

EXPOSE 3001

# 볼륨이 안 붙었을 때도 뜨긴 해야 하므로 디렉터리는 서버가 알아서 만든다(mkdirSync).
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1

CMD ["node", "src/index.js"]
