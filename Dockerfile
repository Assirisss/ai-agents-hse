FROM node:24-bookworm-slim AS backend-build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY shared/ /app/shared/
COPY backend/tsconfig.json ./
COPY backend/src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS backend
ENV NODE_ENV=production API_HOST=0.0.0.0 PORT=8787
WORKDIR /app/backend
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY --from=backend-build /app/backend/package.json /app/backend/package-lock.json ./
COPY --from=backend-build /app/backend/node_modules/ ./node_modules/
COPY --from=backend-build /app/backend/dist/ ./dist/
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 8787
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health', {signal: AbortSignal.timeout(3000)}).then(r => {if (!r.ok) process.exit(1)}).catch(() => process.exit(1))"
CMD ["node", "dist/backend/src/server.js"]

FROM node:24-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY shared/ /app/shared/
COPY frontend/ ./
RUN npm run build

FROM nginx:stable-alpine AS frontend
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/frontend/dist/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
