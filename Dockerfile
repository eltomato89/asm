# syntax=docker/dockerfile:1

# --- build: compile native deps (better-sqlite3, argon2) for musl, build shared/server/web, deploy prod deps ---
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++ \
 && npm install -g pnpm@11.7.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @asm/shared build \
 && pnpm --filter @asm/server build \
 && pnpm --filter @asm/web build \
 && pnpm --filter @asm/server deploy --prod --legacy /out

# --- runtime: server + production node_modules + web UI only (no CLI, no build toolchain) ---
FROM node:22-alpine
ENV NODE_ENV=production \
    ASM_DATA_DIR=/data \
    PORT=8080
WORKDIR /app
# The server serves the web UI from apps/web/dist (resolved relative to apps/server/dist/web/static.js).
COPY --from=build /out apps/server
COPY --from=build /src/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" >/dev/null || exit 1
CMD ["node", "apps/server/dist/main.js"]
