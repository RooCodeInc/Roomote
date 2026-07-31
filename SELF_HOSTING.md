# Self-Hosting Roomote

This guide covers the operator path for running one Roomote deployment. For
day-to-day development, use `pnpm dev` from [README.md](README.md). For a
containerized install, use the one-command installer or the Compose paths
below.

## Deployment Modes

| Mode                       | Command                            | Use case                                                                                                     |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| One-command install        | `curl get.roomote.dev \| bash`     | Fresh server, guided browser setup, published images (start here)                                            |
| Local development          | `pnpm dev`                         | Fast source edits with PM2-managed local services                                                            |
| Single-host production     | `docker compose ... up -d --build` | Put web, API, controller, queues, preview proxy, and Caddy on one host                                       |
| Railway (PaaS)             | Railway template                   | Managed platform deploy with hosted sandboxes; see [deploy/railway](deploy/railway/README.md)                |
| Render (PaaS)              | Render Blueprint                   | Managed platform deploy with hosted sandboxes; see [deploy/render](deploy/render/README.md)                  |
| Coolify (self-hosted PaaS) | Docker Compose resource            | Run the published images on a Coolify-managed server; see [deploy/coolify](deploy/coolify/README.md)         |
| Fly.io (PaaS)              | `flyctl` + maintained `fly.toml`   | One Fly app with managed Postgres/Redis/storage and hosted sandboxes; see [deploy/fly](deploy/fly/README.md) |

The application stack is web, API, controller, BullMQ, preview proxy,
Postgres, Redis, and MinIO artifact storage. The production overlay adds Caddy
as the HTTPS edge.

## One-Command Install

SSH into a fresh Ubuntu or Debian server (x86_64 or arm64, 4 GB+ RAM recommended) and
run:

```sh
curl -fsSL https://get.roomote.dev | bash
```

Prefer to read what you are about to run as root? Download, inspect, then run
the same script:

```sh
curl -fsSL https://get.roomote.dev -o install.sh
less install.sh
sudo bash install.sh
```

The installer brings up the full production stack from published GHCR images
and prints a setup link like
`https://roomote.203-0-113-7.sslip.io/setup?token=...`. Open it in a browser
and the setup wizard walks through everything else: sign-in provider, GitHub
App (created for you via GitHub's manifest flow), model provider and API key,
Slack, repositories, and a first task. Nothing else needs to be edited on the
server.

What the script does:

- installs Docker Engine and the Compose plugin if missing;
- generates every secret (`openssl` keypairs, encryption and signing keys,
  `DASHBOARD_PASSWORD`, and a one-time `SETUP_TOKEN`) into
  `/opt/roomote/.env`;
- defaults the domain to `roomote.<your-ip>.sslip.io`, which needs zero DNS
  setup and still supports HTTPS and wildcard preview subdomains;
- installs a `roomote-compose` systemd unit so the stack survives reboots;
- installs the `roomote` host CLI for day-2 operations.

For production, bring your own domain instead of the sslip.io default (sslip
domains share public Let's Encrypt rate limits and are tied to the host IP):

```sh
curl -fsSL https://get.roomote.dev | bash -s -- --domain roomote.example.com
```

Point `<domain>`, `preview.<domain>`, and `*.preview.<domain>` A records at
the server first; the installer waits briefly for DNS and Caddy retries
certificates until the records are in place.

### Flat preview hostnames

**Recommended for Cloudflare Tunnel.** Cloudflare's standard certificate covers
`*.example.com`, but not `*.preview.example.com`. Use flat preview hostnames so
Roomote publishes `task-port-preview.example.com` without requiring an
Advanced Certificate. Set the preview base to the parent domain and add a
suffix:

```sh
ROOMOTE_APP_DOMAIN=example.com
ROOMOTE_PREVIEW_DOMAIN=example.com
PREVIEW_PROXY_BASE_URL=https://example.com
PREVIEW_DOMAINS=example.com
PREVIEW_PROXY_SUBDOMAIN_SUFFIX=preview
```

Roomote then publishes `task-port-preview.example.com`, which is covered by
`*.example.com`. Point `*.example.com` at Caddy or your tunnel, and reserve the
`-preview` suffix so it does not collide with other first-level subdomains.

If your certificate provider supports `*.preview.example.com`, the existing
`task-port.preview.example.com` layout remains an alternative. It keeps preview
cookies within a dedicated preview namespace rather than sending them to other
`example.com` subdomains.

One Cloudflare Tunnel can serve both the app and preview hostnames through the
same Caddy instance. Install Roomote with `--tls-mode internal` so Caddy issues
local certificates for the private tunnel-to-Caddy hop, then configure both
ingress rules with the matching origin TLS setting:

```yaml
ingress:
  - hostname: example.com
    service: https://localhost:443
    originRequest:
      noTLSVerify: true
  - hostname: '*.example.com'
    service: https://localhost:443
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

Replace `noTLSVerify: true` by configuring cloudflared to trust Caddy's local
CA when you manage that trust chain yourself. The option applies only to the
private tunnel-to-Caddy hop; Cloudflare still serves a publicly trusted
certificate to browsers.

In the Cloudflare dashboard, enable **Match SNI to Host** for the wildcard
`*.example.com` public hostname. This sends the incoming preview hostname as
the TLS server name to Caddy, so flat wildcard preview URLs such as
`task-port-preview.example.com` reach the matching origin without 502 errors.

### Private networks and tunnels

When a reverse tunnel or private network terminates public TLS before traffic
reaches Roomote, use Caddy's internal certificates instead of requesting
Let's Encrypt certificates:

```sh
curl -fsSL https://get.roomote.dev | bash -s -- \
  --domain roomote.internal \
  --tls-mode internal
```

`--tls-mode internal` skips public-DNS verification and configures Caddy to
issue local certificates; it requires `--domain`. Direct private-network
clients must trust Caddy's local CA, while clients behind a tunnel use the
tunnel's public certificate. Use `--skip-dns-check` with the default `acme`
mode only when you know public DNS is not ready yet. The selected mode is
retained in `/opt/roomote/.env`, so installer reruns and `roomote upgrade`
preserve it.

### Cloudflare Tunnel

Cloudflare Tunnel works with the supported `internal` TLS mode: Cloudflare
serves the public certificate and forwards encrypted traffic to Caddy on the
private host. Configure the tunnel to send the app domain and wildcard preview
traffic to Caddy, rather than directly to individual Roomote services, so
artifact and API routes keep their normal behavior.

Because Caddy issues a local certificate in this mode, configure the tunnel's
HTTPS origin either to trust Caddy's local CA or to skip origin certificate
verification:

```yaml
originRequest:
  noTLSVerify: true
```

Use `noTLSVerify` only for the private tunnel-to-Caddy hop; Cloudflare still
serves a publicly trusted certificate to browsers.

Cloudflare's standard certificate for `example.com` and `*.example.com` does
not cover Roomote's default `task-port.preview.example.com` preview shape.
Provision a certificate that covers `preview.example.com` and
`*.preview.example.com`, and configure the tunnel's wildcard hostname to reach
Caddy.

Task sandboxes reject private, link-local, and Tailscale ranges to protect the
host network. If a self-hosted Gitea or GitLab hostname resolves differently
inside Docker than it does on the host, tasks can fail to clone even though the
service is reachable from the local PC. Give sandboxes a public,
worker-reachable source-control hostname instead of disabling those network
guards or overriding Docker DNS globally.

Useful flags and env vars: `--version <tag>` pins a release, and
`--preview-domain <host>` overrides the preview root. Both published images
are public, so pulls need no credentials. Re-running the installer is safe:
existing secrets and the existing domain are preserved.

Day-2 operations go through the installed CLI:

```sh
roomote status              # service health
roomote logs [service...]   # follow logs
roomote setup-url           # re-print the tokenized /setup link
roomote upgrade [version]   # upgrade or roll back by image tag
roomote rollback            # return to the release before the last upgrade
roomote backup              # encrypted recovery bundle in /opt/roomote/backups
roomote restore <f> --yes   # restore configuration and data onto this host
```

The backup command prompts twice for a passphrase. It creates a versioned,
encrypted `.roomote` bundle containing the PostgreSQL dump, `/opt/roomote/.env`
(including encryption and signing keys), the Compose and Caddy configuration,
local MinIO artifacts, schema metadata, and exact container image digests.
Keep the passphrase outside the host in a secret manager. For unattended use,
pass a root-readable file with `--passphrase-file`; do not put the passphrase
on the command line.

Add `--include-redis` when queued tasks, BullMQ schedules, sessions, and
transient integration state must survive host loss. Without it, restore clears
Redis so old transient state cannot conflict with the restored database.

Backup establishes an application-quiesced consistency point: it stops web,
API, controller, BullMQ, preview proxy, and active Docker task workers before
dumping PostgreSQL and snapshotting local MinIO and optional Redis. Schedule it
during a maintenance window. The Compose services restart when backup
finishes; interrupted Docker tasks may be recovered by the normal orphaned-task
flow.

For external S3-compatible storage, the bundle records the endpoint and bucket
but does not copy objects. Back up and restore that bucket using the storage
provider before starting Roomote on the replacement host.

To recover a completely new server, run the one-command installer first, copy
the bundle onto the host, then run `roomote restore <bundle> --yes`. Restore
decrypts and verifies every bundled file before stopping the new installation,
restores the original `.env`, repopulates empty data volumes, pins the recorded
image digests, restores PostgreSQL, and starts the recorded release. A wrong
passphrase, checksum failure, missing local-MinIO data, or unavailable image
identity fails before restored services are started.

`roomote upgrade` first creates an encrypted pre-upgrade backup bundle under
`/opt/roomote/backups` (skip with `--skip-backup`; supply a passphrase with
`--backup-passphrase-file` or `ROOMOTE_BACKUP_PASSPHRASE`, otherwise one is
generated next to the bundle). It then pulls the new images and applies
database migrations before replacing any running service. Migrations apply in
a single transaction, so a migration failure rolls the schema back, restores
the previous deployment configuration, and leaves the previous release
running. Because every schema change must keep the previous release working
(see the compatibility policy in `deploy/README.md`), a bad release can be
undone with `roomote rollback`, which re-deploys the release recorded before
the last upgrade without touching the database; the pre-upgrade bundle plus
`roomote restore` is the last-resort path that also rewinds data. The running
application and schema versions are visible under Settings -> Deployment ->
Diagnostics.

`roomote upgrade` prunes old Roomote images after a successful upgrade. It
keeps the current release plus the newest local Roomote image tags for a total
of `ROOMOTE_IMAGE_RETENTION_RELEASES` retained tags (default `3`); set that
environment variable before running the command when you want a larger or
smaller rollback cache. Retention is best-effort: if Docker cleanup fails, the
healthy upgrade remains in place and the command prints a warning.

### Changing your domain later

The domain is baked into OAuth apps created during setup (GitHub App, Slack
app, sign-in provider redirects). To move a deployment to a new domain: update
DNS, set `ROOMOTE_APP_DOMAIN`, `ROOMOTE_PREVIEW_DOMAIN`, and `TRPC_URL` in
`/opt/roomote/.env`, run `roomote up`, then re-create or update the GitHub App
and Slack app (both use manifest flows, so this is a few clicks) and update
your sign-in provider's redirect URLs.

## Prerequisites

- Docker Engine with Compose.
- A stable public HTTPS app origin.
- A model provider account and API key.
- A GitHub App installed on the repositories Roomote should use.
- At least one sign-in provider: Slack or Microsoft Teams.
- Docker socket access for the default single-host Docker sandbox provider, or
  a hosted sandbox provider such as Vercel Sandbox or Modal.
- Optional Slack and Linear apps if you want those integrations.

For production-style use, also prepare:

- A host with ports `80` and `443` reachable from the public internet.
- An app domain, for example `roomote.example.com`.
- A preview domain plus wildcard DNS, for example
  `preview.roomote.example.com` and `*.preview.roomote.example.com`.
- A tested encrypted `roomote backup` schedule and an off-host copy of both the
  bundle and its separately stored passphrase.
- A provider-level object backup when using external S3-compatible storage.

## Environment Files

Use `.env.local` for local development and local self-host Compose:

```sh
cp .env.local.example .env.local
```

Use `.env.production` for the Caddy-backed production overlay:

```sh
cp .env.production.example .env.production
```

Do not commit real env files. Shell exports take precedence over values in
these files.

Naming follows three rules: Roomote-owned operator configuration uses the
`R_*` prefix (`R_APP_URL`, `R_MODEL`, `R_GITHUB_*`, `R_SLACK_*`,
`R_TELEGRAM_*`, `R_LINEAR_*`, `R_AUTO_GENERATE_KEYS`, …); conventional
infrastructure names stay unchanged (`DATABASE_URL`, `REDIS_URL`, `S3_*`,
`NODE_ENV`); and third-party provider credentials keep the provider's own
names (`MODAL_*`, `E2B_*`, `DAYTONA_*`, `ANTHROPIC_API_KEY`, …). Remaining
`ROOMOTE_*` names are internal plumbing or installer/upgrade machinery kept
for compatibility — see "Environment Variable Naming" in
[deploy/README.md](deploy/README.md) for the exceptions list.

## Public URLs

Roomote needs one stable public app origin for auth callbacks, webhooks, and
links sent from Slack or GitHub.

For local development, set `R_PUBLIC_URL`:

```sh
R_PUBLIC_URL=https://your-static-ngrok-domain.ngrok.app
```

If that URL is an ngrok domain, `pnpm dev` starts and reuses
`ngrok http --url=<domain> 13000`.

For production, set domains in `.env.production`:

```sh
ROOMOTE_APP_DOMAIN=roomote.example.com
ROOMOTE_PREVIEW_DOMAIN=preview.roomote.example.com
TRPC_URL=https://roomote.example.com/_roomote-api
```

The production Compose overlay derives these runtime URLs:

| Runtime key              | Value                                      |
| ------------------------ | ------------------------------------------ |
| `R_PUBLIC_URL`           | `https://$ROOMOTE_APP_DOMAIN`              |
| `R_APP_URL`              | `https://$ROOMOTE_APP_DOMAIN`              |
| `TRPC_URL`               | `https://$ROOMOTE_APP_DOMAIN/_roomote-api` |
| `PREVIEW_PROXY_BASE_URL` | `https://$ROOMOTE_PREVIEW_DOMAIN`          |
| `PREVIEW_DOMAINS`        | `$ROOMOTE_PREVIEW_DOMAIN`                  |

On production Caddy, `ROOMOTE_APP_DOMAIN` serves both the web app and the
worker-facing API. Caddy routes the explicit `/_roomote-api/*` prefix to
`api:3001` after stripping that prefix, routes `/$S3_BUCKET_ARTIFACTS/*`
directly to MinIO for presigned artifact uploads and downloads, and sends all
other paths, including web auth, browser tRPC, Slack OAuth, and UI routes, to
`web:3000`.

After those values are in place, open any task's preview pane as an admin to
confirm the detected runtime config and validate the wildcard preview
hostname. Live previews are always enabled: they publish for every environment
that defines preview ports once the runtime config is ready.

## Model Provider

Task execution requires a models.dev-style model id:

```sh
R_MODEL=openrouter/anthropic/claude-sonnet-4
OPENROUTER_API_KEY=...
```

Set `R_SMALL_MODEL` for routing, title generation, summaries, and
other lightweight calls:

```sh
R_SMALL_MODEL=openrouter/openai/gpt-4.1-mini
```

Set `R_VISION_MODEL` when image understanding and visual information
extraction should use a different model from the active coding model. Roomote
configures a hidden OpenCode `visual` subagent only when this model differs
from the effective coding model for the task, and asks the parent agent to
delegate screenshot, diagram, chart, rendered-document, and other visual
inspection through it:

```sh
R_VISION_MODEL=openrouter/openai/gpt-5.6-sol
```

Set `R_CODE_REVIEW_MODEL` when pull request and merge request review
tasks, implementation judge passes, and other code-review-oriented analysis
should use a different model from the active coding model. When unset, those
review flows fall back to the default coding model:

```sh
R_CODE_REVIEW_MODEL=openrouter/openai/gpt-5.6-sol
```

Set `R_EXPLORE_MODEL` when read-only codebase exploration through the
OpenCode `explore` subagent should use a different model from the active coding
model. When unset, exploration falls back to the task's active coding model:

```sh
R_EXPLORE_MODEL=openrouter/openai/gpt-5.6-luna
```

The provider is the first segment of the model id. Roomote forwards these
common provider keys into worker containers:

- `OPENROUTER_API_KEY`
- `AI_GATEWAY_API_KEY` (Vercel AI Gateway, `vercel/...` models)
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DASHSCOPE_API_KEY` (Alibaba Cloud Model Studio, `alibaba/...` models, with
  `ALIBABA_REGION`)
- `ALIBABA_CODING_PLAN_API_KEY` (Alibaba Coding Plan,
  `alibaba-coding-plan/...` models, with `ALIBABA_CODING_PLAN_REGION`)
- `ALIBABA_TOKEN_PLAN_API_KEY` (Alibaba Token Plan,
  `alibaba-token-plan/...` models, with `ALIBABA_TOKEN_PLAN_REGION`)
- `MOONSHOT_API_KEY`
- `KIMI_API_KEY` (Kimi for Coding, `kimi-for-coding/...` models)
- `MINIMAX_API_KEY`
- `ZAI_API_KEY` (with `ZAI_REGION`: `global` or `china`, defaults to `global`)
- `ZAI_CODING_PLAN_API_KEY` (Z.AI Coding Plan, `zai-coding-plan/...` models,
  with `ZAI_CODING_PLAN_REGION`)
- `OPENCODE_API_KEY`

If your provider uses another env var name, list it in
`R_MODEL_ENV_KEYS`:

```sh
R_MODEL=custom-provider/custom-model
R_MODEL_ENV_KEYS=CUSTOM_PROVIDER_API_KEY
CUSTOM_PROVIDER_API_KEY=...
```

The checked-in Compose files forward the common provider keys above and the
sample `CUSTOM_PROVIDER_API_KEY`. If you use a different custom provider key
name in a Compose deployment, add that key to the service environment block or
provide it through your deployment secret mechanism.

## Artifact Storage

Roomote stores generated artifacts, plans, and visual proof uploads in
S3-compatible object storage. The Compose stack includes MinIO and creates
`S3_BUCKET_ARTIFACTS` during startup.

Local development defaults to:

```sh
S3_ENDPOINT=http://localhost:19000
S3_PRESIGN_ENDPOINT=http://localhost:19000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=roomote
S3_SECRET_ACCESS_KEY=roomote-local-artifacts-password
S3_BUCKET_ARTIFACTS=roomote-artifacts
```

When a local Docker worker asks the API for a presigned artifact URL through
`host.docker.internal`, the API signs the URL with that host so the worker can
upload without invalidating the S3 signature. Local self-host keeps both
`S3_ENDPOINT` and `S3_PRESIGN_ENDPOINT` on `http://minio:9000` inside the
Compose network. Production Caddy keeps `S3_ENDPOINT=http://minio:9000` for
server-side access, but defaults `S3_PRESIGN_ENDPOINT` to
`https://$ROOMOTE_APP_DOMAIN`; Caddy forwards `/$S3_BUCKET_ARTIFACTS/*` to
MinIO without stripping the bucket path so Docker, Modal, and other hosted
workers can all reach presigned artifact URLs.

## Sign-In Providers

Roomote requires sign-in, but no sign-in provider is needed to get started:
the installer's printed setup link acts as the first admin's invite, so you
can create an email/password admin account immediately and configure single
sign-on later. After that, bring in teammates with invite links from
**Settings → Users** (invited users can also sign up with email and
password), or configure one of these providers so your whole Slack workspace
or Microsoft tenant can sign in:

| Provider        | Env vars                                                                      | Redirect URL                                               |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Slack           | `R_SLACK_CLIENT_ID`, `R_SLACK_CLIENT_SECRET`                                  | `<public-url>/api/auth/oauth2/callback/slack`              |
| Microsoft Teams | `R_MICROSOFT_CLIENT_ID`, `R_MICROSOFT_CLIENT_SECRET`, `R_MICROSOFT_TENANT_ID` | `<public-url>/api/auth/oauth2/callback/microsoft-entra-id` |

You can restrict access with:

```sh
R_ALLOWED_EMAILS=you@example.com,teammate@example.com
```

### Roles

Users are either **admins** (manage deployment settings and users) or
**members**. The first user to sign in becomes the founding admin; everyone
after joins with the role their invite grants (member by default) until an
admin changes it from **Settings → Users**. Admins can also remove users
there: removal signs them out immediately, keeps their task history, and
frees their email so they can be invited and sign up again later. Roomote refuses role changes that would leave the
deployment without an admin, but if you ever lose admin access anyway (for
example the only admin account is gone), promote a user directly in the
database:

```sh
docker compose exec postgres \
  psql -U postgres -d roomote_development -c \
  "UPDATE users SET role = 'admin' WHERE email = 'you@example.com';"
```

Slack sign-in can reuse `R_SLACK_CLIENT_ID` and `R_SLACK_CLIENT_SECRET` from the
Slack integration app if you use one Slack app for both sign-in and bot events.
The `/setup` Slack step and **Settings → Communications** are the preferred
paths: paste a Slack app configuration token and click **Create Slack app**.
Roomote creates the app through Slack's manifest API and saves the Client ID,
Client Secret, and Signing Secret automatically. For an existing Slack app, or
when production secret management owns the values, set those env vars directly
instead.

## GitHub App

A GitHub App is required. Roomote uses it to discover repositories, clone
code, create branches, and open or update pull requests. For local development
and local self-hosting, open `/setup`, choose GitHub, and click **Create GitHub
App**; Roomote uses GitHub's manifest flow to create the app settings and save
the generated credentials automatically.

Use the same public URL for all GitHub settings:

| GitHub setting | Value                                           |
| -------------- | ----------------------------------------------- |
| Homepage URL   | `<public-url>`                                  |
| Setup URL      | `<public-url>/github/callback`                  |
| Callback URL   | `<public-url>/github/callback`                  |
| Webhook URL    | `<public-url>/_roomote-api/api/webhooks/github` |

Check **Redirect on update** in the GitHub App's Post installation settings so
repository access changes return to Roomote.

Use manual env vars when you already have a GitHub App or when production/shared
self-host secret management should own the values:

```sh
R_GITHUB_APP_SLUG=<github-app-slug>
R_GITHUB_APP_ID=<app-id>
R_GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
R_GITHUB_CLIENT_ID=<client-id>
R_GITHUB_CLIENT_SECRET=<client-secret>
R_GITHUB_WEBHOOK_SECRET=<webhook-secret>
```

The detailed GitHub manifest and manual permission checklist is in
[README.md#github-app-setup](README.md#github-app-setup).

## Slack Integration

Slack integration is optional unless Slack is your sign-in provider or task
entry surface. For local development and local self-hosting, open `/setup` or
**Settings → Communications**, paste a Slack app configuration token, and click
**Create Slack app**. Roomote creates the app with redirect, webhook,
interactivity, scope, and event settings prefilled for your public URL and
saves the credentials automatically. Workspace installation still happens later
in the Slack connection step.

For production self-hosting or manual review, use the same public URL for every
Slack URL:

| Slack setting              | Value                                          |
| -------------------------- | ---------------------------------------------- |
| OAuth redirect URL         | `<public-url>/api/slack/callback`              |
| Event Subscriptions URL    | `<public-url>/_roomote-api/api/webhooks/slack` |
| Interactivity request URL  | `<public-url>/_roomote-api/api/webhooks/slack` |
| Slack sign-in redirect URL | `<public-url>/api/auth/oauth2/callback/slack`  |

Required integration env vars:

```sh
R_SLACK_CLIENT_ID=...
R_SLACK_CLIENT_SECRET=...
R_SLACK_SIGNING_SECRET=...
```

`SLACK_APP_ID` is optional for manual preconfiguration. Roomote saves Slack's
`app_id` from the OAuth installation response after the workspace install flow
completes.

The Slack manifest-prefill flow and manual scope list are in
[README.md#slack-integration-app](README.md#slack-integration-app).

To run the containerized stack on your own machine (without a public server),
use the production compose overlay below with a local `.env.production` — it
runs the same images in production mode with per-install secrets, rather than
the source-checked-in development defaults. For fast source edits, use
`pnpm dev` instead.

## Production Compose With Caddy

Set DNS before starting:

| DNS name                   | Target              |
| -------------------------- | ------------------- |
| `ROOMOTE_APP_DOMAIN`       | The deployment host |
| `ROOMOTE_PREVIEW_DOMAIN`   | The deployment host |
| `*.ROOMOTE_PREVIEW_DOMAIN` | The deployment host |

Generate fresh keys:

```sh
openssl ecparam -name prime256v1 -genkey -noout -out job-auth-private.pem
openssl pkcs8 -topk8 -nocrypt -in job-auth-private.pem -out job-auth-private-pkcs8.pem
openssl ec -in job-auth-private.pem -pubout -out job-auth-public.pem
base64 < job-auth-private-pkcs8.pem | tr -d '\n' # JOB_AUTH_PRIVATE_KEY
base64 < job-auth-public.pem | tr -d '\n'        # JOB_AUTH_PUBLIC_KEY

openssl ecparam -name prime256v1 -genkey -noout -out preview-auth-private.pem
openssl pkcs8 -topk8 -nocrypt -in preview-auth-private.pem -out preview-auth-private-pkcs8.pem
openssl ec -in preview-auth-private.pem -pubout -out preview-auth-public.pem
base64 < preview-auth-private-pkcs8.pem | tr -d '\n' # PREVIEW_AUTH_PRIVATE_KEY
base64 < preview-auth-public.pem | tr -d '\n'        # PREVIEW_AUTH_PUBLIC_KEY

openssl rand -base64 32 # ENCRYPTION_KEY
openssl rand -base64 32 # R_DISCORD_GATEWAY_SECRET
openssl rand -base64 32 # ARTIFACT_SIGNING_KEY
openssl rand -base64 24 # DASHBOARD_PASSWORD
openssl rand -hex 16    # SETUP_TOKEN
```

If the deployment platform cannot run `openssl` during provisioning (for
example PaaS platforms such as Railway or Render), leave the four
`JOB_AUTH_*`/`PREVIEW_AUTH_*` values unset and set
`R_AUTO_GENERATE_KEYS=true` instead. Roomote then generates the P-256
keypairs once at first startup, stores them encrypted with `ENCRYPTION_KEY` in
the database, and reuses them on every later boot. Env-provided key values
always take precedence. The random string secrets (`ENCRYPTION_KEY`,
`R_DISCORD_GATEWAY_SECRET`, `ARTIFACT_SIGNING_KEY`, `DASHBOARD_PASSWORD`,
`SETUP_TOKEN`) are still required and can come from the platform's secret
generator. API and BullMQ must share the same `R_DISCORD_GATEWAY_SECRET` value
when Discord is enabled.

### Port exposure and the queue dashboard

Published container ports bind to `127.0.0.1` by default. This covers the
datastores in `docker-compose.yml` (Postgres `15432`, Redis `16379`, MinIO
`19000`/`19001`) and, in a standalone `docker-compose.self-host.yml` stack, the
app ports (web `13000`, API `13001`, BullMQ `13002`, preview proxy `18081`).
That keeps Postgres (default password), Redis (no auth), and the queue
dashboard off other hosts. The production Caddy overlay below removes these
published ports entirely and serves everything through Caddy on `80`/`443`. For
a standalone self-host stack, front the web app with a reverse proxy on the same
host (or add an explicit port override) rather than binding to all interfaces.

The BullMQ `/admin` queue dashboard (Bull Board, with write access to every
queue) is served **only when `DASHBOARD_PASSWORD` is set**, behind HTTP basic
auth as user `admin`. This is gated on the password, not on `NODE_ENV`, so the
`development`-flavored self-host services are still protected. With no
`DASHBOARD_PASSWORD`, `/admin` returns `503` and the dashboard is disabled while
the queue workers keep running.

`PREVIEW_PROXY_BASE_URL` and `PREVIEW_DOMAINS` no longer block startup when
unset: live previews simply report as not configured until you set the values
via env or from the preview pane's admin setup on any task page.

`SETUP_TOKEN` protects the pre-auth `/setup` bootstrap wizard, which admits the
deployment's first admin. Until initial setup completes, the wizard rejects
visitors who do not present the token via `/setup?token=<value>` or the token
entry step. **It is required on every non-local deployment** (any `R_APP_ENV`
other than `development`): if it is unset, first-admin bootstrap stays closed
and `/setup` blocks on the token step until you configure one — this prevents
an attacker who reaches the URL before you from claiming the founding admin
account. Only local development bootstraps without a token.

Edit `.env.production`, then start:

```sh
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-host.yml \
  -f docker-compose.compute-docker.yml \
  -f docker-compose.production.yml \
  up -d --build
```

Caddy is the only public entrypoint in this overlay. It serves the app/API
domain, the preview domain, and one-label preview subdomains. Its
certificates and ACME account state live in the `caddy_data` and `caddy_config`
Docker volumes.
MinIO has no direct host port; Caddy only proxies the configured artifact bucket
path for presigned S3 requests.

Stop the stack:

```sh
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-host.yml \
  -f docker-compose.compute-docker.yml \
  -f docker-compose.production.yml \
  down
```

## Compute Provider

`DEFAULT_COMPUTE_PROVIDER=docker` runs task workers as sibling Docker
containers on the same host. Include `docker-compose.compute-docker.yml` when
using Docker sandboxes. That overlay:

- builds the `DOCKER_WORKER_IMAGE` from `apps/worker/Dockerfile`;
- mounts `/var/run/docker.sock` into the controller;
- sets `DOCKER_WORKER_NETWORK=roomote_worker` as the trusted-service discovery
  network; each worker receives its own network containing only that worker,
  the API, and the optional preview proxy when enabled, never sibling tasks,
  Postgres, Redis, or MinIO;
- enforces CPU, memory, PID, supported writable-layer quotas, and log limits
  and, under the default `internet` egress policy, blackholes private and
  cloud metadata ranges plus drops packets destined to the Docker bridge
  gateway (host hairpin) while still allowing public egress via that gateway
  as next-hop. The gateway drop automatically selects an nftables or legacy
  `iptables` backend supported by the host kernel; sandbox provisioning fails
  closed when neither backend is available;
- points `DOCKER_WORKER_RELEASE_PATH` at the controller image's packaged worker
  release archive.

Docker tasks fail closed when the host storage driver cannot enforce
`DOCKER_WORKER_DISK_LIMIT`. Set `DOCKER_WORKER_ALLOW_UNBOUNDED_DISK=true` only
when the host already provides an equivalent storage quota outside Docker.

Docker sandboxes are the simplest single-host deployment path:

```sh
DEFAULT_COMPUTE_PROVIDER=docker
DOCKER_WORKER_IMAGE=roomote-worker:local
# Optional: defaults to the host architecture (linux/amd64 or linux/arm64)
DOCKER_WORKER_PLATFORM=linux/amd64
```

If you do not want the controller to access the host Docker socket, choose a
hosted provider instead and omit `docker-compose.compute-docker.yml`:

```sh
# Modal
DEFAULT_COMPUTE_PROVIDER=modal
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...
# Optional on published app images — see the worker image note below.
MODAL_BASE_IMAGE_REF=...

# E2B
DEFAULT_COMPUTE_PROVIDER=e2b
E2B_API_KEY=...
E2B_TEMPLATE_ID=...

# Daytona
DEFAULT_COMPUTE_PROVIDER=daytona
DAYTONA_API_KEY=...
DAYTONA_SNAPSHOT_NAME=...

# Blaxel
DEFAULT_COMPUTE_PROVIDER=blaxel
BL_API_KEY=...
BL_WORKSPACE=...
# Optional prebuilt Blaxel image override
BLAXEL_IMAGE=sandbox/roomote-worker:<version>
```

`E2B_TEMPLATE_ID`, `DAYTONA_SNAPSHOT_NAME`, and `BLAXEL_IMAGE` can also be provisioned
automatically during setup when a registry-qualified `DOCKER_WORKER_IMAGE`
is configured — the setup wizard and the Settings → Sandboxes page build the
worker base artifact in your provider account after credentials are saved.

For quick-install and V1 deployer-managed hosts, leave `MODAL_BASE_IMAGE_REF`
blank unless you need a custom Modal image. The installer and deployer sync it
to the matching `DOCKER_WORKER_IMAGE` (the published worker image doubles as
the Modal base image) and preserve a different non-empty value as an explicit
override.

When running the published `ghcr.io/roocodeinc/roomote-app` image, both
`DOCKER_WORKER_IMAGE` and `MODAL_BASE_IMAGE_REF` are optional: if unset, the
app derives `ghcr.io/roocodeinc/roomote-worker:<version>` from the release
version baked into the app image, which the publish workflow tags in lockstep
with the worker image. Set `ROOMOTE_WORKER_IMAGE_REPO` to derive from a
different repository (forks, registry mirrors). Explicit values always win,
and local source builds (where no published tag exists) still require the
variables as before.

Modal can also use:

```sh
MODAL_ENDPOINT=...
MODAL_ENVIRONMENT=...
MODAL_APP_NAME=...
MODAL_ECR_OIDC_ROLE_ARN=...
MODAL_ECR_REGION=...
# Optional sandbox placement regions (comma-separated Modal tokens)
MODAL_REGIONS=us
```

## Declarative Environments

Environments are normally created through the `/setup` wizard or
Settings → Environments. Deployments that are managed as infrastructure as
code can instead provision environments from declarative definitions at
startup, without any human intervention:

- `ROOMOTE_ENVIRONMENTS_DIR` — a directory of environment definition files
  (`*.yaml`, `*.yml`, or `*.json`), one environment per file. Mount it into
  the api container:

  ```yaml
  # docker-compose override for the api service
  volumes:
    - ./environments:/roomote/environments:ro
  ```

  ```sh
  ROOMOTE_ENVIRONMENTS_DIR=/roomote/environments
  ```

- `ROOMOTE_ENVIRONMENTS_YAML` — one or more inline YAML documents (separated
  by `---`) in a single env var, for platforms where mounting files is
  awkward (Railway, Render, Fly, and similar).

Each definition uses exactly the same YAML format as the environment editor's
YAML view (`name`, `repositories`, `services`, `ports`, commands, and so on),
so definitions copy/paste between the UI and the files. See
[`.roomote/environments/roomote.yaml`](.roomote/environments/roomote.yaml) in
this repository — Roomote's own environment definition — for a complete
working example.

Semantics:

- The definition set is applied on every API startup. The environment name is
  the identity key: missing environments are created, existing ones are
  updated. Identical re-applies are no-ops.
- **The declarative definition wins.** Environments provisioned this way stay
  editable in the UI (they show a "Managed from file" badge), but edits are
  overwritten the next time the deployment restarts and re-applies the file.
  Every overwrite is recorded in the environment's config version history.
- **Nothing is ever deleted.** Removing a definition returns its environment
  to normal manual management; it keeps all data and loses only the badge.
- Renaming `name` inside a definition creates a new environment under the new
  name and orphans the old one.
- Definitions may reference repositories that are not linked to the
  deployment yet (for example before the GitHub App is installed). The
  environment is created anyway and repository mappings backfill on the next
  startup after the repositories are linked.
- Invalid definitions are skipped with a logged error; they never prevent the
  API from starting or other definitions from applying. A missing or
  unreadable definitions directory is skipped the same way, so inline
  `ROOMOTE_ENVIRONMENTS_YAML` definitions still apply. While any definition
  fails to read or validate, the "removed definition" reconciliation above is
  deferred, so a temporarily broken file never strips its environment's
  managed marker.
- Keep secrets out of definition files: the per-environment `env` map is
  stored in plaintext. Use deployment environment variables or
  Settings → Environment Variables for secret values.

If you keep the definitions in a git repository, have your deploy pipeline
check it out and mount the directory (or inject the content into
`ROOMOTE_ENVIRONMENTS_YAML`). Roomote deliberately does not fetch remote
config itself.

## Verification Checklist

After startup:

1. Open the public app URL.
2. Sign in with the configured provider.
3. Visit `/setup` and confirm GitHub is connected.
4. Confirm repositories appear in the environment picker.
5. Start a small task, such as asking for the current time.
6. Open the task terminal and logs panes.
7. If Slack is configured, mention the app in Slack and confirm it creates or
   resumes a task.
8. Run `pnpm run doctor` from the repository root when testing locally.

## Operations

Logs:

```sh
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-host.yml \
  -f docker-compose.compute-docker.yml \
  -f docker-compose.production.yml \
  logs -f web api controller bullmq preview-proxy caddy
```

Restart one service:

```sh
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-host.yml \
  -f docker-compose.compute-docker.yml \
  -f docker-compose.production.yml \
  restart controller
```

Upgrade:

```sh
git pull --ff-only
pnpm install
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.self-host.yml \
  -f docker-compose.compute-docker.yml \
  -f docker-compose.production.yml \
  up -d --build
```

Backups should include at minimum:

- The Postgres database or `postgres_data` volume.
- The Redis volume if you need queue/session recovery across host loss.
- The MinIO `minio_data` volume, or the external object store bucket if you
  replace bundled MinIO.
- `.env.production` in your secret store.
- Caddy volumes `caddy_data` and `caddy_config`.
- Any Docker worker containers you intentionally keep for debugging are
  ephemeral task runtime state, not source-of-truth data.

## License And Seats

Roomote is licensed under the Fair Core License 1.0 (FCL-1.0-ALv2, see
[LICENSE](LICENSE)). A deployment is **free for up to 10 users** — every
registered user account counts toward the limit, whichever sign-in path or
surface it uses. Removing a user frees their seat.

To go beyond 10 users, obtain a license key from the Roomote maintainers and
apply it in either of these ways:

- Enter it in **Settings → Users → License** as an admin, or
- Set `R_LICENSE_KEY` in the deployment environment (for example
  `.env.production` / Compose). When set, the env var takes precedence over
  any key stored in Settings.

Keys are verified offline; your deployment never phones home.

When a deployment is at its seat limit, existing users are unaffected — only
new sign-ups are blocked until a seat is freed (Settings → Users → remove a
user) or a license key with more seats is added. Per the license terms, the
license key functionality may not be disabled or circumvented.

## Current Limits

- The first supported production shape is one self-managed host.
- Docker sandboxes are supported for that single-host shape. It is not a
  multi-host scheduler and it relies on trusted controller access to the host
  Docker socket.
- Production monitoring, backup automation, and secret rotation are operator
  responsibilities.
- Hosted preview/prod deployment automation is not part of this repository yet.
