# Roomote V1 Production Deployments

This directory holds two deployment paths that share the same single-host
shape (`/opt/roomote`, `compose/docker-compose.prod.yml`, Caddy,
`roomote-compose.service`):

- **Self-serve one-command install** — a user runs [`install.sh`](install.sh)
  on their own server via `curl -fsSL https://get.roomote.dev | sudo bash` and
  finishes setup in the browser. The [`host/roomote`](host/roomote) CLI is
  installed alongside it for day-2 operations (`status`, `logs`, `upgrade`,
  `backup`, `restore`). See the One-Command Install section in
  [SELF_HOSTING.md](../SELF_HOSTING.md). `get.roomote.dev` is a small Vercel
  proxy in [`get-roomote/`](get-roomote/README.md) that serves the installer
  and mirrors its GitHub fetches while the source repo is private.
- **Operator-run deployer** — the rest of this README: provisions one
  DigitalOcean VM per customer with Terraform, installs Docker through
  cloud-init, pulls immutable GHCR image tags, runs the stack with Docker
  Compose, and uses Caddy for HTTPS.

A host installed by either path can be upgraded by either tool: `roomote
upgrade` on the host mirrors the `roomote-deploy upgrade` remote sequence.

Four PaaS-shaped paths run the same published images with
`R_AUTO_GENERATE_KEYS=true` instead of installer-generated keypairs:

- [`railway/`](railway/README.md) — managed Railway deployment with managed
  Postgres/Redis and hosted sandboxes instead of the
  Docker socket.
- [`render/`](render/README.md) — managed Render deployment from the
  Blueprint at the repository root ([`render.yaml`](../render.yaml)), with
  managed Postgres/Key Value and hosted sandboxes instead of the Docker
  socket.
- [`coolify/`](coolify/README.md) — a Docker Compose resource for a
  Coolify-managed server; the Docker socket is available there, so the
  `docker` sandbox provider is the default.
- [`fly/`](fly/README.md) — a maintained `fly.toml` that runs the stack as
  one Fly.io app (a process group per service) with Fly Managed Postgres,
  Upstash Redis, and Tigris object storage; like Railway, there is no
  Docker socket, so hosted sandboxes is required.

V1 is intentionally single-tenant. Do not use this flow to put multiple
customers on the same VM or database.

## Prerequisites

- Terraform 1.6+
- `ssh` and `scp`
- A DigitalOcean API token exported as `DIGITALOCEAN_TOKEN`
- A GHCR image tag that has already been published, for example `v0.1.0` for
  production or `develop-<short-sha>` for a preview soak
- DNS control for the app and preview domains
- An operator env file with production secrets

The published GHCR images are public and need no pull credentials.

## Images

Production deployments pull these images by immutable tag:

```text
ghcr.io/roocodeinc/roomote-app:<version>
ghcr.io/roocodeinc/roomote-worker:<version>
```

Every control-plane service (web, API, controller, BullMQ, preview proxy, and
migrations) runs from the shared non-root `roomote-app` image; the container
command and `ROOMOTE_SERVICE` select the service and its environment contract.
Privilege separation lives in the Compose files: read-only filesystems,
dropped capabilities, per-service env contracts, and a Docker socket proxy
reachable only from the controller service.

Do not deploy `latest`. Pushes to `develop` automatically publish
`develop-<short-sha>` image tags built with `R_APP_ENV=preview` for preview soak
deployments. Production releases use immutable `v*` tags; pushing a `v*` tag or
manually dispatching the GHCR workflow publishes that explicit version. Use the
same tag for create and upgrade commands.

## Environment File

Start from `.env.production.example`, keep the real file outside git, and pass
it with `--env`.

The deployer copies it to `/opt/roomote/.env`, rewrites deployment-owned
metadata from the CLI arguments, and sets:

```bash
chmod 600 /opt/roomote/.env
```

Deployment-owned image metadata includes the control-plane image tag, worker
image, and the controller-local `DOCKER_WORKER_RELEASE_PATH`. The release path is
versioned as `/roomote/releases/worker-v<version>.tar.gz` so hosted providers
such as Modal can derive worker release metadata from the archive filename.
The installer and deployer also keep `MODAL_BASE_IMAGE_REF` aligned with
`DOCKER_WORKER_IMAGE` if the Modal image is blank or still points at the
previously deployed worker image, so picking Modal in the setup wizard only
requires the Modal token pair. A different non-empty Modal image is treated
as an explicit operator override.

Both worker-image variables are optional on published app images:
when `DOCKER_WORKER_IMAGE` (and, for Modal, `MODAL_BASE_IMAGE_REF`) are
unset, the app derives `<worker repo>:${RELEASE_VERSION}` from the release
version baked into the app image — the publish workflow tags the app and
worker images in lockstep. The worker repository defaults to
`ghcr.io/roocodeinc/roomote-worker` and can be overridden with
`ROOMOTE_WORKER_IMAGE_REPO` (for forks or registry mirrors). Explicit values
always win over the derived default.

The optional Memory service follows the same release convention. With the
`brain` Compose profile enabled and `GBRAIN_IMAGE` unset, production Compose
pulls `${IMAGE_REGISTRY}/${IMAGE_NAMESPACE}/roomote-gbrain:${ROOMOTE_VERSION}`;
official installs therefore use
`ghcr.io/roocodeinc/roomote-gbrain:<matching-v*-release-tag>`. Set
`GBRAIN_IMAGE` only to pin a complete custom image reference. Installer reruns
and upgrades preserve that explicit override.

The file must include the required production values from
`.env.production.example`, especially:

- `S3_SECRET_ACCESS_KEY`
- `JOB_AUTH_PRIVATE_KEY`
- `JOB_AUTH_PUBLIC_KEY`
- `PREVIEW_AUTH_PRIVATE_KEY`
- `PREVIEW_AUTH_PUBLIC_KEY`
- `ENCRYPTION_KEY`
- `R_DISCORD_GATEWAY_SECRET` (Discord gateway↔API secret; generated on Discord save / install / upgrade when missing, and auto-healed at runtime when Discord is already configured without one)
- `ARTIFACT_SIGNING_KEY`
- `DASHBOARD_PASSWORD`
- `R_GITHUB_APP_SLUG`

Model provider values such as `R_MODEL` and `R_SMALL_MODEL` are
optional env-level overrides. Leave them unset when task models are managed
through Roomote runtime settings.

GitHub App credentials can be created from `/setup` with **Create GitHub App**
for local or first-run self-host setup. For production deploy env files, keep
using explicit GitHub App values when operators need stable, reviewed secrets
before rollout.

For the default local database mode, omit `DATABASE_URL` or set it to:

```bash
DATABASE_URL=postgres://postgres:roomote-postgres-password@postgres:5432/roomote
```

For managed Postgres, pass `--database external` and provide `DATABASE_URL` in
the env file. Redis and MinIO still run locally in V1 unless you point
`REDIS_URL` or S3 settings at managed services.

For bundled MinIO, keep `S3_ENDPOINT=http://minio:9000`. The deploy Compose
file defaults `S3_PRESIGN_ENDPOINT` to `https://$ROOMOTE_APP_DOMAIN`, and Caddy
routes `/$S3_BUCKET_ARTIFACTS/*` to MinIO without stripping the bucket path.
This keeps presigned artifact URLs reachable from Modal, Sandbox, Docker
workers, and browsers without requiring a separate object-storage hostname.

For a Cloudflare Tunnel deployment, including one-label preview hostnames that
work with standard wildcard certificates, follow the [Cloudflare Tunnel
guidance](../SELF_HOSTING.md#cloudflare-tunnel).

Use a separate preview env file for the `develop` soak. It should have its own
customer slug, domains, database, object storage bucket, auth keys, GitHub App
callback/webhook settings, and Terraform state. Keep the production env file for
`main` releases only. A typical split is:

```text
develop -> ~/.config/roomote-deploy/roomote-preview.env
main    -> ~/.config/roomote-deploy/roomote-production.env
```

Both files can start from `.env.production.example`; the distinction is the
deployment target and secret set, not a different Compose schema.

Set `R_APP_ENV=preview` in the develop env file. Production can omit `R_APP_ENV` or
set `R_APP_ENV=production`; both run with `NODE_ENV=production` because the
containers are production-built images.

The signing keys come from the operator, not from DigitalOcean. Generate two
fresh P-256 keypairs and store the PEMs as single-line base64:

```bash
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
```

`R_GITHUB_APP_PRIVATE_KEY` is the exception: download it from the GitHub App
settings page and store the raw PEM with newlines escaped as `\n`, not as
base64.

## Environment Variable Naming

Operator-facing environment variables follow three naming categories:

1. **`R_*` for Roomote-owned configuration.** Anything Roomote itself defines
   and an operator is expected to set — app URLs, model role overrides,
   Roomote's own registered integration-app credentials (GitHub App, Slack app,
   Microsoft/Teams app, Telegram bot, Linear app), allowed emails, and boot
   knobs such as `R_AUTO_GENERATE_KEYS`.
2. **Conventional infrastructure names stay conventional.** `DATABASE_URL`,
   `REDIS_URL`, `S3_*`, `NODE_ENV`, `HOST`, `PORT`, and similar
   ecosystem-standard names are not prefixed; tooling and platforms expect
   them as-is.
3. **Third-party provider credentials keep the provider's standard names.**
   `MODAL_*`, `E2B_*`, `DAYTONA_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and
   other keys issued by an external service keep the names that service's own
   documentation uses.

**Internal-plumbing carve-out:** variables Roomote sets for its own processes
— and that operators never configure — are not part of the naming contract and
keep their `ROOMOTE_*` names. This covers service wiring (`ROOMOTE_SERVICE`,
`ROOMOTE_ENV_FILE`, `ROOMOTE_DOCKER_LOAD_ENV_FILE`), worker/sandbox task
context (`ROOMOTE_TASK_ID` and friends), internal service auth
(`ROOMOTE_AUTH_BYPASS_HEADER_NAME`, `ROOMOTE_AUTH_BYPASS_VALUE`), and debug
escape hatches (`ROOMOTE_FORCE_TELEMETRY`,
`ROOMOTE_ALLOW_INSECURE_LOCAL_KEYS`).

**Explicit exceptions** — operator-visible names that intentionally keep the
`ROOMOTE_*` prefix:

- `ROOMOTE_APP_DOMAIN`, `ROOMOTE_PREVIEW_DOMAIN`, `ROOMOTE_VERSION` —
  installer-written `.env` interpolation keys consumed by the host CLI, Caddy,
  and the upgrade-compatibility CI lane; renaming them would break N-1
  upgrades.
- `ROOMOTE_PREVIOUS_VERSION`, `ROOMOTE_BACKUP_PASSPHRASE`,
  `ROOMOTE_IMAGE_RETENTION_RELEASES` — host CLI upgrade/backup/prune state and
  knobs, owned by the same installer machinery.
- `ROOMOTE_WORKER_IMAGE_REPO` — read at runtime by the previous release while
  both releases run during the upgrade expand window, so it cannot be renamed
  without breaking mirrored-registry worker resolution mid-upgrade.
- `ROOMOTE_ENVIRONMENTS_DIR`, `ROOMOTE_ENVIRONMENTS_YAML` —
  declarative-environments inputs; rename deferred until it can ship with its
  own compatibility window.

The `APP_ENV` / `ROOMOTE_APP_URL` / `ROOMOTE_PUBLIC_URL` aliases in
`deploy/compose/docker-compose.prod.yml` are not exceptions: they are a
temporary dual-write shim that keeps the previous release bootable during the
upgrade expand window and will be removed once the N-1 window passes.

## DNS

The app domain and wildcard preview domain must resolve to the droplet. A
separate preview domain is only needed when opting out of flat preview
hostnames:

```text
<domain>                 A  <droplet-ip>
*.<domain>               A  <droplet-ip>
<preview-domain>         A  <droplet-ip>  # dedicated preview namespace only
*.<preview-domain>       A  <droplet-ip>  # dedicated preview namespace only
```

To let Terraform create these records in DigitalOcean DNS, pass
`--manage-dns --dns-zone <zone>`. The app domain and any explicit preview
domain must be inside that zone.

Caddy serves web and worker-facing API traffic on the app domain. The app
domain routes public `/api/webhooks/*` requests directly to the API, routes the
reserved `/_roomote-api/*` prefix to the API after stripping that prefix,
routes the configured artifact bucket path to MinIO for presigned S3 requests,
and sends other app-domain paths to the web container.

## Create A Deployment

```bash
export DIGITALOCEAN_TOKEN='dop_v1_...'

deploy/scripts/roomote-deploy create \
  --customer matt-test \
  --domain matt-test.roomote.dev \
  --provider digitalocean \
  --region nyc3 \
  --version v0.1.0 \
  --env ./customer.env
```

With DigitalOcean DNS management:

```bash
deploy/scripts/roomote-deploy create \
  --customer matt-test \
  --domain matt-test.roomote.dev \
  --provider digitalocean \
  --region nyc3 \
  --version v0.1.0 \
  --env ./customer.env \
  --manage-dns \
  --dns-zone roomote.dev
```

The create command writes local Terraform state and deployment metadata under:

```text
deploy/state/<customer>/
```

This directory is gitignored and should be backed up by the operator if the
deployment will be managed long-term from this checkout.

## Upgrade

For the `develop` soak, use the `develop-<short-sha>` tag published by the
latest successful GHCR workflow run. For production, publish the new `v*` GHCR
images first, then run:

```bash
deploy/scripts/roomote-deploy upgrade \
  --customer matt-test \
  --version v0.1.1
```

Rollback is the same command with the previous image tag:

```bash
deploy/scripts/roomote-deploy upgrade \
  --customer matt-test \
  --version v0.1.0
```

The upgrade command SSHes to the VM, refreshes the Compose and Caddy files under
`/opt/roomote`, updates deployment-owned image and URL metadata in `.env`, and
syncs a deployer-managed `MODAL_BASE_IMAGE_REF` to the new worker image before
running:

```bash
cd /opt/roomote
docker compose --env-file .env -f docker-compose.prod.yml config >/dev/null
docker compose --env-file .env -f docker-compose.prod.yml stop controller || true
DOCKER_WORKER_IMAGE="$(awk -F= '/^(export[[:space:]]+)?DOCKER_WORKER_IMAGE=/ { sub(/^[^=]*=/, ""); print; exit }' .env)"
docker pull "$DOCKER_WORKER_IMAGE"
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml run --rm db-migrate
docker compose --env-file .env -f docker-compose.prod.yml up -d --wait --wait-timeout 600
```

Database migrations run as a dedicated one-shot step after images are pulled
and before any running service is replaced. If the migration step fails, the
deployer restarts the previous controller and exits with the previous release
still serving; see the compatibility policy below for why that is always safe.
The on-host `roomote upgrade` additionally creates an encrypted pre-upgrade
backup and restores the previous deployment configuration files when the
migration step fails.

The Compose file defines container healthchecks for `web`, `api`, `controller`,
`bullmq`, and `preview-proxy`. The controller probe uses the API's Redis
heartbeat and stuck-task checks; the BullMQ probe queries its queues. `up
--wait` holds the deploy command until the complete execution plane is healthy.
The deployer stops the controller before deployment metadata
changes and image pulls so new tasks remain queued during rollout instead of
being claimed by the old controller. The wait timeout is intentionally longer
than the controller stop grace so any already-active hosted-provider spawn can
finish or fail during replacement. Caddy waits for those services when it
starts and also retries a briefly unavailable upstream for a short window. This
reduces deploy blips during single-container recreates, but it is not a full
blue/green deployment.

After a successful `up --wait`, the deployer prunes old Roomote images by
release tag count. It always keeps the current `ROOMOTE_VERSION`, then keeps
the newest local Roomote image tags until the retained set reaches
`ROOMOTE_IMAGE_RETENTION_RELEASES` total tags (default `3`). It removes older
unused `ghcr.io/<namespace>/roomote-*` image references. Docker still refuses
to remove any image used by a running or stopped container. Use
`--image-retention-releases <n>` or export `ROOMOTE_IMAGE_RETENTION_RELEASES`
to adjust rollback depth for a deployment. Retention is best-effort after a
healthy rollout; a Docker cleanup failure prints a warning instead of failing
the completed deploy or upgrade.

## Upgrade And Migration Compatibility Policy

This is the contract between releases, migrations, and the upgrade tooling.
Schema changes that cannot satisfy it must be split across releases.

### Expand/contract migrations

Every migration must keep the previous release working against the new
schema. Ship schema changes in two phases:

- **Expand** (safe in any release): add tables, add nullable columns, add
  columns with database-side defaults, add indexes, widen types, add enum
  values. New code reads and writes the new shape; old code keeps working
  because nothing it uses changed.
- **Contract** (only after no supported version references the old shape):
  drop or rename tables and columns, add `NOT NULL` to existing columns,
  narrow types, remove enum values. A rename is an expand (add the new
  column, dual-write, backfill) followed by a contract (drop the old column)
  at least one release later.

Long-running backfills do not belong in migrations. Run them as idempotent
application code after the rollout so the migration step stays fast enough
for the rollout timeout below.

### Minimum rollback-compatible version

The schema produced by release N must support the application code of the
release immediately before it (N-1). The supported rollback target is
therefore always the previously deployed release, without undoing
migrations: roll the application back and leave the schema at N. Rolling
back more than one release is not guaranteed by this policy; use the
pre-upgrade backup bundle for that instead.

### Pre-upgrade backup

`roomote upgrade` creates an encrypted backup bundle (the same format as
`roomote backup`) before it changes any deployment file or container. The
passphrase comes from `--backup-passphrase-file`, then
`ROOMOTE_BACKUP_PASSPHRASE`; with neither, the command generates one and
stores it next to the bundle under `/opt/roomote/backups/`, in the same
trust domain as `/opt/roomote/.env`. Move both off-host if the bundle
should double as a disaster-recovery copy. `--skip-backup` opts out, and
`roomote rollback` skips it by design so an unhealthy stack cannot block
the rollback. The operator-run deployer does not back up implicitly; run
`roomote-deploy backup` before production upgrades.

### Migration lock and timeout behavior

Migrations run as the one-shot `db-migrate` service from the release being
deployed. Drizzle applies all pending migrations inside a single
transaction, so a failed migration rolls the schema back to its previous
state. There is no advisory lock and no statement timeout on the migration
step itself; single-writer behavior comes from running one `db-migrate`
container per deployment, so never run two upgrades against the same
database concurrently. Every application service in the Compose stack waits
on `db-migrate` completing successfully before it starts, and the rollout as
a whole is bounded by `up --wait --wait-timeout 600`.

### Failure behavior

The upgrade sequence pulls images first, then runs migrations, and only then
replaces running services. A migration failure aborts the upgrade with the
previous release still serving: `roomote upgrade` restores the previous
Compose, Caddy, and `.env` files and restarts the controller; the deployer
restarts the controller and asks the operator to re-run with the previous
tag. A failure after migrations succeeded (for example `up --wait` timing
out) leaves the schema at the candidate version, which the previous release
supports by the rule above, so `roomote rollback` or an upgrade to the
previous tag recovers without touching the database.

### Rollback path

- `roomote rollback` re-deploys the release recorded in
  `ROOMOTE_PREVIOUS_VERSION` by the last upgrade.
- `roomote upgrade <previous-tag>` (or `roomote-deploy upgrade --version
<previous-tag>`) is the explicit equivalent and works for any retained tag.
- `roomote restore <bundle> --yes` with the pre-upgrade bundle is the
  last-resort path and also rewinds the database and artifacts.

Image retention keeps the current release plus the newest tags (default 3
total), so the rollback image is normally still on the host. The restore
path is exercised in CI on every non-docs change (the backup-restore job),
and the rollback path is exercised against real images by the publish gate
below.

### Version visibility

Settings -> Deployment -> Diagnostics surfaces the running application
version (`Roomote version`, from the `RELEASE_VERSION` baked into the image)
and the schema version (`Current migration`, the latest applied Drizzle
migration hash). The same pair is recorded in every backup manifest as
`roomoteVersion` and `schemaVersion`, and `/opt/roomote/.env` records
`ROOMOTE_VERSION` plus the `ROOMOTE_PREVIOUS_VERSION` rollback target.

### CI enforcement

- **Upgrade Compatibility** (`.github/workflows/CI.yml`, every non-docs PR):
  boots the previous published release from GHCR, applies the candidate
  branch's migrations to its database, and requires the previous release to
  stay healthy, including a cold restart, on the candidate schema
  ([`deploy/ci/upgrade-compatibility.sh`](ci/upgrade-compatibility.sh)).
- **Fresh-host Backup Restore** (every non-docs PR): restores an encrypted
  bundle onto empty volumes
  ([`deploy/host/tests/backup-restore.integration.sh`](host/tests/backup-restore.integration.sh)).
- **Deployment acceptance** (`publish-ghcr.yml`, gates every image publish):
  builds candidate images, upgrades the previous published release to the
  candidate, rolls back, re-upgrades, launches a real Docker task, and
  restores a backup onto fresh volumes
  ([`deploy/ci/deployment-smoke.sh`](ci/deployment-smoke.sh)).

## Back Up a Deployment

Create a passphrase file in your secret manager or a temporary root-readable
file. The passphrase must be stored separately from the bundle:

```bash
umask 077
openssl rand -base64 32 > /secure/path/roomote-backup-passphrase
```

Then create the backup:

```bash
deploy/scripts/roomote-deploy backup \
  --customer matt-test \
  --passphrase-file /secure/path/roomote-backup-passphrase \
  --include-redis
```

It creates an encrypted, versioned `.roomote` bundle in
`/opt/roomote/backups/` and copies it to:

```text
deploy/state/matt-test/backups/
```

The bundle contains:

- a PostgreSQL dump;
- `/opt/roomote/.env`, including the original `ENCRYPTION_KEY` and signing
  keys, plus the Compose and Caddy configuration;
- the local MinIO data volume, or a manifest identifying an external bucket;
- Redis when `--include-redis` is present;
- the Roomote release, schema version, checksums, and exact image digests.

The backup stops application writers and Docker task workers before capturing
the stores. This gives PostgreSQL, local MinIO, and optional Redis an
application-quiesced consistency point, but creates a maintenance window. With
external object storage, bucket objects are not copied; use provider-level
bucket backups as well.

Equivalent on-host command:

```bash
roomote backup \
  --passphrase-file /secure/path/roomote-backup-passphrase \
  --include-redis
```

## Restore a Deployment

Install Roomote on the replacement host first so Docker and the host CLI are
present. Restores are intentionally explicit because they replace
configuration, keys, database records, artifacts, and optional Redis state:

```bash
deploy/scripts/roomote-deploy restore \
  --customer matt-test \
  --backup deploy/state/matt-test/backups/backup-20260710T120000Z.roomote \
  --passphrase-file /secure/path/roomote-backup-passphrase \
  --yes
```

Restore decrypts and verifies the full bundle before changing the target host.
It then stops the new installation, restores the original `.env` and release
files, repins the recorded image digests, repopulates empty local MinIO and
Redis volumes, restores PostgreSQL, and brings the recorded stack up with
`--wait`. If Redis was omitted, its target volume is cleared. External object
storage must already contain the objects referenced by the restored database.

Equivalent command after copying a bundle to the new host:

```bash
roomote restore /opt/roomote/backups/backup.roomote \
  --passphrase-file /secure/path/roomote-backup-passphrase \
  --yes
```

## Destroy

Destroying deletes the DigitalOcean droplet, firewall, optional volume, and DNS
records managed by this Terraform state:

```bash
deploy/scripts/roomote-deploy destroy \
  --customer matt-test \
  --yes
```

The command leaves `deploy/state/<customer>/` on disk for audit purposes.

## VM Layout

The bootstrap writes:

```text
/opt/roomote/.env
/opt/roomote/deployment.env
/opt/roomote/docker-compose.prod.yml
/opt/roomote/caddy/Caddyfile
/opt/roomote/backups/
/etc/systemd/system/roomote-compose.service
```

`deployment.env` is bootstrap metadata only. `roomote-compose.service` restarts
the Compose stack after VM reboot and uses `/opt/roomote/.env` as the runtime
source of truth.

## Terraform Module

The DigitalOcean module lives in `deploy/providers/digitalocean` and provisions:

- one Ubuntu droplet
- a firewall for SSH, HTTP, and HTTPS
- an operator SSH key or existing SSH key fingerprint
- optional DNS records
- optional attached volume mounted at `/var/lib/docker`
- cloud-init Docker bootstrap

Useful outputs:

```bash
terraform -chdir=deploy/providers/digitalocean output \
  -state=deploy/state/matt-test/terraform.tfstate
```
