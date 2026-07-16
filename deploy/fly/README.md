# Running Roomote on Fly.io

This guide covers deploying Roomote on [Fly.io](https://fly.io) as a single
Fly app whose process groups run the published images on Fly Machines. The
maintained app specification lives in [`fly.toml`](fly.toml); it is the
source of truth that maintainers keep up to date.

Fly has no template marketplace, so there is no one-click deploy button like
Railway's. The closest equivalent is the copy-paste
[quick deploy](#quick-deploy) sequence below: every step is one `flyctl`
command, with a few printed values (the Postgres cluster id, the Redis URL,
and the Tigris credentials) copied between steps, and nothing needs editing
beyond picking an app name.

For single-host Docker deployments, use the one-command installer or the
Compose paths in [SELF_HOSTING.md](../../SELF_HOSTING.md) instead. For the
other PaaS-shaped paths, see [deploy/railway](../railway/README.md) and
[deploy/coolify](../coolify/README.md).

## How the Fly.io shape differs from single-host

- **Fly Proxy is the HTTPS edge.** There is no bundled Caddy and no
  `/_roomote-api` path routing. A Fly app has one public hostname and Fly
  Proxy routes by port, not hostname or process group, so the web app owns
  port 443 and the API is exposed on port **8443** of the same hostname:
  `TRPC_URL` is `https://<app>.fly.dev:8443`. Fly's `*.fly.dev` certificate
  covers TLS-handled ports other than 443, and GitHub webhooks and
  hosted-sandbox workers call that origin directly (both support explicit
  ports in URLs). Slack webhooks arrive at the web origin and are proxied to
  the API internally.
- **One app, one Machine per service.** web, api, controller, and bullmq are
  Fly process groups of a single app, each running in its own Machine from
  the same `roomote-app` image. They share one `[env]` block and one set of
  secrets, and scale independently with `fly scale ... --process-group`.
- **No Docker socket.** The `docker` sandbox provider cannot run on Fly
  Machines. Task execution must use a hosted sandbox provider: Modal
  (default), E2B, or Daytona. Those only need outbound HTTPS plus API
  credentials. The config sets `EXCLUDED_COMPUTE_PROVIDERS=docker` so the
  unusable provider never appears in setup or sandbox selection.
- **Managed data services replace the bundled datastores.** Fly Managed
  Postgres provides `DATABASE_URL`, Upstash Redis (via `fly redis create`)
  provides `REDIS_URL`, and [Tigris](https://www.tigrisdata.com) object
  storage replaces bundled MinIO entirely — it is S3-compatible, serves
  presigned artifact URLs directly, and `fly storage create` provisions the
  bucket, so there is no MinIO service to run.
- **No openssl provisioning step.** The config sets
  `R_AUTO_GENERATE_KEYS=true`, so Roomote generates the `JOB_AUTH_*` /
  `PREVIEW_AUTH_*` P-256 keypairs at first boot and persists them encrypted
  (with `ENCRYPTION_KEY`) in Postgres. The remaining secrets are random
  strings set once with `fly secrets set`.
- **The setup wizard is token-gated by default.** `fly.dev` domains are
  publicly reachable, so the quick-deploy sequence generates a
  `SETUP_TOKEN`. Read it back later with `fly ssh console` or keep the value
  from the command you ran.
- **Live previews are off by default.** Preview subdomains need a wildcard
  domain on port 443, which the web service already owns in this app, so
  enabling previews means running the preview proxy as a second Fly app
  (see below); everything else works without it.

## What you need

- A Fly.io account and [`flyctl`](https://fly.io/docs/flyctl/install/)
  logged in (`fly auth login`).
- A hosted sandbox account: [Modal](https://modal.com) (default),
  [E2B](https://e2b.dev), or [Daytona](https://daytona.io).
- A model provider API key, for example OpenRouter (entered in the setup
  wizard, not at deploy time).

## Image access

Both published images (`ghcr.io/roocodeinc/roomote-app` and
`ghcr.io/roocodeinc/roomote-worker`) are public. Fly pulls the app image
anonymously, and hosted sandbox providers (Modal's remote builder,
E2B/Daytona worker builds) pull the worker image anonymously; no registry
credentials are needed.

## Quick deploy

Run from this directory (`deploy/fly/`) in a checkout of the repository.
Pick a globally unique app name first — one `sed` stamps it into the app
name, the URLs, and the bucket name:

```sh
APP=my-roomote   # must be unique across all of Fly.io
REGION=iad       # see `fly platform regions`

sed -i.bak "s/roomote-CHANGEME/$APP/g" fly.toml && rm fly.toml.bak

fly apps create "$APP"

# Managed Postgres. `fly mpg attach` sets the DATABASE_URL secret; the
# cluster id is printed by `fly mpg create`.
fly mpg create --name "$APP-db" --region "$REGION" --plan basic --pg-major-version 17
fly mpg attach <cluster-id> --app "$APP"

# Upstash Redis. Copy the private URL printed by `fly redis create`.
fly redis create --name "$APP-redis" --region "$REGION" --no-replicas
fly secrets set --app "$APP" REDIS_URL='<redis url printed above>'

# Tigris object storage. Creates the bucket and prints the credentials;
# Roomote reads the S3_* names, so copy the two values over. (The AWS_*
# secrets Tigris also sets on the app are the same credentials and are
# harmless to leave in place.)
fly storage create --name "$APP-artifacts" --app "$APP" --yes
fly secrets set --app "$APP" \
  S3_ACCESS_KEY_ID='<tid_... printed above>' \
  S3_SECRET_ACCESS_KEY='<tsec_... printed above>'

# Deployment secrets. Save the DASHBOARD_PASSWORD and SETUP_TOKEN values.
fly secrets set --app "$APP" \
  ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  ARTIFACT_SIGNING_KEY="$(openssl rand -base64 32)" \
  DASHBOARD_PASSWORD="$(openssl rand -base64 24)" \
  SETUP_TOKEN="$(openssl rand -hex 16)" \
  R_DISCORD_GATEWAY_SECRET="$(openssl rand -base64 32)"

# One Machine per process group (web, api, controller, and bullmq). The
# db-migrate release command runs schema migrations first.
fly deploy --ha=false
```

Then open `https://$APP.fly.dev/setup?token=<SETUP_TOKEN>` and continue with
[First boot](#first-boot).

## Service topology

| Process group | Command (image entrypoint) | Public service                  | Healthcheck        |
| ------------- | -------------------------- | ------------------------------- | ------------------ |
| `web`         | `web`                      | yes — port 443 (`http_service`) | `/health`          |
| `api`         | `api`                      | yes — port 8443                 | `/health/liveness` |
| `controller`  | `controller`               | no                              | —                  |
| `bullmq`      | `bullmq`                   | no                              | —                  |

Postgres, Redis, and object storage are managed resources (Fly Managed
Postgres, Upstash Redis, Tigris), not process groups. Every process group
runs in its own Machine; `fly.toml` gives each a `shared-cpu-1x` Machine
with 1 GB RAM by default. Scale a single group with
`fly scale memory 2048 --process-group web` or
`fly scale vm <size> --process-group <name>`, and add Machines with
`fly scale count web=2`.

Fly process commands correspond to Docker `CMD` and do not replace the image
`ENTRYPOINT`, so the bare service names (`web`, `api`, ...) dispatch through
`.docker/app/entrypoint.sh` — the opposite of Railway, whose custom start
command bypasses the entrypoint and needs the full path.

## Environment variables and secrets

Fly has no per-process env, so the `[env]` block in `fly.toml` is shared by
every process group. That is safe because each group runs in its own
Machine, and all app services honor the shared `PORT=8080`.

Everything sensitive is a Fly secret, set once for the app:

| Secret                                     | Source                                  |
| ------------------------------------------ | --------------------------------------- |
| `DATABASE_URL`                             | `fly mpg attach`                        |
| `REDIS_URL`                                | printed by `fly redis create`           |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | printed by `fly storage create`         |
| `ENCRYPTION_KEY`, `ARTIFACT_SIGNING_KEY`   | `openssl rand -base64 32`               |
| `R_DISCORD_GATEWAY_SECRET`                 | `openssl rand -base64 32` (API + BullMQ Discord Gateway) |
| `DASHBOARD_PASSWORD`                       | `openssl rand -base64 24`               |
| `SETUP_TOKEN`                              | `openssl rand -hex 16` (gates `/setup`) |

Notes:

- `R_APP_URL` is the **single canonical-origin knob**: it is the URL
  users browse. Do not set `R_PUBLIC_URL` — it is optional and the app
  falls back to `R_APP_URL` everywhere it would apply. See
  [Attaching a custom domain](#attaching-a-custom-domain).
- Leave `DOCKER_WORKER_IMAGE` and `MODAL_BASE_IMAGE_REF` **unset**. The app
  derives both from the `RELEASE_VERSION` baked into the running image, so
  they always match the deployed build. Setting them explicitly overrides
  the derivation and silently pins the worker to whatever version the value
  encodes.
- `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and model provider keys such as
  `OPENROUTER_API_KEY` are **not** deploy-time values. Enter them in the
  `/setup` wizard (or Settings → Sandboxes / Models) after first boot; they
  are stored encrypted in Postgres. Setting them as secrets still works and
  takes precedence, but is unnecessary.
- Leave `JOB_AUTH_*` and `PREVIEW_AUTH_*` unset —
  `R_AUTO_GENERATE_KEYS=true` manages them. If you later provide
  explicit values, they take precedence over the persisted keypairs.
- Leave `PREVIEW_PROXY_BASE_URL` and `PREVIEW_DOMAINS` unset unless you
  enable live previews. Roomote boots without them; previews report as not
  configured in **Settings → Live Previews** until set.
- Changing secrets on a deployed app restarts its Machines; `fly secrets
set --stage` defers that to the next deploy.

## The artifact bucket

`fly storage create` provisions the Tigris bucket up front, so
`S3_AUTO_CREATE_BUCKET` stays unset. Tigris is S3-compatible with
`S3_REGION=auto`, and presigned artifact URLs point at
`https://fly.storage.tigris.dev` directly, which is reachable from
hosted-sandbox workers and browsers without any service in this app.

Alternatively, point the S3 values at another external S3-compatible store
(AWS S3, or Cloudflare R2 with `S3_REGION=auto`). Roomote uses path-style
addressing, and `S3_PRESIGN_ENDPOINT` must be reachable from hosted-sandbox
workers. Pre-create the bucket, or set `S3_AUTO_CREATE_BUCKET=true` in
`[env]` if the configured credentials are allowed to create buckets.

## First boot

1. Wait for the `web` and `api` Machines to pass their checks (`fly status`;
   `fly logs` to follow). On a brand-new app the first boot also generates
   and persists the auth keypairs (watch for `[auth-keypairs] Generated ...`
   in the logs — whichever app service boots first wins the race and
   generates them).
2. Open `https://<app>.fly.dev/setup?token=<SETUP_TOKEN>` (or paste the
   token into the wizard's token step).
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

The app boots on its `fly.dev` hostname, and `R_APP_URL` — the origin
users browse — is stamped into `fly.toml` at launch. Adding a certificate
alone does not change what the app treats as canonical; the symptom of a
mismatch is a working dashboard that rejects signup, login, and OAuth flows
with `403 {"error":"Invalid origin"}`.

1. Point a CNAME (or A/AAAA from `fly ips list`) at the app and run
   `fly certs add app.example.com`.
2. In `fly.toml`, set `R_APP_URL = 'https://app.example.com'` and run
   `fly deploy`.

Everything derived from the canonical origin follows: auth origins, OAuth
callback URLs, and the absolute links Roomote posts to Slack, GitHub, and
other integrations. Connectors registered before the switch (for example a
GitHub App created by the wizard) keep the callback URLs they were created
with, so reconnect or update those in their provider settings if you change
the domain after onboarding.

`TRPC_URL` can stay on `https://<app>.fly.dev:8443` — hosted-sandbox workers
and webhooks call it directly, and it never needs to match the domain users
browse. If you move it onto the custom domain, keep the `:8443` port; the
certificate from `fly certs add` covers TLS-handled ports other than 443.

## Enabling live previews (optional)

Preview subdomains need a wildcard domain served on port 443, which the web
service already owns in this app — and Fly Proxy routes by port, so the
preview proxy cannot share it. Run the proxy as a second Fly app instead:

1. Create the app and deploy the same image with the preview-proxy process:

   ```toml
   # fly.previews.toml
   app = '<app>-previews'
   primary_region = '<region>'

   [build]
     image = 'ghcr.io/roocodeinc/roomote-app:main'

   [processes]
     preview-proxy = 'preview-proxy'

   [http_service]
     processes = ['preview-proxy']
     internal_port = 8081
     force_https = true
     auto_stop_machines = 'off'
     auto_start_machines = true
     min_machines_running = 1

     [[http_service.checks]]
       grace_period = '30s'
       interval = '15s'
       timeout = '5s'
       method = 'GET'
       path = '/health'

   [[vm]]
     cpu_kind = 'shared'
     cpus = 1
     memory = '1gb'
   ```

   Give it the same `[env]` values as the main app (minus the S3/URL
   settings it does not serve) plus `PORT=8081`, and set the same
   `DATABASE_URL`, `REDIS_URL`, and `ENCRYPTION_KEY` secrets — the
   `ENCRYPTION_KEY` must match so the proxy can use the persisted
   `PREVIEW_AUTH_*` keypair. Deploy with
   `fly deploy -c fly.previews.toml --ha=false`.

2. Point `previews.<your-domain>` and `*.previews.<your-domain>` at the
   previews app and add both certificates (`fly certs add -a <app>-previews
previews.<your-domain>` and `fly certs add -a <app>-previews
'*.previews.<your-domain>'`; the wildcard needs the DNS challenge from
   Fly's certificate docs).
3. On the **main** app, set `PREVIEW_PROXY_BASE_URL`,
   `NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL`, and `PREVIEW_DOMAINS` to
   `https://previews.<your-domain>` (the `NEXT_PUBLIC_` variant is what the
   web client uses to build preview links), add the same three values to the
   previews app, and redeploy both.
4. Opt in from **Settings → Live Previews**, which validates the wildcard
   hostname and enables previews per deployment and environment.

## Upgrades, backups, and costs

- **Upgrade a deployment on `:main`** by running `fly deploy` again — Fly
  resolves the mutable alias at deploy time, the `db-migrate` release
  command applies any schema changes first, and the auto-generated keypairs
  persist in Postgres, so sessions, job tokens, and preview tokens survive
  redeploys. On an immutable pin, bump the tag in `[build].image` first.
  There is no Railway-style auto-deploy workflow for Fly in this repository;
  a deployment that wants every main build can run `fly deploy` from its
  own CI with a [deploy token](https://fly.io/docs/security/tokens/)
  (`fly tokens create deploy`) and the edited `fly.toml`.
- **Back up** the Managed Postgres cluster (Fly's MPG backups or `pg_dump`
  via `fly mpg connect`) and the Tigris bucket. Everything else is
  reproducible from `fly.toml` plus the secrets.
- **Costs** split four ways: Fly bills the Machines and Managed Postgres,
  Upstash and Tigris bill usage through Fly, task execution bills through
  your sandbox provider (Modal/E2B/Daytona), and model usage bills through
  your model provider.

## Maintaining the template

When the config needs to change, edit [`fly.toml`](fly.toml) and re-run the
quick-deploy sequence plus the first-boot verification on a scratch Fly
organization (or a scratch app name) before merging. Keep the
`roomote-CHANGEME` placeholder intact — the quick-deploy `sed` depends on
it appearing in the app name, both URLs, and the bucket name.
