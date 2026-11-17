# syntax=docker/dockerfile:1

# --- build: compile native deps (better-sqlite3, argon2) for musl, build shared/server/web + CLI bundle, deploy prod deps ---
FROM node:24-alpine AS build
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
 && pnpm --filter @asm/cli bundle \
 && pnpm --filter @asm/server build \
 && pnpm --filter @asm/web build \
 && pnpm --filter @asm/server deploy --prod --legacy /out
# Third-party licenses: the CLI and web builds wrote their own notices (dist-bundle/THIRD_PARTY_NOTICES,
# web/dist/THIRD_PARTY_NOTICES.txt); the combined file adds every package in the deployed server node_modules.
RUN node scripts/third-party-notices.mjs combine --out /src/THIRD_PARTY_NOTICES \
      --node-modules /out/node_modules --label server \
      --from apps/web/dist/THIRD_PARTY_NOTICES.txt --label "web UI" \
      --from apps/cli/dist-bundle/THIRD_PARTY_NOTICES --label CLI

# --- runtime: server + production node_modules + web UI + CLI bundle (served under /cli), no build toolchain ---
FROM node:24-alpine
ENV NODE_ENV=production \
    ASM_DATA_DIR=/data \
    PORT=8080 \
    ASM_CLI_DIR=/app/cli
WORKDIR /app
LABEL org.opencontainers.image.licenses="Apache-2.0"
COPY LICENSE NOTICE /app/
COPY --from=build /src/THIRD_PARTY_NOTICES /app/
# The server serves the web UI from apps/web/dist (resolved relative to apps/server/dist/web/static.js).
COPY --from=build /out apps/server
COPY --from=build /src/apps/web/dist apps/web/dist
# Single-file CLI bundle + manifest + licenses for /cli/install.sh, /cli/asm.mjs, /cli/asm.json, /cli/THIRD_PARTY_NOTICES
# (read-only for the node user).
COPY --from=build /src/apps/cli/dist-bundle/asm.mjs /src/apps/cli/dist-bundle/asm.json /src/apps/cli/dist-bundle/THIRD_PARTY_NOTICES /app/cli/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" >/dev/null || exit 1
CMD ["node", "apps/server/dist/main.js"]
