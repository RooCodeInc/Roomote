---
title: Deployment & Release
status: active
last_reviewed: 2026-07-09
owner: engineering
summary: Local-first deployment and release guidance for the Roomote split, covering Docker Compose infrastructure, PM2 development services, the public self-host operator guide, the single-host Caddy production overlay, the one-command host installer and roomote host CLI, the V1 GHCR and DigitalOcean deployment flow, Changesets product versioning and develop→main promotion, preview image publishing, CI, and current managed-host exclusions.
---

# Deployment & Release

Roomote currently optimizes for a local, self-hostable runtime. Preview and
managed production platform deployment are intentionally empty in this split
while the project focuses on making local install and single-host operation
reliable.

The public operator-facing self-hosting guide is
[`SELF_HOSTING.md`](../../SELF_HOSTING.md). Keep this internal runbook focused
on implementation details and keep the top-level guide as the user-facing
source for install and operations steps.

## Current Scope

Active infrastructure:

1. Docker Compose for Postgres, Redis, and MinIO artifact storage
2. PM2-managed local services through `pnpm dev`
3. Local self-host Compose overlay for web, API, controller, BullMQ, and preview
   proxy
4. Production Caddy Compose overlay for a single-host HTTPS reverse proxy
5. V1 production deployer under `deploy/` for one DigitalOcean VM per customer
   using GHCR image tags, Terraform, cloud-init, Docker Compose, and Caddy
6. One-command host installer (`deploy/install.sh`) plus the `roomote` host CLI
   (`deploy/host/roomote`) for self-serve single-host installs on an existing
   server, served at `https://get.roomote.dev` by the Vercel proxy under
   `deploy/get-roomote/`
7. GHCR image publishing for `develop` preview tags, `main` channel tags, and
   immutable `v*` production tags
8. Changesets single-product versioning with automated Version / Promote PRs
   and `v*` GitHub Releases on `main`
9. Local worker release archive builds for sandbox execution
10. `pnpm run doctor` local runtime diagnostics
11. Validation GitHub Actions CI
12. Railway PaaS deployment path under `deploy/railway/` — a maintained
    template spec (`template.yaml`, published as two marketplace templates
    that differ only in image channel: stable `:main` and latest-build
    `:develop`) plus operator guide for running the
    published images on Railway with managed Postgres/Redis, hosted compute
    (Modal/E2B/Daytona; the Docker provider cannot run without a Docker
    socket), separate web/API origins instead of Caddy path routing, and
    `ROOMOTE_AUTO_GENERATE_KEYS=true` instead of installer-generated
    keypairs. `ROOMOTE_APP_URL` on the api service is the single
    canonical-origin knob (`ROOMOTE_PUBLIC_URL` stays unset; the app falls
    back) and the template's one optional deploy-time prompt, so a custom
    domain is either entered on the deploy screen before first boot or
    attached later as a one-variable edit — see "Attaching a custom
    domain" in `deploy/railway/README.md`
13. Coolify deployment path under `deploy/coolify/` — a maintained,
    paste-ready Docker Compose resource (`docker-compose.yaml`) plus operator
    guide for running the published images on a Coolify-managed server.
    Coolify's proxy is the HTTPS edge (separate web/API/MinIO domains instead
    of Caddy path routing), Coolify magic variables (`SERVICE_*`) generate the
    secrets and domains, and `ROOMOTE_AUTO_GENERATE_KEYS=true` replaces
    installer-generated keypairs. Unlike Railway, the host Docker socket is
    available, so the `docker` compute provider is the template default and
    hosted compute is the documented alternative
14. Render PaaS deployment path — a maintained Blueprint (`render.yaml` at
    the repository root, because Render's deploy button and Blueprint sync
    only read it from there) plus an operator guide under `deploy/render/`
    for running the published images on Render with managed Postgres and Key
    Value (Redis), hosted compute (Modal/E2B/Daytona; no Docker socket),
    separate web/API origins instead of Caddy path routing, and
    `ROOMOTE_AUTO_GENERATE_KEYS=true` instead of installer-generated
    keypairs. Shared values live in the `roomote-shared` environment group.
    Because Render Blueprints cannot interpolate service references into
    strings, each app service receives host-only `fromService` references
    and the image's entrypoint dispatcher composes `ROOMOTE_APP_URL`,
    `TRPC_URL`, `S3_ENDPOINT`, and `S3_PRESIGN_ENDPOINT` from them when
    unset. Keep `dockerCommand` values quote-free (plain
    `/roomote/.docker/app/entrypoint.sh <service>`): Render's parser passes
    quote characters through literally, so `/bin/sh -c '...'` wrappers exit
    127 — see "Attaching a custom domain" in
    `deploy/render/README.md` for the origin-change consequence
15. Fly.io deployment path under `deploy/fly/` — a maintained `fly.toml`
    plus operator guide for running the published images as one Fly app
    whose process groups (web, api, controller, bullmq) each run in their
    own Machine. Fly Proxy is the HTTPS edge (web on 443, api on port 8443
    of the same hostname instead of Caddy path routing), managed resources
    replace the bundled datastores (Fly Managed Postgres, Upstash Redis,
    and Tigris object storage instead of MinIO), and, like Railway, no
    Docker socket is available, so hosted compute (Modal/E2B/Daytona) is
    required and `ROOMOTE_AUTO_GENERATE_KEYS=true` replaces
    installer-generated keypairs. Fly has no template marketplace, so the
    deploy path is the copy-paste `flyctl` quick-deploy sequence in
    `deploy/fly/README.md`

Out of scope for now:

- Managed hosted preview and production environments
- hosted log or metrics shippers
- Slack CI failure notifications
- automatic GitHub worker release publishing
- Stripe, Clerk, Modal, or hosted encrypted-env requirements for local startup

## Local Runtime

`pnpm dev` is the canonical local startup command. It runs through
`apps/dev`, prepares service code, resolves a public callback URL, starts
Postgres, Redis, and MinIO if needed, builds the local worker release archive
unless `--use-release` is set, and starts the Roomote PM2 services.

The dev preflight still requires `ROOMOTE_PUBLIC_URL` and validates configured
model provider credentials, but source-control provider credentials are
setup-time configuration rather than boot prerequisites. Startup does not check
GitHub App, GitLab, Gitea, or Azure DevOps credentials; `/setup` captures those
values into encrypted deployment environment variables, or treats matching
process env vars as already configured.

Local services:

| Service                            | Port  | Command                          |
| ---------------------------------- | ----- | -------------------------------- |
| `roomote-api`                      | 13001 | `pnpm --filter @roomote/api dev` |
| `roomote-web`                      | 13000 | `pnpm --filter @roomote/web dev` |
| `roomote-preview-proxy`            | 18081 | Preview proxy server             |
| `roomote-bullmq`                   | 13002 | Queue dashboard + scheduled jobs |
| `roomote-controller`               | -     | Job dispatcher                   |
| `roomote-worker-release-watcher`   | -     | Rebuilds worker on file changes  |
| `roomote-web-ngrok` when automatic | -     | Public tunnel for web callbacks  |

Immediate local tasks still use controller and queue infrastructure. The hosted
product work-queue route is not part of this Roomote local path.

## Public Callback URL

Local OAuth callbacks and integration events need a public HTTPS origin.
`pnpm dev` resolves that origin before starting services:

1. `ROOMOTE_PUBLIC_URL` is required and must be an absolute `https://`
   origin.
2. If `ROOMOTE_PUBLIC_URL` is an ngrok domain, the dev CLI checks that ngrok
   is installed and authenticated, starts or reuses
   `ngrok http --url=<domain> 13000` under PM2 as `roomote-web-ngrok`, then
   exports the origin as `ROOMOTE_PUBLIC_URL` and `ROOMOTE_APP_URL`.
3. If `ROOMOTE_PUBLIC_URL` is any other HTTPS origin, the dev CLI uses it
   without starting ngrok.

The web app proxies `/api/webhooks/*` to the API service, so Slack, Microsoft
Teams, Telegram, GitHub, GitLab, and Linear callbacks can point at the
same public base URL.

`pnpm dev --ngrok` remains a reserved-domain mode for accounts that own the
expected ngrok domains. It requires `NGROK_USER` and creates web, API, and
preview-proxy tunnels.

## Database, Redis, And Artifacts

`docker-compose.yml` owns the local database, Redis, and MinIO containers. The
root scripts use Roomote-specific Docker volumes so this repo can run beside the
old Roomote checkout:

```bash
pnpm db:up
pnpm db:down
pnpm db:reset
```

`pnpm db:up` starts containers, creates the MinIO artifact bucket, runs
development migrations, and pushes the test schema. `pnpm db:reset` recreates
the local volumes and leaves the database migrated but unseeded; run
`pnpm db:seed` afterwards if the local-admin identity is needed.

## Self-Host Compose Overlay

`docker-compose.self-host.yml` layers application services on top of the base
Postgres/Redis/MinIO Compose file. It is an application layer, not a runnable
stack on its own: run it together with `docker-compose.production.yml` (see
[Production Caddy Overlay](#production-caddy-overlay) below), which
switches it to production mode and requires real per-install secrets. Running
the self-host layer alone leaves the development defaults in effect, so services
call `assertSecureBootBinding()` at startup and refuse to serve on a
non-loopback bind unless real secrets are supplied (or
`ROOMOTE_ALLOW_INSECURE_LOCAL_KEYS=1` is set for trusted local use).

The base Compose file also runs `roomote-minio` and the one-shot
`minio-init` bucket initializer. The overlay runs these local containers, all
from one shared application image (`.docker/app/Dockerfile`) built by the
`db-migrate` service and dispatched per service through
`.docker/app/entrypoint.sh`:

| Service                 | Host Port | Container Port | Dispatcher command |
| ----------------------- | --------- | -------------- | ------------------ |
| `roomote-db-migrate`    | -         | -              | `db-migrate`       |
| `roomote-web`           | 13000     | 3000           | `web`              |
| `roomote-api`           | 13001     | 3001           | `api`              |
| `roomote-bullmq`        | 13002     | 3002           | `bullmq`           |
| `roomote-preview-proxy` | 18081     | 8081           | `preview-proxy`    |
| `roomote-controller`    | -         | -              | `controller`       |

The shared app Dockerfile is multi-stage: a single `base` stage installs the
workspace once, per-app build stages branch from it (tsup bundles each service
with `noExternal: [/.*/]`; web uses Next.js `output: 'standalone'`), and the
final `runtime` stage ships only the bundled outputs plus runtime tools — no
source tree and no workspace `node_modules`. Dependencies that stay outside
the bundle ride along as a minimal npm tree built in the matching build stage:
`snowflake-sdk` (api, native), `pino`/`pino-pretty` (preview-proxy,
worker-thread transports), and `@bull-board/ui` (bullmq, serves static
dashboard assets from its package directory). When adding a runtime dependency
that tsup cannot bundle or that reads files from its own package directory,
add it to that app's `/runtime-deps` install step or the runtime image will
miss it.

`roomote-db-migrate` runs Drizzle migrations against Postgres before API, web,
controller, BullMQ, or preview-proxy start. Under the production overlay,
operator-owned config (public URL, Better Auth provider credentials,
GitHub/Slack/Linear credentials, model provider keys, and the required secrets)
comes from `.env.production` passed with `--env-file`. The image never bakes
`.env.*` secret files (`.dockerignore` excludes them and the Dockerfile does not
copy them), and compose sets `ROOMOTE_DOCKER_LOAD_ENV_FILE=false` so the
container's dotenvx wrapper does not try to load a local env file over the
operator-owned environment. Auth keypairs are
either supplied explicitly or generated on first boot when
`ROOMOTE_AUTO_GENERATE_KEYS=true` (see
[`packages/db/src/lib/deployment-auth-keypairs.ts`](../../packages/db/src/lib/deployment-auth-keypairs.ts)),
so no signing key ships in source.

Artifact uploads use S3-compatible storage. Local development points
server-side S3 reads and browser-facing presigned URLs at
`http://localhost:19000`; local Docker workers call the API through
`host.docker.internal`, so worker-facing presigned URLs are signed with
`host.docker.internal` before being returned. The self-host Compose overlay sets
both `S3_ENDPOINT` and `S3_PRESIGN_ENDPOINT` to `http://minio:9000`, because
web/API/controller and Docker workers share the Compose network in that mode.

## Production Caddy Overlay

`docker-compose.production.yml` is the first production-facing packaging
surface. It layers on top of `docker-compose.yml` and
`docker-compose.self-host.yml`, adds the `roomote-caddy` service, switches
the application containers to `NODE_ENV=production` and `APP_ENV=production`,
and removes direct host-port publishing from Postgres, Redis, MinIO, web, API,
BullMQ, and preview proxy. Caddy should be the only public entrypoint and
publishes ports `80` and `443`.

Use it with an explicit production dotenv file:

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-host.yml \
  -f docker-compose.compute-docker.yml \
  -f docker-compose.production.yml \
  up -d --build
```

Include `docker-compose.compute-docker.yml` when
`DEFAULT_COMPUTE_PROVIDER=docker`. Omit it when the deployment uses a hosted
worker provider such as `modal`, `daytona`, or `e2b`.

The overlay requires `ROOMOTE_APP_DOMAIN` and `ROOMOTE_PREVIEW_DOMAIN`.
Compose derives these runtime URLs from them:

| Runtime key              | Derived value                              |
| ------------------------ | ------------------------------------------ |
| `ROOMOTE_APP_URL`        | `https://$ROOMOTE_APP_DOMAIN`              |
| `ROOMOTE_PUBLIC_URL`     | `https://$ROOMOTE_APP_DOMAIN`              |
| `TRPC_URL`               | `https://$ROOMOTE_APP_DOMAIN/_roomote-api` |
| `PREVIEW_PROXY_BASE_URL` | `https://$ROOMOTE_PREVIEW_DOMAIN`          |
| `PREVIEW_DOMAINS`        | `$ROOMOTE_PREVIEW_DOMAIN`                  |

Required DNS:

| DNS name                   | Target          |
| -------------------------- | --------------- |
| `ROOMOTE_APP_DOMAIN`       | deployment host |
| `ROOMOTE_PREVIEW_DOMAIN`   | deployment host |
| `*.ROOMOTE_PREVIEW_DOMAIN` | deployment host |

The Caddy config lives in `deploy/caddy/Caddyfile`. It serves the app and API
from `ROOMOTE_APP_DOMAIN`: the reserved `/_roomote-api/*` prefix is stripped and
sent to `api:3001`, the configured `/$S3_BUCKET_ARTIFACTS/*` path is proxied to
MinIO without path rewriting for presigned artifact uploads and downloads, and
all other paths go to `web:3000`. The preview domain and one-label preview
subdomains such as
`<taskId>-web.<preview-domain>` go to `preview-proxy:8081`. Caddy retries
briefly unavailable upstreams for a short window so single-container recreates
are less likely to surface as transient 502s. Caddy manages the app/API domain
certificate normally and uses on-demand TLS for preview subdomains. The
on-demand TLS `ask`
endpoint is `/api/caddy/ask` in the web app; it approves only the configured
preview host and one-label subdomains beneath it. This avoids requiring a
DNS-provider Caddy build for the first production edge while preventing Caddy
from issuing certificates for arbitrary domains.

Core production values are required by the overlay instead of inherited from
image defaults:

- `DATABASE_URL`
- `REDIS_URL`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_BUCKET_ARTIFACTS`
- `DEFAULT_COMPUTE_PROVIDER`
- `JOB_AUTH_PRIVATE_KEY`
- `JOB_AUTH_PUBLIC_KEY`
- `PREVIEW_AUTH_PRIVATE_KEY`
- `PREVIEW_AUTH_PUBLIC_KEY`
- `ENCRYPTION_KEY`
- `ARTIFACT_SIGNING_KEY`
- `DASHBOARD_PASSWORD`

`ROOMOTE_MODEL`, `ROOMOTE_SMALL_MODEL`, `ROOMOTE_VISION_MODEL`,
`ROOMOTE_CODE_REVIEW_MODEL`, and `ROOMOTE_EXPLORE_MODEL` remain optional
env-level overrides. Leave them unset when task models are managed through
persisted Roomote runtime settings; Compose should forward blank values instead
of rejecting the deployment.

The API and web production images include the pinned OpenCode CLI because
server-side non-task text calls shell out to `opencode run`, and structured
object calls use a warm local `opencode serve` child unless
`OPENCODE_SDK_SERVER_URL` / `OPENCODE_SERVER_URL` points at an externally
managed server. The local child is reused for matching resolved model env and
closed after it sits idle. Slack routing, Linear routing, task titles, and
suggestions execute in the API process; Home Auto routing and task-summary
generation can execute in the web process. If model calls log
`OpenCode routing did not return a workspace response` or
`FileNotFoundError: ... 'opencode'`, verify `opencode` is available inside the
container handling the request before debugging environment selection data.

Use `.env.production.example` as the operator-owned template and keep real
values out of git. The Roomote signing keypairs are operator-generated P-256
PEMs stored as single-line base64 (`JOB_AUTH_*` and `PREVIEW_AUTH_*`); private
keys use PKCS8 and public keys use standard public-key PEM. Deployments that
cannot run `openssl` during provisioning can instead set
`ROOMOTE_AUTO_GENERATE_KEYS=true` to have Roomote generate and persist the
keypairs in the database at first startup (see
[Runtime Environment Handling](../architecture/runtime-env.md)). `GITHUB_APP_PRIVATE_KEY`
is different: it comes from the GitHub App settings page and is stored as an
escaped raw PEM, not base64. The production env block also forwards configured
auth provider credentials, model provider keys, GitHub App values, Slack/Linear
integration credentials, and compute provider credentials into application
containers. `minio_data`, `caddy_data`, and `caddy_config` are named Docker
volumes so artifact objects, ACME account state, and certificates survive
container rebuilds.

Docker compute for production-style self-hosting is supplied by
`docker-compose.compute-docker.yml`. That overlay builds the worker image,
mounts the host Docker socket into the controller, sets
`DOCKER_WORKER_NETWORK=roomote_worker` (a dedicated network that reaches the
API, controller, and preview proxy but not Postgres/Redis/MinIO), and uses the
controller image's
packaged worker release archive. The worker sandbox server is exposed through
the preview proxy while the underlying `machineDomains` remain Docker-network
URLs. This mode is intended for a trusted single-host deployment, not for a
multi-host worker fleet. Use a hosted provider such as `modal`, `daytona`, or
`e2b` when the controller should not
control the host Docker daemon.

The bundled MinIO endpoint is private to the Compose network. If a deployment
uses bundled MinIO, keep `S3_ENDPOINT=http://minio:9000` for server-side access
and sign presigned artifact URLs against a worker-reachable HTTPS origin. The
production and DigitalOcean Compose overlays default `S3_PRESIGN_ENDPOINT` to
`https://$ROOMOTE_APP_DOMAIN`; Caddy forwards `/$S3_BUCKET_ARTIFACTS/*` to
MinIO while preserving the bucket path and original `Host` header, which keeps
AWS SigV4 signatures valid for Docker workers, hosted workers such as `modal`,
`daytona`, or `e2b`, and browser downloads. If storage is moved out of the stack, point
both S3 settings at the managed object-store endpoints instead.

## One-Command Host Installer

[`deploy/install.sh`](../../deploy/install.sh) is the self-serve install path:
a user SSHes into their own Ubuntu/Debian x86_64 or arm64 server and runs
`curl -fsSL https://get.roomote.dev | bash`. It is intentionally the same
deployment shape as the V1
deployer — `/opt/roomote`, `deploy/compose/docker-compose.prod.yml`, the Caddy
edge, and `roomote-compose.service` — minus Terraform and the operator
workstation.

The installer:

1. Refuses to run on non-Linux machines before any other check (people paste
   the one-liner into macOS terminals or Windows Git Bash). The non-Linux
   message is OS-specific but the installer stays Linux-only and never
   installs Multipass, launches VMs, or mutates the host on a non-Linux
   system: `Darwin` (macOS) suggests spinning up an Ubuntu VM with Multipass
   (`brew install --cask multipass`, then `multipass launch 24.04 ...` and
   `multipass shell roomote`) and running the installer inside it;
   `MINGW*`/`MSYS*`/`CYGWIN*` (Windows Git Bash/MSYS2/Cygwin) suggests a real
   Linux server or a local Ubuntu VM via Multipass on Windows (optional
   `winget install -e --id Canonical.Multipass`), and notes that WSL2 is not
   recommended because the installer expects a server-like Linux host with
   Docker, systemd, and full networking; any other `uname -s` falls back to
   the generic "SSH into an Ubuntu/Debian server and run the installer there"
   guidance. The Multipass/VM path is framed as a way to try the installer
   locally, not a production deployment path, with a warning that local VM
   networking/domains/webhooks may differ from a real VPS — production
   guidance remains SSH into the server, and local repo development still
   points at `pnpm dev`. Then requires root, then x86_64 or arm64
   unless `ROOMOTE_INSTALL_SKIP_ARCH_CHECK=1` (an escape hatch for other
   architectures under emulation). The arch also selects the
   `DOCKER_WORKER_PLATFORM` value written to the env file.
2. Installs Docker Engine and the Compose plugin when missing (same apt flow as
   the DigitalOcean cloud-init template).
3. Resolves the newest `v*` GitHub release when `--version` is omitted. For
   `develop-<short-sha>` image tags, deployment files are fetched from the
   `develop` branch because those tags exist only in GHCR, not in git.
4. Generates every operator secret from `SELF_HOSTING.md`'s openssl recipes:
   both P-256 keypairs, `ENCRYPTION_KEY`, `ARTIFACT_SIGNING_KEY`,
   `DASHBOARD_PASSWORD`, `S3_SECRET_ACCESS_KEY`, and a URL-safe `SETUP_TOKEN`.
5. Defaults the app domain to `roomote.<dashed-ip>.sslip.io` when `--domain` is
   omitted, so a fresh install needs zero DNS setup; sslip.io also resolves the
   `*.preview.` wildcard. With `--domain`, the script polls DNS and warns
   (without failing) when the record does not point at the host yet.
6. Writes `/opt/roomote/.env`, fetches the Compose file, Caddyfile, and
   `deploy/host/roomote` CLI at the matching ref, installs
   `roomote-compose.service`, pulls the app images, and runs
   `docker compose up -d --wait`. The much larger task worker image downloads
   in the background after the stack is up (logged to
   `/var/log/roomote-worker-pull.log`), so the setup link prints as soon as
   the app services are healthy; the first task waits for the worker image if
   it has not finished downloading.
7. Prints the `https://<domain>/setup?token=<SETUP_TOKEN>` bootstrap link. The
   `/setup` bootstrap wizard requires that token until initial setup completes
   (see the SETUP_TOKEN notes below).

Re-runs preserve an existing `/opt/roomote/.env` (secrets and domain) and only
refresh deployment-owned metadata, mirroring the deployer's upgrade semantics.
That metadata includes the Modal image sync rule: the installer sets
`MODAL_BASE_IMAGE_REF` to the release-matched worker image whenever it is
blank or still equals the previously configured `DOCKER_WORKER_IMAGE`, so the
setup wizard's Modal path only needs the token pair. The published images are
public, so neither the installer nor the deployer takes registry pull
credentials; `MODAL_REGISTRY_USERNAME`/`MODAL_REGISTRY_PASSWORD` remain
app-level settings for deployments whose worker image lives in a private
registry, because Modal's remote builder pulls `MODAL_BASE_IMAGE_REF` itself.
Independently of the installer sync, the app itself derives missing
worker-image values at runtime: an unset `DOCKER_WORKER_IMAGE` (and, through
it, `MODAL_BASE_IMAGE_REF`) falls back to
`${ROOMOTE_WORKER_IMAGE_REPO:-ghcr.io/roocodeinc/roomote-worker}:${RELEASE_VERSION}`
from the release version baked into the published app image, so
compose-based deployments that skip the installer do not need to bump these
values on every upgrade (see the compute-providers architecture doc).
`ROOMOTE_INSTALL_SOURCE_DIR` copies deployment files from a local checkout
instead of GitHub for testing, and `GITHUB_TOKEN` authenticates API and raw
fetches while the repository is private.

The installer and `roomote upgrade` treat `https://get.roomote.dev` as a
mirror for the release lookup (`/latest-version`) and the deployment-file
fetches (`/raw/<ref>/<path>`), with direct GitHub as the fallback, so
`curl | bash` installs work while the source repository is private. The
mirror is a token-holding Vercel proxy under
[`deploy/get-roomote/`](../../deploy/get-roomote/README.md) with a strict
path allowlist; it is only used for the official repo (a `--repo` fork goes
straight to GitHub), and `ROOMOTE_FETCH_BASE` overrides the mirror URL.

[`deploy/host/roomote`](../../deploy/host/roomote) is installed to
`/usr/local/bin/roomote` and owns day-2 operations on the host:
`status`, `logs`, `setup-url`, `upgrade [version]`, `backup`,
`restore <file> --yes`, `restart`, `down`, and `up`. Its `upgrade` mirrors the
`roomote-deploy upgrade` remote sequence (refresh deployment files, rewrite
deployment-owned env metadata including the Modal image sync rule, stop the
controller, pull, `up -d --wait`), so a host installed by either path can be
upgraded by either tool.

`SETUP_TOKEN` gates the pre-auth `/setup` bootstrap wizard: the
`setupBootstrap` tRPC procedures are public, so without a token a freshly
deployed, publicly reachable instance could be configured by whoever visits
first. When `SETUP_TOKEN` is set, status is redacted and bootstrap saves are
rejected until the caller presents the token (`?token=` in the setup link or
manual entry); once setup completes the gate is moot because the bootstrap
surface closes. The token check lives in
[`apps/web/src/lib/server/setup-token.ts`](../../apps/web/src/lib/server/setup-token.ts)
and is enforced in the `setupBootstrap` commands in
[`apps/web/src/trpc/commands/setup-new/index.ts`](../../apps/web/src/trpc/commands/setup-new/index.ts).
Manual production deployments should set `SETUP_TOKEN` in `.env.production`;
the installer always generates one.

The installer's whole body is a `main` function invoked on the script's last
line, so bash parses the entire file before executing anything and a
`curl | bash` download truncated mid-transfer cannot run a partial install.
Keep new top-level logic inside `main`.

Validation for installer changes:

```bash
bash -n deploy/install.sh deploy/host/roomote
```

## V1 DigitalOcean Production Deployer

The V1 customer deployment flow lives under [`deploy/`](../../deploy/README.md)
and is intentionally separate from the product apps. It is the first repeatable
production path for self-hosted Roomote:

1. `deploy/scripts/roomote-deploy create` writes per-customer Terraform inputs
   and state under `deploy/state/<customer>/`.
2. `deploy/providers/digitalocean` provisions one Ubuntu droplet, a firewall,
   an operator SSH key or existing key fingerprint, optional DigitalOcean DNS
   records, an optional volume mounted at `/var/lib/docker`, and cloud-init.
3. Cloud-init installs Docker and the Compose plugin, creates `/opt/roomote`,
   and installs `roomote-compose.service`.
4. The create script copies `deploy/compose/docker-compose.prod.yml`,
   `deploy/caddy/Caddyfile`, and the operator dotenv file to `/opt/roomote`.
5. The remote stack pulls versioned GHCR images and starts through Docker
   Compose. Caddy is the only public container and listens on ports 80 and 443.

This path uses single-tenant isolation only: one customer slug maps to one VM,
one Compose project, and one database endpoint. Do not add tenant routing,
shared customer databases, billing state, or Kubernetes abstractions to this
path without creating a new architecture plan first.

The deployer rewrites deployment-owned metadata in `/opt/roomote/.env` from the
CLI inputs so placeholder values in the operator template cannot override the
selected customer domain or image tag:

| Key                          | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `ROOMOTE_VERSION`            | Immutable GHCR image tag                                       |
| `ROOMOTE_APP_DOMAIN`         | Caddy app host and Roomote public URL                          |
| `ROOMOTE_PREVIEW_DOMAIN`     | Caddy preview host and wildcard preview root                   |
| `TRPC_URL`                   | Public API base URL used by workers, including `/_roomote-api` |
| `IMAGE_REGISTRY`             | Registry host, normally `ghcr.io`                              |
| `IMAGE_NAMESPACE`            | Registry namespace, normally `roocodeinc`                      |
| `DOCKER_WORKER_IMAGE`        | Worker sandbox image matching the app tag                      |
| `DOCKER_WORKER_RELEASE_PATH` | Versioned controller-local worker archive matching the app tag |
| `MODAL_BASE_IMAGE_REF`       | Modal worker image when blank or previously deployer-managed   |
| `ROOMOTE_DATABASE_MODE`      | Operator metadata: `local` or `external`                       |
| `COMPOSE_PROFILES`           | Enables local Postgres with `local-postgres`                   |

`deploy/compose/docker-compose.prod.yml` is the GHCR image Compose file for the
VM. It differs from `docker-compose.production.yml`, which remains the
repo-checkout build overlay for local production-style self-host testing. The
GHCR Compose file includes local Postgres through the `local-postgres` profile
by default via the deployer, supports external Postgres by passing
`--database external` plus `DATABASE_URL`, and still starts local Redis and
MinIO for V1 unless those URLs are explicitly redirected.
The controller service intentionally has a long `stop_grace_period` because it
may be inside a hosted-provider spawn when Compose replaces the container. Keep
that grace period longer than the Modal create/bootstrap/worker-launch timeout
envelope so deploys do not abandon `dequeued` jobs before the controller can
finish or fail the spawn.

Use a separate preview env file for `develop` soak deployments and keep the
production env file for `main` releases. The preview deployment should use a
different customer slug, domain set, database, storage bucket, auth keypairs,
GitHub App callback/webhook settings, and Terraform state. Both env files can
start from `.env.production.example`; the boundary is the target environment and
secret set, not a separate Compose schema. Set `APP_ENV=preview` in the develop
env file and deploy the `develop-<short-sha>` image tag produced by the GHCR
workflow. Production can omit `APP_ENV` or set `APP_ENV=production` and should
deploy immutable `v*` image tags. Both environments still use
`NODE_ENV=production` because the deployed containers are production builds.

The `Publish GHCR Images` workflow auto-deploys the preview droplet after all
`develop-<short-sha>` images publish successfully. That deploy job runs in the
GitHub `preview` environment, uses the environment-scoped
`ROOMOTE_PREVIEW_SSH_PRIVATE_KEY`, pinned `ROOMOTE_PREVIEW_KNOWN_HOSTS`, and
preview host/customer variables, then calls `roomote-deploy upgrade` with the
same immutable `develop-<short-sha>` tag. Keep the `preview` environment
restricted to the `develop` branch and keep the deployment serialized through
the workflow's `preview-deploy` concurrency group.

The same workflow has an optional `deploy-railway` job that keeps a Railway
deployment current with every develop build. It is gated on the repository
variable `ROOMOTE_RAILWAY_AUTODEPLOY=true` (skipped otherwise) and runs in the
GitHub `railway` environment with a single environment-scoped secret,
`ROOMOTE_RAILWAY_PROJECT_TOKEN` — a Railway project token that can only touch
one environment. The job calls Railway's public GraphQL API directly
(`Project-Access-Token` header): it resolves the environment from the token,
matches services whose image starts with `ghcr.io/<owner>/roomote-app`, then
issues `serviceInstanceUpdate` with the immutable `develop-<short-sha>` tag
and `serviceInstanceDeploy` for each. There is no intermediary service and no
public endpoint. The operator runbook is the "Auto-deploying every develop
build" section of `deploy/railway/README.md`.

Upgrade and rollback are intentionally tag switches. `roomote-deploy upgrade`
copies the new Compose/Caddy files, removes stale systemd loading of bootstrap
`deployment.env`, validates the current remote Compose config, and stops the
controller before rewriting deployment metadata. It then edits
`/opt/roomote/.env`, changes `ROOMOTE_VERSION` and `DOCKER_WORKER_IMAGE`, points
`DOCKER_WORKER_RELEASE_PATH` at the matching versioned archive packaged inside
the controller image, and syncs `MODAL_BASE_IMAGE_REF` to the same worker image
when the Modal image is blank or still equals the previously deployed worker
image, regardless of the env file's `DEFAULT_COMPUTE_PROVIDER` (the wizard
stores the selected provider in the database, not the env file). A different
non-empty Modal image is treated as an explicit operator override. The upgrade
then validates the next Compose
config, pre-pulls the worker image through the host Docker client, and runs
`docker compose pull` plus
`docker compose up -d --wait --wait-timeout 600`. Stopping the controller before
image pulls keeps newly created tasks queued during rollout instead of letting
the old controller claim them. The longer wait budget is paired with the
controller `stop_grace_period`: already-active hosted-provider spawns should
finish or fail during replacement instead of being abandoned as `dequeued` jobs.
The GHCR Compose file has healthchecks for `web`, `api`, and `preview-proxy`,
so deploys fail fast when a new app container does not become healthy. After a
successful `up --wait`, both `roomote-deploy create` and
`roomote-deploy upgrade` run release-count Docker image retention through
[`deploy/scripts/prune-release-images.sh`](../../deploy/scripts/prune-release-images.sh).
The retention step always keeps the current `ROOMOTE_VERSION`, then keeps the
newest local Roomote image tags until the retained set reaches
`ROOMOTE_IMAGE_RETENTION_RELEASES` total tags (default `3`). It removes older
unused `ghcr.io/<namespace>/roomote-*` image references. Docker still protects
images used by running or stopped containers, so rollback depth is controlled
by retained release tags rather than by wall-clock age. Operators can pass
`--image-retention-releases <n>` to the workstation deployer or set
`ROOMOTE_IMAGE_RETENTION_RELEASES` for CI and the installed host CLI. Retention
is best-effort after a healthy rollout: cleanup failures warn but do not fail
the completed deploy or upgrade. This is a single-host downtime mitigation, not
true blue/green: old and new app containers are not both kept in service behind
Caddy. Rollback uses the same command with the prior tag.

Backups use a transient `postgres:17.5` client container on the
`roomote_default` network:

```bash
docker run --rm --network roomote_default --env-file /opt/roomote/.env \
  postgres:17.5 sh -c 'pg_dump --clean --if-exists --no-owner --no-privileges "$DATABASE_URL"'
```

The deployer copies dumps from `/opt/roomote/backups/` into
`deploy/state/<customer>/backups/`. Restores are explicit and require `--yes`;
both `roomote-deploy restore` and the host CLI's `roomote restore` first stop
the app services (web, api, controller, bullmq, preview-proxy) so live
connections are not killed mid-restore and nothing writes during the load,
then drop and recreate the `public` schema, pipe the dump through
`psql -v ON_ERROR_STOP=1`, and bring the stack back with
`up -d --wait`.

Keep real customer env files, Terraform state, and backup dumps out
of git. The root `.gitignore` excludes `deploy/state/`, Terraform local state,
and local provider cache files for this reason.

## Environment Files

Local development can start from schema defaults plus optional `.env.local`
overrides. `.env.local.example` documents operator-owned credentials for auth
providers, integrations, model providers, and callback URLs.

Local Roomote startup reads schema defaults plus optional `.env.local`
overrides. Hosted deployment packaging should be introduced as a self-hosted
surface with its own environment contract instead of using the Roomote Fly
deployment matrix as the default.

## Worker Release Archive

Local sandbox execution still uses the worker release archive contract. The
archive is built locally by `scripts/build-worker-release.sh` and managed during
`pnpm dev` by `apps/dev`.

Useful commands:

```bash
./scripts/build-worker-release.sh local-test --output-dir releases
pnpm dev --skip-worker-release-build
pnpm dev --use-release --worker-release-channel preview --worker-release-version 0.0.371-preview.1
```

The GitHub Actions workflows no longer publish stable or preview worker
releases automatically. Treat `--use-release` as an advanced compatibility path
for consuming an already-published release, not as the default local flow.

## Upgrade Notes

### Worker image user rename (vercel-sandbox → roomote)

The worker image's Linux user was renamed from `vercel-sandbox` to
`roomote` (home `/home/roomote`) together with the Vercel Sandbox provider
removal. This is a **coordinated image + code change**: adapters inject the
new user's HOME/PATH into every command, so new code requires worker images
built from the same (or newer) commit.

- Rebuild and republish the worker image, then point `DOCKER_WORKER_IMAGE`,
  `MODAL_BASE_IMAGE_REF`, `E2B_TEMPLATE_ID`, and `DAYTONA_SNAPSHOT_NAME` at
  artifacts built from the new image. The installer/deployer-managed Modal
  ref rolls forward automatically; E2B/Daytona artifacts re-provision from
  setup or the publish skill.
- Environment and task snapshots created from old-user images will not
  resume correctly under new code (tooling lives under the old home).
  Refresh environment snapshots after upgrading; in-flight resumable tasks
  should be finished on the old release first.

The Vercel Sandbox compute provider has been removed. Deployments upgrading
across that removal should know:

- Historical `cloud_jobs` rows with `vendor = 'sandbox'` are inert history:
  Roomote can no longer stream logs from or tear down those machines because
  the provider credentials and client were removed. Any remote Vercel
  sandboxes still running must be cleaned up in the Vercel dashboard.
- Migration `0021_bumpy_the_santerians.sql` rebuilds the three cloud_jobs
  sleep-check partial indexes without the `sandbox` vendor predicate.
- `VERCEL_SANDBOX_ACCESS_TOKEN` and `VERCEL_SANDBOX_BASE_IMAGE_SNAPSHOT_ID`
  are no longer read and can be dropped from env files.

## Versioning And Release Promotion

Roomote uses a **single product version** for the monorepo (not per-package npm
releases). Package.json `version` fields move in lockstep via
[Changesets](https://github.com/changesets/changesets) with a fixed `@roomote/*`
group. The canonical version is the root `package.json` field and appears in
GitHub Releases as `vX.Y.Z`.

Contributor entrypoint (optional; not enforced by CI):

```bash
pnpm changeset
```

Any `@roomote/*` package selection is equivalent under the fixed group. See
[`.changeset/README.md`](../../.changeset/README.md).

### Release automation

1. **Version PR on `develop`** (`.github/workflows/release.yml`): on each push
   to `develop`, `changesets/action` opens or refreshes a single PR titled
   `Release Roomote` when pending `.changeset/*.md` files exist. Merging it
   runs `pnpm run version` (aggregates the root `CHANGELOG.md`, runs
   `changeset version`, syncs the root version, updates the lockfile).
2. **Promote PR to `main`**: after the Version PR merges (no remaining pending
   changesets and the product version is untagged), the same workflow opens or
   refreshes a PR `develop` → `main` titled `Promote vX.Y.Z to production`.
   Merge it with a **merge commit** (do not squash or rebase) so history stays
   shared.
3. **Tag + GitHub Release on `main`** (`.github/workflows/tag-release.yml`):
   when `main` receives an untagged version, the workflow creates annotated tag
   `vX.Y.Z` and a GitHub Release marked latest (body from the matching
   `CHANGELOG.md` section). The existing publish workflow then builds production
   images.

### Secrets and branch rules

- Prefer repository secret `RELEASE_BOT_TOKEN` (GitHub App installation token or
  fine-grained PAT with `contents: write` and `pull-requests: write`). Workflows
  fall back to `GITHUB_TOKEN`, but that path does not re-trigger
  `publish-ghcr.yml` after a tag push and often does not run CI on bot-opened
  PRs.
- Protect `main`: require a pull request, require green CI, and prefer
  merge-commit-only for promote PRs.
- Product `v*` releases must stay the only **non-prerelease** GitHub Releases
  so `releases/latest` (used by `deploy/install.sh` / get.roomote.dev) stays on
  the product version. Manual `scripts/build-worker-release.sh --publish`
  releases are **always** prerelease for that reason.

Hotfixes follow the same path: land on `develop` (with a changeset when the
changelog should capture the fix), merge the Version PR if needed, then merge
the Promote PR. Image rollback remains a `roomote-deploy upgrade` tag switch to
a prior `v*` or `main-<sha>` image.

## CI And Image Publishing

`.github/workflows/CI.yml` validates code changes:

- lint
- knip
- typecheck
- unit tests with Postgres and Redis service containers
- a Docker build check for the shared app image (`.docker/app/Dockerfile`)

CI does not migrate hosted databases, deploy Fly apps, publish worker releases,
or post Slack notifications.

`.github/workflows/publish-ghcr.yml` publishes images to GHCR on pushes to
`develop`, `main`, pushed `v*` tags, and manual dispatch with an explicit version
input. A `develop` push publishes `develop-<short-sha>` tags and the mutable
`develop` channel alias with `APP_ENV=preview`. A `main` push publishes
`main-<short-sha>` and the `main` channel. `v*` tag pushes publish that tag with
`APP_ENV=production` and move the mutable `latest` channel alias. Manual
dispatch publishes no alias so re-publishing an old version never moves a
channel backwards. It builds and pushes multi-arch (linux/amd64 + linux/arm64)
images:

- `roomote-app` (shared image for web, api, controller, bullmq, preview-proxy,
  and the db-migrate one-shot)
- `roomote-worker`

Each architecture builds on a native runner (`blacksmith-4vcpu-ubuntu-2404`
and its `-arm` variant) and pushes by digest; a per-image publish job then
assembles the digests into one manifest under the version tag and channel
alias with `docker buildx imagetools create`. Never build these images under
QEMU emulation: rustc segfaults during the worker toolchain install
(rust-lang/rust#147026). Tags only exist once the manifest job completes, so
downstream jobs must depend on `publish`, not `build`.

Layer caching uses Blacksmith's persistent builder
(`useblacksmith/setup-docker-builder` + `useblacksmith/build-push-action`),
which mounts an NVMe layer cache per repo/Dockerfile/arch on the runner. Do
not add `type=gha` `cache-from`/`cache-to` directives back: these images
overflow GitHub's 10GB per-repo Actions cache and its per-ref scoping, so
every build missed cache and paid a multi-minute cache export on top.

Published bundles are hardened against source disclosure: the tsup configs for
api, controller, bullmq, preview-proxy, and worker minify when
`NODE_ENV=production` (with `keepNames` so error/class names survive), and the
app Dockerfile build stages plus `scripts/build-worker-release.sh` delete
`*.map` files after the optional Sentry sourcemap upload. Sourcemaps embed the
original TypeScript via `sourcesContent`, so they must be stripped inside the
build stages (not the runtime stage) and excluded from worker release archives
to stay out of published layers. Sentry symbolication is unaffected because it
uses the uploaded maps plus injected Debug IDs.

The workflow refuses an empty, `latest`, or syntactically invalid image tag.
Treat the tag as the deployment contract used by
`deploy/compose/docker-compose.prod.yml`; do not point the production deployer
at mutable tags.

The shared `.github/actions/setup-environment` action only installs Node, pnpm,
workspace dependencies, and optional Turborepo cache. It intentionally no longer
installs `flyctl`.

## Validation

Before pushing infrastructure changes, run:

```bash
pnpm lint:fast
pnpm check-types:fast
pnpm knip
```

For deployer-only changes, also run:

```bash
bash -n deploy/scripts/*.sh deploy/scripts/roomote-deploy
terraform fmt -check -recursive deploy/providers/digitalocean
docker compose --env-file <test-env> -f deploy/compose/docker-compose.prod.yml config
pnpm exec prettier --check deploy/README.md .github/workflows/publish-ghcr.yml deploy/compose/docker-compose.prod.yml
```

Run targeted package tests for code touched by the change. For guidance-only
updates, run:

```bash
pnpm knowledge:check <changed-guidance-files>
```

After starting the local stack, run `pnpm run doctor` to verify Docker
Postgres/Redis/MinIO, either PM2 dev services or self-host Compose application
containers, web/API/controller health, preview proxy, BullMQ, public callback
URL shape, and optional auth/model-provider configuration.
