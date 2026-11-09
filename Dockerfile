# syntax=docker/dockerfile:1.7
# One Dockerfile, two runtime targets: `web` (dashboard) and `worker` (agents, broker sync, schedulers).
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG APP_VERSION=dev
ENV NEXT_TELEMETRY_DISABLED=1
COPY packages packages
COPY apps apps
RUN pnpm --filter @tv/core test \
 && pnpm --filter @tv/worker build \
 && pnpm --filter @tv/web build \
 && pnpm --filter @tv/worker deploy --legacy --prod /out/worker \
 && cp -r apps/worker/dist /out/worker/dist \
 && cp -r packages/db/migrations /out/worker/migrations

FROM node:22-alpine AS worker
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]

FROM node:22-alpine AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "apps/web/server.js"]
