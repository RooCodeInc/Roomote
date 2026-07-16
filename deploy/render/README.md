# Running Roomote on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/RooCodeInc/Roomote)

This guide covers deploying Roomote on [Render](https://render.com) as a
Blueprint. The maintained service specification lives in
[`render.yaml`](../../render.yaml) at the repository root — Render's deploy
button and Blueprint sync read it from there directly, which is why the
Blueprint file does not live in this directory.

For single-host Docker deployments, use the one-command installer or the
Compose paths in [SELF_HOSTING.md](../../SELF_HOSTING.md) instead. For the
other PaaS paths, see [deploy/railway](../railway/README.md) and
[deploy/coolify](../coolify/README.md).

## How the Render shape differs from single-host

- **No Caddy edge.** Render terminates HTTPS and gives every web service its
  own public `onrender.com` domain. The web app and the API run on separate
  origins, so `TRPC_URL` points at the api service's public domain with no
  `/_roomote-api` path prefix. GitHub webhooks and hosted-sandbox workers
  call that API origin directly, and Slack webhooks arrive at the web origin
  and are proxied to the API internally.
- **No Docker socket.** The `docker` sandbox provider cannot run on Render.
  Task execution must use a hosted sandbox provider: Modal (Blueprint
  default), E2B, or Daytona. Those only need outbound HTTPS plus API
  credentials. The Blueprint sets `EXCLUDED_COMPUTE_PROVIDERS=docker` so the
  unusable provider never appears in setup or sandbox selection.
- **No openssl provisioning step.** The Blueprint sets
  `R_AUTO_GENERATE_KEYS=true`, so Roomote generates the `JOB_AUTH_*` /
  `PREVIEW_AUTH_*` P-256 keypairs at first boot and persists them encrypted
  (with `ENCRYPTION_KEY`) in Postgres. Every other secret is a
  `generateValue: true` variable that Render generates at deploy time.
- **Shared secrets are defined once.** The `roomote-shared` environment
  group holds every value that must match across services; Render generates
  each secret once and all services referencing the group see the same
  value, so `ENCRYPTION_KEY` is identical everywhere. The MinIO password is
  the one exception: environment groups cannot reference services, so MinIO
  owns the generated `MINIO_ROOT_PASSWORD` and the app services mirror it
  into `S3_SECRET_ACCESS_KEY` with a `fromService` reference.
- **URL variables are composed at startup.** Render Blueprints can wire a
  service's hostname into an environment variable but cannot build the
  `https://<hostname>` string, so each app service receives host-only
  references (`ROOMOTE_WEB_HOST`, `ROOMOTE_API_HOST`, `ROOMOTE_MINIO_HOST`,
  `ROOMOTE_MINIO_HOSTPORT`) and the image's entrypoint dispatcher derives
  the URL-shaped variables (`R_APP_URL`, `TRPC_URL`, `S3_ENDPOINT`,
  `S3_PRESIGN_ENDPOINT`) from them when they are unset.
- **The setup wizard is token-gated by default.** `onrender.com` domains are
  publicly reachable, so the Blueprint generates `SETUP_TOKEN`. Copy it from
  the `roomote-shared` environment group in the Render dashboard to open
  `/setup`.
- **Provider credentials live in the app, not the Blueprint.** The Blueprint
  ships with zero deploy-time inputs. Modal tokens and the model provider
  API key are entered in the `/setup` wizard (or Settings) after first boot
  and stored encrypted in Postgres.
- **Live previews are off by default.** Preview subdomains need a wildcard
  domain, and `onrender.com` domains are single-label. Previews can be
  enabled later with a wildcard custom domain (see below); everything else
  works without them.

## What you need

- A Render account. The Blueprint uses paid instance types (Render's free
  tier has no background workers, persistent disks, or pre-deploy
  commands).
- A hosted sandbox account: [Modal](https://modal.com) (default),
  [E2B](https://e2b.dev), or [Daytona](https://daytona.io).
- A model provider API key, for example OpenRouter (entered in the setup
  wizard, not at deploy time).

## Deploy

Click the **Deploy to Render** button at the top of this guide (or create a
new Blueprint in the Render dashboard and point it at this repository).
Render reads [`render.yaml`](../../render.yaml), shows the services it will
create, and provisions everything on approve: Postgres, Key Value (Redis),
MinIO with a persistent disk, the api and web services, and the controller
and bullmq background workers.

After the first deploy, verify the hostname wiring before onboarding: the
Blueprint composes its URLs from cross-service `RENDER_EXTERNAL_HOSTNAME`
references, so open one app service's Environment tab and confirm
`ROOMOTE_WEB_HOST`, `ROOMOTE_API_HOST`, and `ROOMOTE_MINIO_HOST` resolved to
real hostnames (see
[Maintaining the template](#maintaining-the-template)). If they are empty,
set the three values manually to the services' `onrender.com` hostnames and
redeploy.

A service can also lose this race only on its very first boot: its
container snapshots the environment before the referenced hostname has
propagated, and the service crash-loops logging
`❌ Invalid environment variables` with a composed URL reported as
`Required` — even though the Environment tab already shows the resolved
hostname. The stored value is fine; the running container just predates
it. The entrypoint dispatcher heals the self-referencing case on its own
(a service's own hostname falls back to the Render-injected
`RENDER_EXTERNAL_HOSTNAME`), so only a cross-service reference can still
hit this. Fix it with **Manual Deploy → Deploy latest reference** on the
affected service to take a fresh environment snapshot.

After the first deploy, also consider disabling **Auto-Sync** on the
Blueprint (Blueprint settings in the Render dashboard). With Auto-Sync on,
Render re-applies `render.yaml` whenever the tracked branch moves, which
keeps your deployment aligned with upstream template changes but can also
apply changes you have not reviewed.

## Image access

Both published images (`ghcr.io/roocodeinc/roomote-app` and
`ghcr.io/roocodeinc/roomote-worker`) are public. Render pulls the app image
anonymously, and hosted sandbox providers (Modal's remote builder,
E2B/Daytona worker builds) pull the worker image anonymously; no registry
credentials are needed. MinIO comes from Docker Hub.

## Image channel and versions

The Blueprint tracks the mutable **`:main`** alias (stable main-branch
builds), which the publish workflow moves on every build of `main`
(releases also move `:latest`). This matches the stable channel used by
the Railway deploy button. Nothing else in the Blueprint encodes a
version:

- The images bake `RELEASE_VERSION` at build time, and the app derives
  `DOCKER_WORKER_IMAGE` and `MODAL_BASE_IMAGE_REF` from it when those are
  unset. Set them only to override the derived worker image.
- The controller reads the worker release version from the `VERSION` file
  inside `worker-current.tar.gz`, so `DOCKER_WORKER_RELEASE_PATH` is a
  constant.

Render does not redeploy when a mutable alias moves. To pick up a new
main build, redeploy the four app services from the dashboard (Manual
Deploy → Deploy latest reference). To pin instead (recommended for
production deployments): put the same immutable tag (`v*` or
`main-<sha>`) in the four app-service `image.url` fields. No other edits
are needed — the derived values follow the image.

MinIO is the exception: the Blueprint pins it to an immutable `RELEASE.*`
tag and manifest digest because the service owns the artifact disk, and a
mutable `latest` tag could pull an unreviewed breaking change on redeploy. Bump the pin
deliberately, ideally right after a disk backup.

## Service topology

| Render service       | Type      | Source                       | Public domain             | Healthcheck          |
| -------------------- | --------- | ---------------------------- | ------------------------- | -------------------- |
| `roomote-postgres`   | Postgres  | Render managed PostgreSQL 17 | no                        | managed              |
| `roomote-redis`      | Key Value | Render managed (Redis API)   | no (empty `ipAllowList`)  | managed              |
| `roomote-minio`      | web       | `minio/minio` + disk `/data` | yes (routed to port 9000) | `/minio/health/live` |
| `roomote-api`        | web       | `roomote-app:main`           | yes                       | `/health/liveness`   |
| `roomote-web`        | web       | `roomote-app:main`           | yes                       | `/health`            |
| `roomote-controller` | worker    | `roomote-app:main`           | no                        | —                    |
| `roomote-bullmq`     | worker    | `roomote-app:main`           | no                        | —                    |

Render's `dockerCommand` **bypasses the image entrypoint** and executes the
command directly, so every app service uses the full
`/roomote/.docker/app/entrypoint.sh <service>` form to select its process
through the image's entrypoint dispatcher. Keep these commands quote-free:
Render's `dockerCommand` parser passes quote characters through literally
instead of stripping them, so a `/bin/sh -c '...'` wrapper reaches the
shell as one quoted word and the service exits with status 127. The
dispatcher itself composes the URL variables (see
[Environment variables](#environment-variables)). The api service's
**pre-deploy command** is `/roomote/.docker/app/entrypoint.sh db-migrate`,
so schema migrations run before each new deploy starts serving. On a fresh
Blueprint the other app services boot in parallel with that first migration
pass and wait for it with bounded backoff (up to ~90 seconds, logging one
`[auth-keypairs]` waiting-for-migrations line per retry) instead of
crash-looping; Render's restart behavior still recovers them in the rare
case migrations take longer.

The web and api services honor Render's injected `PORT`. The minio service
pins `PORT=9000` so Render routes its public domain to the S3 API (the
console on 9001 is not exposed).

## Environment variables

Shared values live in the **`roomote-shared`** environment group (visible
under Environment Groups in the Render dashboard, where you can read
`SETUP_TOKEN` and `DASHBOARD_PASSWORD` after the first deploy):

```sh
R_APP_ENV=production
ROOMOTE_DOCKER_LOAD_ENV_FILE=false
R_AUTO_GENERATE_KEYS=true
ENCRYPTION_KEY=<generateValue>
ARTIFACT_SIGNING_KEY=<generateValue>
DASHBOARD_PASSWORD=<generateValue>
SETUP_TOKEN=<generateValue>
S3_ACCESS_KEY_ID=roomote
S3_REGION=us-east-1
S3_BUCKET_ARTIFACTS=roomote-artifacts
S3_AUTO_CREATE_BUCKET=true
DEFAULT_COMPUTE_PROVIDER=modal
EXCLUDED_COMPUTE_PROVIDERS=docker
DOCKER_WORKER_RELEASE_PATH=/roomote/releases/worker-current.tar.gz
```

Each app service additionally references:

```sh
DATABASE_URL=<fromDatabase roomote-postgres>
REDIS_URL=<fromService roomote-redis>
S3_SECRET_ACCESS_KEY=<fromService roomote-minio MINIO_ROOT_PASSWORD>
ROOMOTE_WEB_HOST=<fromService roomote-web RENDER_EXTERNAL_HOSTNAME>
ROOMOTE_API_HOST=<fromService roomote-api RENDER_EXTERNAL_HOSTNAME>
ROOMOTE_MINIO_HOST=<fromService roomote-minio RENDER_EXTERNAL_HOSTNAME>
ROOMOTE_MINIO_HOSTPORT=<fromService roomote-minio host:port>
```

and the image's entrypoint dispatcher composes the URL-shaped values from
those host references at startup (explicitly set values always win):

```sh
R_APP_URL=https://$ROOMOTE_WEB_HOST
TRPC_URL=https://$ROOMOTE_API_HOST
S3_ENDPOINT=http://$ROOMOTE_MINIO_HOSTPORT
S3_PRESIGN_ENDPOINT=https://$ROOMOTE_MINIO_HOST
```

The `roomote-shared` group also sets
`DOCKER_WORKER_RELEASE_PATH=/roomote/releases/worker-current.tar.gz`, which
only the controller reads. The worker release archive is baked into the app
image, and the controller uploads it into hosted sandboxes at spawn
time — no shared volume is needed. The version-less `worker-current.tar.gz`
name works
because the controller reads the release version from the `VERSION` file
inside the archive. Do not remove it: without it the controller falls back
to fetching GitHub worker releases, which do not exist for `develop` builds.

Notes:

- `R_APP_URL` is composed from the web service's hostname — it is the
  origin users browse. Do not set `R_PUBLIC_URL` — it is optional and
  the app falls back to `R_APP_URL` everywhere it would apply. See
  [Attaching a custom domain](#attaching-a-custom-domain).
- Leave `DOCKER_WORKER_IMAGE` and `MODAL_BASE_IMAGE_REF` **unset**. The app
  derives both from the `RELEASE_VERSION` baked into the running image, so
  they always match the deployed build. Setting them explicitly overrides
  the derivation and silently pins the worker to whatever version the value
  encodes.
- `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and model provider keys such as
  `OPENROUTER_API_KEY` are **not** Blueprint variables. Enter them in the
  `/setup` wizard (or Settings → Sandboxes / Models) after first boot; they
  are stored encrypted in Postgres. Setting them as env vars still works
  and takes precedence, but is unnecessary.
- Leave `JOB_AUTH_*` and `PREVIEW_AUTH_*` unset —
  `R_AUTO_GENERATE_KEYS=true` manages them. If you later provide
  explicit env values, they take precedence over the persisted keypairs.
- Leave `PREVIEW_PROXY_BASE_URL` and `PREVIEW_DOMAINS` unset unless you
  enable live previews. Roomote boots without them; previews report as not
  configured in **Settings → Live Previews** until set.

## The artifact bucket

MinIO does not auto-create buckets, so the Blueprint sets
`S3_AUTO_CREATE_BUCKET=true`: at boot, the api creates the artifacts bucket
when it is missing. Nothing to do after the first deploy — watch for
`[artifacts-bucket] Created S3 bucket ...` in the api service's logs.

Presigned artifact URLs use the minio service's public domain
(`S3_PRESIGN_ENDPOINT`), so hosted-sandbox workers and browsers can download
artifacts directly. Alternatively, skip bundled MinIO entirely and point the
S3 values at an external S3-compatible store (AWS S3 or Cloudflare R2, with
`S3_REGION=auto` for R2). Roomote uses path-style addressing, and
`S3_PRESIGN_ENDPOINT` must be reachable from hosted-sandbox workers. On an
external store, either pre-create the bucket and remove
`S3_AUTO_CREATE_BUCKET`, or keep the flag if the configured credentials are
allowed to create buckets (the api only logs a warning when creation fails).

## First boot

1. Wait for `roomote-web` and `roomote-api` to report live. On a brand-new
   Blueprint the first boot also generates and persists the auth keypairs
   (watch for `[auth-keypairs] Generated ...` in an app service's logs —
   whichever app service boots first wins the race and generates them).
2. Copy `SETUP_TOKEN` from the `roomote-shared` environment group and open
   `https://<web-domain>/setup?token=<SETUP_TOKEN>` (or paste the token into
   the wizard's token step).
3. Create the founding admin account (email/password works immediately;
   Slack or Microsoft sign-in can be added later).
4. Connect GitHub with **Create GitHub App** — the manifest flow derives the
   callback and webhook URLs from `R_APP_URL` and `TRPC_URL`, so no
   manual URL entry is needed.
5. Enter the sandbox provider credentials (Modal token pair for the default)
   and the model provider key when the wizard asks. When swapping to E2B or
   Daytona instead, the wizard and **Settings → Sandboxes** can build the E2B
   template or Daytona snapshot in your provider account after credentials
   are saved.
6. Pick repositories, create an environment, and run a small task end to end
   (the SELF_HOSTING.md verification checklist applies from step 2 onward).

## Attaching a custom domain

The Blueprint boots on `onrender.com` domains, and `R_APP_URL` — the
origin users browse — is composed from the web service's
`RENDER_EXTERNAL_HOSTNAME`. Render does **not** change that variable when
you attach a custom domain (it is always the service's `onrender.com`
hostname), so the app keeps treating the generated domain as canonical. The
symptom is a working dashboard that rejects signup, login, and OAuth flows
with `403 {"error":"Invalid origin"}`: the browser sends the custom domain
as its `Origin`, and the auth layer only trusts `R_APP_URL`.

The explicit fix:

1. Add the custom domain (for example `app.example.com`) to the
   **roomote-web** service in Render and complete the DNS setup.
2. On each app service (api, web, controller, bullmq), override
   `ROOMOTE_WEB_HOST=app.example.com` in the service's Environment tab
   (replacing the Blueprint-managed reference) and let the services
   redeploy.

Everything derived from the canonical origin follows: auth origins, OAuth
callback URLs, and the absolute links Roomote posts to Slack, GitHub, and
other integrations. Connectors registered before the switch (for example a
GitHub App created by the wizard) keep the callback URLs they were created
with, so reconnect or update those in their provider settings if you change
the domain after onboarding.

Leave `ROOMOTE_API_HOST` on the api service's own domain — hosted-sandbox
workers and webhooks call it directly, and it never needs to match the
domain users browse. (A custom domain on the api or MinIO services works the
same way through `ROOMOTE_API_HOST` and `ROOMOTE_MINIO_HOST`.)

## Live previews (optional)

Live previews need a wildcard domain, which requires a domain you control:

1. Add a `roomote-preview-proxy` web service to the Blueprint (or from the
   dashboard) using the same image, the same environment references as the
   other app services, the `dockerCommand`
   `/roomote/.docker/app/entrypoint.sh preview-proxy`, and healthcheck
   path `/health`.
2. Point `previews.<your-domain>` and `*.previews.<your-domain>` at Render
   as custom domains on that service, following Render's wildcard custom
   domain docs.
3. Add `PREVIEW_PROXY_BASE_URL=https://previews.<your-domain>`,
   `NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL=https://previews.<your-domain>`, and
   `PREVIEW_DOMAINS=previews.<your-domain>` to the `roomote-shared`
   environment group. The `NEXT_PUBLIC_` variant is what the web client uses
   to build preview links, so the `roomote-web` service must have it.
4. Opt in from **Settings → Live Previews**, which validates the wildcard
   hostname and enables previews per deployment and environment.

## Upgrades, backups, and costs

- **Upgrade a deployment on `:main`** by redeploying the four app
  services — they pull the current alias, and everything version-coupled
  derives from the new image. On an immutable pin, bump the tag in the four
  `image.url` fields first (via Blueprint sync or the dashboard). The api
  service's `db-migrate` pre-deploy applies any schema changes, and the
  auto-generated keypairs persist in Postgres, so sessions, job tokens, and
  preview tokens survive redeploys.
- **One-time Discord gateway secret (existing Blueprints).** New deploys
  generate `R_DISCORD_GATEWAY_SECRET` in the `roomote-shared` env group.
  Blueprint sync on an older workspace may not invent a new generated secret
  for an already-created group; if Discord was using `ENCRYPTION_KEY` before,
  add `R_DISCORD_GATEWAY_SECRET` once to the shared group (Generate value or
  a random string) so web/api/controller/bullmq all see the same value
  before continuing Discord after this hardening ships.
- **Back up** the Render Postgres database (Render's built-in backups or
  `pg_dump`) and the MinIO disk or external bucket. Everything else is
  reproducible from the Blueprint plus the generated environment group
  values.
- **Costs** split three ways: Render hosts the control plane (web, api,
  controller, bullmq, Postgres, Key Value, MinIO — all on paid instance
  types), while task execution bills through your sandbox provider
  (Modal/E2B/Daytona) and model usage bills through your model provider.
  Upgrade individual instance types from the dashboard as usage grows.

## Maintaining the template

When the Blueprint needs to change, edit [`render.yaml`](../../render.yaml)
at the repository root and re-run the first-boot verification on a scratch
Render workspace before merging. The verification must confirm that the
cross-service `RENDER_EXTERNAL_HOSTNAME` references resolve — open each app
service's Environment tab and check that `ROOMOTE_WEB_HOST`,
`ROOMOTE_API_HOST`, and `ROOMOTE_MINIO_HOST` are real hostnames — and that
the composed URLs reach the running services (`/health` on web,
`/health/liveness` on api). Keep the file at the repository root: the
Deploy to Render button and Blueprint sync only read `render.yaml` from
there.
