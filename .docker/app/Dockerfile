# syntax=docker/dockerfile:1.7
#
# Shared application image for the Roomote control plane.
#
# One image ships web, api, controller, bullmq, and preview-proxy (plus the
# db-migrate one-shot). Each Compose service selects its process through the
# `.docker/app/entrypoint.sh` dispatcher:
#
#   docker run ghcr.io/roocodeinc/roomote-app:<version> api
#
# Build context: repository root.

FROM docker:28-cli AS docker-cli

# ---------------------------------------------------------------------------
# Base stage: one workspace install plus the full source tree that every app
# build stage below branches from.
# ---------------------------------------------------------------------------
FROM node:24.13.1-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

RUN apt -qq update && \
  apt -qq install -y \
  ca-certificates \
  curl \
  wget \
  unzip \
  jq \
  git \
  python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /roomote

# Do not copy .env.* into the image. Secrets are provided at runtime via the
# container environment (--env-file / compose env); a stray local .env.local
# would otherwise be baked into image layers. run-with-dotenvx.sh falls back to
# the plain command when no .env.local is present.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches ./patches/
COPY .docker/run-with-dotenvx.sh ./.docker/
COPY .docker/sandbox ./.docker/sandbox/
COPY scripts/build-worker-release.sh ./scripts/build-worker-release.sh
COPY packages/ado/package.json ./packages/ado/
COPY packages/auth/package.json ./packages/auth/
COPY packages/cloud-agents/package.json ./packages/cloud-agents/
COPY packages/communication/package.json ./packages/communication/
COPY packages/compute-providers/package.json ./packages/compute-providers/
COPY packages/config-eslint/package.json ./packages/config-eslint/
COPY packages/config-typescript/package.json ./packages/config-typescript/
COPY packages/db/package.json ./packages/db/
COPY packages/env/package.json ./packages/env/
COPY packages/feature-flags/package.json ./packages/feature-flags/
COPY packages/github/package.json ./packages/github/
COPY packages/gitea/package.json ./packages/gitea/
COPY packages/bitbucket/package.json ./packages/bitbucket/
COPY packages/gitlab/package.json ./packages/gitlab/
COPY packages/linear/package.json ./packages/linear/
COPY packages/redis/package.json ./packages/redis/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/slack/package.json ./packages/slack/
COPY packages/telemetry/package.json ./packages/telemetry/
COPY packages/types/package.json ./packages/types/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/controller/package.json ./apps/controller/
COPY apps/bullmq/package.json ./apps/bullmq/
COPY apps/discord-gateway/package.json ./apps/discord-gateway/
COPY apps/preview-proxy/package.json ./apps/preview-proxy/
COPY apps/worker/package.json ./apps/worker/
RUN pnpm install --frozen-lockfile

COPY packages ./packages/
COPY apps/api ./apps/api/
COPY apps/web ./apps/web/
COPY apps/controller ./apps/controller/
COPY apps/bullmq ./apps/bullmq/
COPY apps/discord-gateway ./apps/discord-gateway/
COPY apps/preview-proxy ./apps/preview-proxy/
COPY apps/worker ./apps/worker/

ARG R_APP_ENV
ARG RELEASE_VERSION
ENV R_APP_ENV=${R_APP_ENV}
ENV RELEASE_VERSION=${RELEASE_VERSION}

# ---------------------------------------------------------------------------
# web: Next.js standalone build. The placeholder env values only satisfy
# build-time env validation; real values come from the runtime environment.
# ---------------------------------------------------------------------------
FROM base AS build-web

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV R_APP_URL=http://localhost:13000
ENV TRPC_URL=http://api:3001
ENV DATABASE_URL=postgres://postgres:password@postgres:5432/roomote_development
ENV REDIS_URL=redis://redis:6379
ENV S3_ENDPOINT=http://minio:9000
ENV S3_PRESIGN_ENDPOINT=http://minio:9000
ENV S3_REGION=us-east-1
ENV S3_ACCESS_KEY_ID=roomote
ENV S3_SECRET_ACCESS_KEY=roomote-local-artifacts-password
ENV S3_BUCKET_ARTIFACTS=roomote-artifacts
ENV JOB_AUTH_PRIVATE_KEY=local-self-host-build-job-auth-private-key
ENV JOB_AUTH_PUBLIC_KEY=local-self-host-build-job-auth-public-key
ENV PREVIEW_AUTH_PRIVATE_KEY=local-self-host-build-preview-auth-private-key
ENV PREVIEW_AUTH_PUBLIC_KEY=local-self-host-build-preview-auth-public-key
ENV DASHBOARD_PASSWORD=roomote-local-admin
ENV ENCRYPTION_KEY=local-roomote-encryption-key-0001
ENV ARTIFACT_SIGNING_KEY=local-roomote-artifact-signing-key-1
ENV PREVIEW_PROXY_BASE_URL=http://localhost:18081
ENV PREVIEW_DOMAINS=localhost,127.0.0.1,roomotepreview.localhost

WORKDIR /roomote/apps/web
RUN pnpm build

# Strip sourcemaps from the build output that ships in the runtime image.
# Sourcemaps embed the original source via sourcesContent, so they must never
# reach the published image layers.
RUN find .next/standalone .next/static -type f -name '*.map' -delete

# ---------------------------------------------------------------------------
# api: bundled dist, the self-contained migration runner for the db-migrate
# one-shot, and the runtime-only externals tsup does not bundle.
# ---------------------------------------------------------------------------
FROM base AS build-api

ENV NODE_ENV=production
WORKDIR /roomote/apps/api
RUN pnpm build

ARG SENTRY_ORG
ARG SENTRY_PROJECT_API
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN,required=false sh -ceu '\
  if [ ! -f /run/secrets/SENTRY_AUTH_TOKEN ]; then \
    exit 0; \
  fi; \
  export SENTRY_AUTH_TOKEN="$(cat /run/secrets/SENTRY_AUTH_TOKEN)"; \
  : "${SENTRY_ORG:?SENTRY_ORG is required when SENTRY_AUTH_TOKEN is set}"; \
  : "${SENTRY_PROJECT_API:?SENTRY_PROJECT_API is required when SENTRY_AUTH_TOKEN is set}"; \
  SENTRY_CLI_PACKAGE="@sentry/cli@2.58.1"; \
  echo "Injecting Sentry Debug IDs into api dist/"; \
  pnpm dlx "$SENTRY_CLI_PACKAGE" sourcemaps inject dist; \
  echo "Uploading api sourcemaps to Sentry (${SENTRY_ORG}/${SENTRY_PROJECT_API})"; \
  pnpm dlx "$SENTRY_CLI_PACKAGE" sourcemaps upload \
    --org "$SENTRY_ORG" \
    --project "$SENTRY_PROJECT_API" \
    dist \
'

# Strip sourcemaps after the optional Sentry upload. Sourcemaps embed the
# original TypeScript via sourcesContent, so they must never reach the
# published image layers; Sentry only needs them uploaded, not shipped.
RUN find dist -type f -name '*.map' -delete

# Self-contained migration runner for the db-migrate compose service, which
# runs from this image without pnpm or the workspace.
RUN cd /roomote && pnpm dlx esbuild@0.25.5 packages/db/src/run-migrations.ts \
  --bundle --platform=node --format=esm --outfile=/migrate/migrate.mjs \
  --banner:js="import{createRequire as __createRequire}from 'module';const require=__createRequire(import.meta.url);" && \
  cp -R packages/db/drizzle /migrate/drizzle

# Runtime-only dependency tree for the externals tsup does not bundle.
RUN mkdir -p /runtime-deps && cd /runtime-deps && npm init -y >/dev/null && \
  npm install --omit=dev --no-audit --no-fund \
    "snowflake-sdk@$(cd /roomote/apps/api && node -p "require('snowflake-sdk/package.json').version")"

# ---------------------------------------------------------------------------
# controller: bundled dist plus the packaged worker release archives that the
# docker compute provider injects into task sandboxes.
# ---------------------------------------------------------------------------
FROM base AS build-controller

ENV NODE_ENV=production
WORKDIR /roomote
RUN ./scripts/build-worker-release.sh "${RELEASE_VERSION:-self-host}" --output-dir /roomote/releases && \
  cp "/roomote/releases/worker-v${RELEASE_VERSION:-self-host}.tar.gz" /roomote/releases/worker-current.tar.gz

WORKDIR /roomote/apps/controller
RUN pnpm build

ARG SENTRY_ORG
ARG SENTRY_PROJECT_CONTROLLER
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN,required=false \
  if [ -f /run/secrets/SENTRY_AUTH_TOKEN ]; then \
    export SENTRY_AUTH_TOKEN="$(cat /run/secrets/SENTRY_AUTH_TOKEN)"; \
    : "${SENTRY_ORG:?SENTRY_ORG is required when uploading controller sourcemaps}"; \
    : "${SENTRY_PROJECT_CONTROLLER:?SENTRY_PROJECT_CONTROLLER is required when uploading controller sourcemaps}"; \
    SENTRY_CLI_PACKAGE="@sentry/cli@2.58.1"; \
    echo "Injecting Sentry Debug IDs into controller dist/"; \
    pnpm dlx "$SENTRY_CLI_PACKAGE" sourcemaps inject dist; \
    echo "Uploading controller sourcemaps to Sentry (${SENTRY_ORG}/${SENTRY_PROJECT_CONTROLLER})"; \
    pnpm dlx "$SENTRY_CLI_PACKAGE" sourcemaps upload --org "$SENTRY_ORG" --project "$SENTRY_PROJECT_CONTROLLER" dist; \
  fi

# Strip sourcemaps after the optional Sentry upload. Sourcemaps embed the
# original TypeScript via sourcesContent, so they must never reach the
# published image layers; Sentry only needs them uploaded, not shipped.
RUN find dist -type f -name '*.map' -delete

# Runtime-only dependency tree for modules tsup cannot bundle. The Daytona SDK
# loads form-data through a bundler-evading dynamic require when uploading
# files, so it must exist on disk next to the controller dist at runtime.
RUN mkdir -p /runtime-deps && cd /runtime-deps && npm init -y >/dev/null && \
  npm install --omit=dev --no-audit --no-fund \
    "form-data@$(cd /roomote/apps/controller && node -p "require('form-data/package.json').version")"

# ---------------------------------------------------------------------------
# bullmq: bundled dist plus the bull-board UI package, which serves its static
# dashboard assets from the package directory at runtime.
# ---------------------------------------------------------------------------
FROM base AS build-bullmq

ENV NODE_ENV=production
WORKDIR /roomote/apps/bullmq
RUN pnpm build

# Guard against sourcemaps reaching the published image layers (sourcemaps
# embed the original TypeScript via sourcesContent).
RUN find dist -type f -name '*.map' -delete

RUN mkdir -p /runtime-deps && cd /runtime-deps && npm init -y >/dev/null && \
  npm install --omit=dev --no-audit --no-fund \
    "@bull-board/ui@$(cd /roomote/apps/bullmq && node -p "require('@bull-board/ui/package.json').version")"

# ---------------------------------------------------------------------------
# preview-proxy: bundled dist plus the pino transports tsup keeps external.
# ---------------------------------------------------------------------------
FROM base AS build-preview-proxy

ENV NODE_ENV=production
WORKDIR /roomote/apps/preview-proxy
RUN pnpm build

# Strip sourcemaps so they never reach the published image layers (sourcemaps
# embed the original TypeScript via sourcesContent). The preview-proxy
# entrypoint's --enable-source-maps flag degrades gracefully without them.
RUN find dist -type f -name '*.map' -delete

RUN mkdir -p /runtime-deps && cd /runtime-deps && npm init -y >/dev/null && \
  npm install --omit=dev --no-audit --no-fund \
    "pino@$(cd /roomote/apps/preview-proxy && node -p "require('pino/package.json').version")" \
    "pino-pretty@$(cd /roomote/apps/preview-proxy && node -p "require('pino-pretty/package.json').version")"

# ---------------------------------------------------------------------------
# Runtime base: only health-check/TLS/process-init tooling shared by control
# plane services. Heavier runtime tools (OpenCode, gh, Docker CLI) are layered
# on via dedicated stages below.
# ---------------------------------------------------------------------------
FROM node:24.13.1-slim AS runtime-base

LABEL org.opencontainers.image.source=https://github.com/RooCodeInc/Roomote

RUN apt -qq update && \
  apt -qq install -y \
  ca-certificates \
  curl \
  tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /roomote

COPY .docker/run-with-dotenvx.sh ./.docker/
COPY .docker/app/entrypoint.sh ./.docker/app/entrypoint.sh
RUN chmod +x /roomote/.docker/app/entrypoint.sh

ARG R_APP_ENV
ARG RELEASE_VERSION
ENV R_APP_ENV=${R_APP_ENV}
ENV RELEASE_VERSION=${RELEASE_VERSION}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOME=/tmp

ENTRYPOINT ["/usr/bin/tini", "--", "/roomote/.docker/app/entrypoint.sh"]

# Non-task inference (routing, summaries, automation planning, and related
# control-plane calls) starts a managed OpenCode SDK server in-process.
FROM runtime-base AS runtime-inference-base

ARG OPENCODE_CLI_VERSION=1.17.8

# The install and version check run as root; with the image's HOME=/tmp they
# would bake root-owned dotdirs (npm cache, OpenCode's data/config/cache
# dirs) into the layer. The runtime user shares that HOME and must be able to
# create those paths itself — on hosts that run the raw image without a tmpfs
# over /tmp (e.g. Railway), leftover root-owned dirs make OpenCode's log open
# fail with PermissionDenied and the SDK server exits before ready. Run the
# whole step under a disposable HOME and remove it, so no dotdir allowlist
# needs maintaining.
RUN export HOME=/tmp/opencode-build \
  && npm install --prefix /opt/opencode-cli --no-save --no-package-lock \
    "opencode-ai@${OPENCODE_CLI_VERSION}" \
  && test -x /opt/opencode-cli/node_modules/.bin/opencode \
  && test "$(/opt/opencode-cli/node_modules/.bin/opencode --version)" = "${OPENCODE_CLI_VERSION}" \
  && ln -sf /opt/opencode-cli/node_modules/.bin/opencode /usr/local/bin/opencode \
  && rm -rf /tmp/opencode-build

# GitHub PR prompt generation still uses the gh CLI in the API process. Keep
# the installer isolated so only API-bearing runtime targets receive it.
FROM runtime-base AS github-cli

RUN apt -qq update && \
  apt -qq install -y git && \
  ARCH="$(dpkg --print-architecture)" && \
  if [ "$ARCH" = "amd64" ]; then \
    GH_CLI_URL="https://github.com/cli/cli/releases/download/v2.81.0/gh_2.81.0_linux_amd64.deb"; \
  elif [ "$ARCH" = "arm64" ]; then \
    GH_CLI_URL="https://github.com/cli/cli/releases/download/v2.81.0/gh_2.81.0_linux_arm64.deb"; \
  else \
    echo "Unsupported architecture: $ARCH" && exit 1; \
  fi && \
  curl -fsSL "$GH_CLI_URL" -o /tmp/gh.deb && \
  dpkg -i /tmp/gh.deb && \
  rm -f /tmp/gh.deb && \
  test -x /usr/bin/gh

# ---------------------------------------------------------------------------
# Shared control-plane runtime target. One image runs every control-plane
# service; the entrypoint's first argument selects which one. It is non-root,
# and privilege separation between services lives in the Compose files:
# read-only filesystems, per-service env contracts (ROOMOTE_SERVICE), and a
# Docker socket proxy reachable only from the controller service.
# ---------------------------------------------------------------------------
FROM runtime-inference-base AS runtime-app

ENV ROOMOTE_SERVICE=

RUN groupadd --system --gid 10000 roomote-app && \
  useradd --system --uid 10000 --gid roomote-app --home-dir /nonexistent --shell /usr/sbin/nologin roomote-app

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY .docker/sandbox ./.docker/sandbox/
# Workspace marker: controller path resolution walks up from cwd looking for
# pnpm-workspace.yaml (apps/controller/src/repo-paths.ts).
COPY pnpm-workspace.yaml ./
COPY apps/preview-proxy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY --chown=roomote-app:roomote-app --from=build-web /roomote/apps/web/.next/standalone ./
COPY --chown=roomote-app:roomote-app --from=build-web /roomote/apps/web/.next/static ./apps/web/.next/static/
COPY --chown=roomote-app:roomote-app --from=build-web /roomote/apps/web/public ./apps/web/public/
COPY --from=build-api /roomote/apps/api/package.json ./apps/api/
COPY --from=build-api /roomote/apps/api/dist ./apps/api/dist/
COPY --from=build-api /runtime-deps/node_modules ./apps/api/node_modules/
COPY --from=build-api /migrate /roomote/migrate/
COPY --from=build-controller /roomote/releases /roomote/releases/
COPY --from=build-controller /roomote/apps/controller/package.json ./apps/controller/
COPY --from=build-controller /roomote/apps/controller/dist ./apps/controller/dist/
COPY --from=build-controller /runtime-deps/node_modules ./apps/controller/node_modules/
COPY --from=build-bullmq /roomote/apps/bullmq/package.json ./apps/bullmq/
COPY --from=build-bullmq /roomote/apps/bullmq/dist ./apps/bullmq/dist/
COPY --from=build-bullmq /runtime-deps/node_modules ./apps/bullmq/node_modules/
COPY --from=build-preview-proxy /roomote/apps/preview-proxy/package.json ./apps/preview-proxy/
COPY --from=build-preview-proxy /roomote/apps/preview-proxy/dist ./apps/preview-proxy/dist/
COPY --from=build-preview-proxy /runtime-deps/node_modules ./apps/preview-proxy/node_modules/
COPY --from=github-cli /usr/bin/gh /usr/local/bin/gh
RUN command -v gh >/dev/null && command -v opencode >/dev/null

USER roomote-app:roomote-app
EXPOSE 3000 3001 3002 8081
