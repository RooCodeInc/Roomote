# Running Roomote on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/bP3Lsu)

This guide covers deploying Roomote on [Railway](https://railway.com) — either
through the official Roomote template or by composing the services manually.
The maintained service specification for the official template lives in
[`template.yaml`](template.yaml); Railway does not read that file directly,
but it is the source of truth that maintainers mirror into Railway's Template
Composer.

For single-host Docker deployments, use the one-command installer or the
Compose paths in [SELF_HOSTING.md](../../SELF_HOSTING.md) instead.

## How the Railway shape differs from single-host

- **No Caddy edge.** Railway terminates HTTPS and gives every service its own
  public domain. The web app and the API run on separate origins, so
  `TRPC_URL` points at the api service's public domain with no
  `/_roomote-api` path prefix. GitHub webhooks and hosted-compute workers
  call that API origin directly, and Slack webhooks arrive at the web origin
  and are proxied to the API internally.
- **No Docker socket.** The `docker` compute provider cannot run on Railway.
  Task execution must use a hosted compute provider: Modal (template
  default), E2B, or Daytona. Those only need outbound HTTPS plus API
  credentials. The template sets `EXCLUDED_COMPUTE_PROVIDERS=docker` so the
  unusable provider never appears in setup or compute selection.
- **No openssl provisioning step.** The template sets
  `ROOMOTE_AUTO_GENERATE_KEYS=true`, so Roomote generates the `JOB_AUTH_*` /
  `PREVIEW_AUTH_*` P-256 keypairs at first boot and persists them encrypted
  (with `ENCRYPTION_KEY`) in Postgres. Every other secret is a random string
  that Railway's `${{secret(n)}}` template function generates.
- **No template-level shared variables.** Railway's Template Composer has no
  environment-level shared-variable store, so every value that must match
  across services is defined once on the **api** service and referenced from
  the other services as `${{api.NAME}}`. Never paste `${{secret(n)}}` into
  more than one service: each occurrence generates a different value, and
  `ENCRYPTION_KEY` must be identical everywhere.
- **Provider credentials live in the app, not the template.** The template
  ships with zero deploy-time inputs. Modal tokens and the model provider
  API key are entered in the `/setup` wizard (or Settings) after first boot
  and stored encrypted in Postgres.
- **Live previews are off by default.** Preview subdomains need a wildcard
  domain, and Railway-generated service domains are single-label. Previews
  can be enabled later with a wildcard custom domain (see below); everything
  else works without them.

## What you need

- A Railway account.
- A hosted compute account: [Modal](https://modal.com) (default),
  [E2B](https://e2b.dev), or [Daytona](https://daytona.io).
- A model provider API key, for example OpenRouter (entered in the setup
  wizard, not at deploy time).

## Image access

Both published images (`ghcr.io/roocodeinc/roomote-app` and
`ghcr.io/roocodeinc/roomote-worker`) are public. Railway pulls the app image
anonymously, and hosted compute providers (Modal's remote builder,
E2B/Daytona worker builds) pull the worker image anonymously; no registry
credentials or `MODAL_REGISTRY_USERNAME`/`MODAL_REGISTRY_PASSWORD` are
needed.

## Image channel and versions

The template tracks the mutable **`:develop`** alias, which the publish
workflow moves to every new develop build (releases also move `:latest`).
Nothing else in the template encodes a version:

- The images bake `RELEASE_VERSION` at build time, and the app derives
  `DOCKER_WORKER_IMAGE` and `MODAL_BASE_IMAGE_REF` from it when those are
  unset. Set them only to override the derived worker image.
- The controller reads the worker release version from the `VERSION` file
  inside `worker-current.tar.gz`, so `DOCKER_WORKER_RELEASE_PATH` is a
  constant.

To pin instead (recommended for production deployments): put the same
immutable tag (`v*` or `develop-<sha>`) in the four app-service image fields.
No other edits are needed — the derived values follow the image.

## Service topology

| Railway service | Source                            | Start command                                      | Public domain                | Healthcheck        |
| --------------- | --------------------------------- | -------------------------------------------------- | ---------------------------- | ------------------ |
| `Postgres`      | Railway managed PostgreSQL        | —                                                  | no                           | managed            |
| `Redis`         | Railway managed Redis             | —                                                  | no                           | managed            |
| `minio`         | `minio/minio` + volume at `/data` | `minio server /data --console-address :9001`       | yes (HTTP proxy port 9000)   | —                  |
| `web`           | `roomote-app:develop`             | `/roomote/.docker/app/entrypoint.sh web`           | yes (HTTP proxy port 8080)   | `/health`          |
| `api`           | `roomote-app:develop`             | `/roomote/.docker/app/entrypoint.sh api`           | yes (HTTP proxy port 8080)   | `/health/liveness` |
| `controller`    | `roomote-app:develop`             | `/roomote/.docker/app/entrypoint.sh controller`    | no                           | —                  |
| `bullmq`        | `roomote-app:develop`             | `/roomote/.docker/app/entrypoint.sh bullmq`        | no                           | —                  |
| `preview-proxy` | `roomote-app:develop` (optional)  | `/roomote/.docker/app/entrypoint.sh preview-proxy` | yes + wildcard custom domain | `/health`          |

Railway's custom start command **bypasses the image entrypoint** and executes
the command directly, so the full `/roomote/.docker/app/entrypoint.sh <service>`
form is required — a bare `web` fails with ``The executable `web` could not
be found``. The same applies to minio (`minio server ...`, not `server ...`)
and to the api pre-deploy command below.

- Rename the minio service to exactly **`minio`**: the default `minio/minio`
  name breaks `${{minio.RAILWAY_PRIVATE_DOMAIN}}` references.
- Set the api service's **pre-deploy command** to
  `/roomote/.docker/app/entrypoint.sh db-migrate` so schema migrations run
  before each new deploy starts serving. On a fresh project the other app
  services boot in parallel with that first migration pass and wait for it
  with bounded backoff (up to ~90 seconds, logging one `[auth-keypairs]`
  waiting-for-migrations line per retry) instead of crash-looping; Railway's
  restart policy still recovers them in the rare case migrations take longer.
- The HTTP proxy port becomes the Railway-injected `PORT`, which all app
  services honor. Any value works for web/api (the template uses 8080); the
  minio proxy must target 9000 (the S3 API — the console on 9001 is not
  exposed).

## Environment variables

The **api** service is the anchor: it defines every shared value once, and
the other app services reference them with `${{api.NAME}}`.

api:

```sh
APP_ENV=production
ROOMOTE_DOCKER_LOAD_ENV_FILE=false
ROOMOTE_AUTO_GENERATE_KEYS=true
ENCRYPTION_KEY=${{secret(32)}}
ARTIFACT_SIGNING_KEY=${{secret(32)}}
DASHBOARD_PASSWORD=${{secret(24)}}
S3_SECRET_ACCESS_KEY=${{secret(32)}}
S3_ACCESS_KEY_ID=roomote
S3_REGION=us-east-1
S3_BUCKET_ARTIFACTS=roomote-artifacts
S3_AUTO_CREATE_BUCKET=true
DEFAULT_COMPUTE_PROVIDER=modal
EXCLUDED_COMPUTE_PROVIDERS=docker
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
ROOMOTE_APP_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
TRPC_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
S3_ENDPOINT=http://${{minio.RAILWAY_PRIVATE_DOMAIN}}:9000
S3_PRESIGN_ENDPOINT=https://${{minio.RAILWAY_PUBLIC_DOMAIN}}
```

web and bullmq (identical block):

```sh
APP_ENV=${{api.APP_ENV}}
ROOMOTE_DOCKER_LOAD_ENV_FILE=${{api.ROOMOTE_DOCKER_LOAD_ENV_FILE}}
ROOMOTE_AUTO_GENERATE_KEYS=${{api.ROOMOTE_AUTO_GENERATE_KEYS}}
ENCRYPTION_KEY=${{api.ENCRYPTION_KEY}}
ARTIFACT_SIGNING_KEY=${{api.ARTIFACT_SIGNING_KEY}}
DASHBOARD_PASSWORD=${{api.DASHBOARD_PASSWORD}}
S3_SECRET_ACCESS_KEY=${{api.S3_SECRET_ACCESS_KEY}}
S3_ACCESS_KEY_ID=${{api.S3_ACCESS_KEY_ID}}
S3_REGION=${{api.S3_REGION}}
S3_BUCKET_ARTIFACTS=${{api.S3_BUCKET_ARTIFACTS}}
DEFAULT_COMPUTE_PROVIDER=${{api.DEFAULT_COMPUTE_PROVIDER}}
EXCLUDED_COMPUTE_PROVIDERS=${{api.EXCLUDED_COMPUTE_PROVIDERS}}
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
ROOMOTE_APP_URL=${{api.ROOMOTE_APP_URL}}
TRPC_URL=${{api.TRPC_URL}}
S3_ENDPOINT=${{api.S3_ENDPOINT}}
S3_PRESIGN_ENDPOINT=${{api.S3_PRESIGN_ENDPOINT}}
```

controller: the same block as web/bullmq **plus**

```sh
DOCKER_WORKER_RELEASE_PATH=/roomote/releases/worker-current.tar.gz
```

The worker release archive is baked into the app image, and the controller
uploads it into hosted-compute sandboxes at spawn time — no shared volume is
needed. The version-less `worker-current.tar.gz` name works because the
controller reads the release version from the `VERSION` file inside the
archive. Do not leave `DOCKER_WORKER_RELEASE_PATH` unset: without it the
controller falls back to fetching GitHub worker releases, which do not exist
for `develop` builds.

minio:

```sh
MINIO_ROOT_USER=${{api.S3_ACCESS_KEY_ID}}
MINIO_ROOT_PASSWORD=${{api.S3_SECRET_ACCESS_KEY}}
```

Notes:

- `ROOMOTE_APP_URL` on api is the **single canonical-origin knob**: it is the
  URL users browse, and web/controller/bullmq reference
  `${{api.ROOMOTE_APP_URL}}` rather than repeating the value. Do not set
  `ROOMOTE_PUBLIC_URL` — it is optional and the app falls back to
  `ROOMOTE_APP_URL` everywhere it would apply. See
  [Attaching a custom domain](#attaching-a-custom-domain).
- Leave `DOCKER_WORKER_IMAGE` and `MODAL_BASE_IMAGE_REF` **unset**. The app
  derives both from the `RELEASE_VERSION` baked into the running image, so
  they always match the deployed build. Setting them explicitly overrides
  the derivation and silently pins the worker to whatever version the value
  encodes — the exact multi-place version bump this template design removes.
- `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and model provider keys such as
  `OPENROUTER_API_KEY` are **not** template variables. Enter them in the
  `/setup` wizard (or Settings → Compute / Models) after first boot; they are
  stored encrypted in Postgres. Setting them as env vars still works and
  takes precedence, but is unnecessary.
- `SETUP_TOKEN` is optional and the template does not set it. When unset,
  the pre-auth `/setup` wizard is open until the founding admin account is
  created — on a publicly reachable Railway domain that is a short race
  window you accept in exchange for a simpler first-run. To gate the wizard,
  add `SETUP_TOKEN=${{secret(16)}}` on api: visitors to `/setup` are then
  prompted for the token, which the operator copies from the api service's
  variables panel. The URL form `/setup?token=<value>` also works.
- Leave `PREVIEW_PROXY_BASE_URL` and `PREVIEW_DOMAINS` unset unless you
  enable live previews. Roomote boots without them; previews report as not
  configured in **Settings → Live Previews** until set.
- Leave `JOB_AUTH_*` and `PREVIEW_AUTH_*` unset —
  `ROOMOTE_AUTO_GENERATE_KEYS=true` manages them. If you later provide
  explicit env values, they take precedence over the persisted keypairs.

## The artifact bucket

MinIO does not auto-create buckets, so the template sets
`S3_AUTO_CREATE_BUCKET=true` on api: at boot, the api creates the artifacts
bucket when it is missing. Nothing to do after the first deploy — watch for
`[artifacts-bucket] Created S3 bucket ...` in api's logs.

To create it manually instead (or if the automatic creation warned in the
logs), run once from any machine with
[`mc`](https://min.io/docs/minio/linux/reference/minio-mc.html):

```sh
mc alias set roomote https://<minio-public-domain> roomote <S3_SECRET_ACCESS_KEY>
mc mb --ignore-existing roomote/roomote-artifacts
```

The generated `S3_SECRET_ACCESS_KEY` value is on the api service's Variables
tab in the deployed project.

Alternatively, skip bundled MinIO entirely and point the S3 values at an
external S3-compatible store (AWS S3 or Cloudflare R2, with `S3_REGION=auto`
for R2). Roomote uses path-style addressing, and `S3_PRESIGN_ENDPOINT` must
be reachable from hosted-compute workers. On an external store, either
pre-create the bucket and remove `S3_AUTO_CREATE_BUCKET`, or keep the flag
if the configured credentials are allowed to create buckets (the api only
logs a warning when creation fails).

## First boot

1. Wait for `web` and `api` to report healthy. On a brand-new project the
   first boot also generates and persists the auth keypairs (watch for
   `[auth-keypairs] Generated ...` in an app service's logs — whichever app
   service boots first wins the race and generates them).
2. Open `https://<web-domain>/setup` (append `?token=<SETUP_TOKEN>` or paste
   the token into the wizard's token step if you configured one).
3. Create the founding admin account (email/password works immediately;
   Slack or Microsoft sign-in can be added later).
4. Connect GitHub with **Create GitHub App** — the manifest flow derives the
   callback and webhook URLs from `ROOMOTE_APP_URL` and `TRPC_URL`, so no
   manual URL entry is needed.
5. Enter the compute provider credentials (Modal token pair for the default)
   and the model provider key when the wizard asks. When swapping to E2B or
   Daytona instead, the wizard and **Settings → Compute** can build the E2B
   template or Daytona snapshot in your provider account after credentials
   are saved.
6. Pick repositories, create an environment, and run a small task end to end
   (the SELF_HOSTING.md verification checklist applies from step 2 onward).

## Attaching a custom domain

The template boots on Railway-generated domains, and `ROOMOTE_APP_URL` — the
origin users browse — derives from the web service's generated domain. When
you attach a custom domain to the web service, Railway does **not** update
`RAILWAY_PUBLIC_DOMAIN`, so the app keeps treating the generated domain as
canonical. The symptom is a working dashboard that rejects signup, login,
and OAuth flows with `403 {"error":"Invalid origin"}`: the browser sends the
custom domain as its `Origin`, and the auth layer only trusts
`ROOMOTE_APP_URL`.

The fix is a one-variable edit, because the app services all reference
`${{api.ROOMOTE_APP_URL}}`:

1. Add the custom domain (for example `app.example.com`) to the **web**
   service in Railway and complete the DNS setup.
2. On the **api** service, set `ROOMOTE_APP_URL=https://app.example.com` and
   accept Railway's prompt to redeploy the app services.

Everything derived from the canonical origin follows: auth origins, OAuth
callback URLs, and the absolute links Roomote posts to Slack, GitHub, and
other integrations. Connectors registered before the switch (for example a
GitHub App created by the wizard) keep the callback URLs they were created
with, so reconnect or update those in their provider settings if you change
the domain after onboarding.

Leave `TRPC_URL` on the api service's own domain — hosted-compute workers
and webhooks call it directly, and it never needs to match the domain users
browse. (A custom domain on the api or MinIO services works the same way if
you want one: they are separate values on api, `TRPC_URL` and
`S3_PRESIGN_ENDPOINT`.)

## Enabling live previews (optional)

Live previews need a wildcard domain, which requires a domain you control:

1. Add the `preview-proxy` service (see the topology table).
2. Point `previews.<your-domain>` and `*.previews.<your-domain>` at Railway
   as custom domains on the preview-proxy service, following Railway's
   wildcard-domain docs.
3. Set `PREVIEW_PROXY_BASE_URL=https://previews.<your-domain>`,
   `NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL=https://previews.<your-domain>`, and
   `PREVIEW_DOMAINS=previews.<your-domain>` on api and reference them from
   the app services and preview-proxy. The `NEXT_PUBLIC_` variant is what
   the web client uses to build preview links, so the `web` service must
   have it; the production Compose overlay sets both for the same reason.
4. Opt in from **Settings → Live Previews**, which validates the wildcard
   hostname and enables previews per deployment and environment.

## Upgrades, backups, and costs

- **Template edits do not propagate.** A deployed project is a snapshot;
  Railway's template-update notifications only exist for GitHub-repo-based
  templates, not Docker-image-based ones like this. Template changes affect
  new deploys only.
- **Upgrade a deployment on `:develop`** by redeploying the four app
  services — they pull the current alias, and everything version-coupled
  derives from the new image. On an immutable pin, bump the tag in the four
  image fields first. The api service's `db-migrate` pre-deploy applies any
  schema changes, and the auto-generated keypairs persist in Postgres, so
  sessions, job tokens, and preview tokens survive redeploys. To make this
  happen automatically on every develop build, see
  [Auto-deploying every develop build](#auto-deploying-every-develop-build-optional).
- **Back up** the Railway Postgres database (Railway backups or `pg_dump`)
  and the MinIO volume or external bucket. Everything else is reproducible
  from config.
- **Costs** split three ways: Railway hosts the control plane (web, api,
  controller, bullmq, Postgres, Redis, MinIO), while task execution bills
  through your compute provider (Modal/E2B/Daytona) and model usage bills
  through your model provider.

## Auto-deploying every develop build (optional)

Railway never redeploys on its own when a mutable tag like `:develop` moves,
so a deployment tracking the alias only picks up new builds when someone
redeploys the app services. The `Publish GHCR Images` workflow has an
optional `deploy-railway` job that closes that gap: after each develop
build's images publish, it calls Railway's public GraphQL API directly,
finds every service in the environment running the `roomote-app` image,
points it at the new immutable `develop-<short-sha>` tag, and redeploys it.
Nothing extra runs inside the Railway project.

Setup, once:

1. In the Railway project, create a **project token** for the target
   environment (Project Settings → Tokens). Project tokens are scoped to
   that one environment and can be revoked there at any time.
2. On the GitHub repository, create a `railway` environment restricted to
   the `develop` branch, with a single secret:
   `ROOMOTE_RAILWAY_PROJECT_TOKEN`.
3. Set the repository variable `ROOMOTE_RAILWAY_AUTODEPLOY=true`. The job is
   skipped entirely while the variable is unset, so forks and deployments
   that do not want auto-deploy need no other configuration.

No project or environment IDs need to be configured: the job resolves the
environment from the token itself (`query { projectToken { environmentId } }`).

Each run matches services whose image starts with
`ghcr.io/<owner>/roomote-app` — api, web, controller, bullmq, and
preview-proxy when present — then issues `serviceInstanceUpdate` with the
pinned tag and `serviceInstanceDeploy` for each. The api service's
`db-migrate` pre-deploy runs as usual. MinIO, Postgres, and Redis never
match the prefix and are untouched. The first run permanently moves the
matched services from the `:develop` alias to immutable
`develop-<short-sha>` pins — intentional, since the pins make the deployed
version visible in the Railway UI and make rollback a tag switch: edit the
image field back to an older tag (or re-run the job from an older commit)
to roll back.

Security notes: the only credential is the project token, which can touch a
single Railway environment and nothing else in the workspace. It lives in a
GitHub environment secret, is never printed by the job, and GitHub does not
expose environment secrets to fork pull requests, so open-sourcing the
repository does not widen access. Rotate or revoke the token from the
Railway project's token settings.

## Maintaining the marketplace template

When the template needs to change, edit [`template.yaml`](template.yaml)
first, then mirror the change into the published template through Railway's
Template Composer. Re-run the first-boot verification on a scratch Railway
project before publishing the update. When the change touches reference
variables — in particular the `${{api.*}}` references to values that are
themselves references, like `ROOMOTE_APP_URL` — also open each app
service's Variables tab on the scratch project and confirm the resolved
values are real URLs, not literal `${{...}}` strings.
