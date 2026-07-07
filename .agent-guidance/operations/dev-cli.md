---
title: Dev CLI
status: active
last_reviewed: 2026-07-03
owner: engineering
summary: Technical documentation of the local development CLI covering local infra startup, database seeding, PM2 service startup, public ngrok callback URLs, and worker release artifacts.
---

# Dev CLI

The dev CLI (`@roomote/dev`) starts the local Roomote stack. The default
path uses local services plus `ROOMOTE_PUBLIC_URL` so Slack, Microsoft Teams,
Telegram, GitHub, GitLab, Linear, and auth callbacks have one stable externally
reachable HTTPS base URL. When that URL is an ngrok domain, the CLI manages the
matching static ngrok web tunnel.

## Main Command

```bash
pnpm dev
```

Common options:

| Option                        | Default  | Purpose                                             |
| ----------------------------- | -------- | --------------------------------------------------- |
| `--reset`                     | `false`  | Reset local infra before starting services          |
| `--verbose`                   | `false`  | Print child command output                          |
| `--skip-worker-release-build` | `false`  | Reuse an existing local worker release archive      |
| `--use-release`               | `false`  | Use GitHub worker release artifacts where supported |
| `--worker-release-channel`    | `stable` | Worker release channel for `--use-release`          |
| `--worker-release-version`    | unset    | Pin a specific worker release version               |

## Startup Flow

1. Validate local environment defaults from `@roomote/env`.
2. Resolve the public callback URL: require `ROOMOTE_PUBLIC_URL`, start or
   reuse a managed static ngrok web tunnel when that URL is an ngrok domain, or
   use the configured HTTPS origin directly when it is not an ngrok domain.
   The tunnel targets the local Caddy edge (port 18080), and `TRPC_URL` is
   derived as `<public-url>/_roomote-api`.
3. Stop existing Roomote PM2 services and any same-checkout legacy PM2
   entries left over from before the service-name migration.
4. Run package `dev:prepare` hooks and check required ports.
5. Start Docker Postgres, Redis, MinIO artifact storage, and the Caddy dev
   edge.
6. Reset the database when `--reset` is passed, or run `pnpm db:migrate`
   otherwise. Neither path seeds: the database stays empty after a reset so
   the next sign-in goes through the real setup bootstrap flow, and
   `pnpm db:seed` remains a manual opt-in for the local-admin identity.
7. Build the local worker release archive unless skipped or release mode is enabled.
8. Start PM2 services and validate health checks.

## Caddy Dev Edge

Local dev mirrors the deployed routing contract (`deploy/caddy/Caddyfile`)
with a `caddy-dev` container (config in `.docker/caddy/Caddyfile`, host port 18080) that is part of the standard `pnpm infra:up` set:

- The reserved `/_roomote-api/*` prefix is stripped and proxied to the API on
  13001; everything else goes to the web app on 13000.
- The managed ngrok tunnel targets the Caddy edge instead of the web app, so
  the single public URL serves both web and API. Non-ngrok
  `ROOMOTE_PUBLIC_URL` origins must route to port 18080, not 13000.
- `TRPC_URL=<public-url>/_roomote-api` is set for all PM2 services — the same
  derivation deployed environments use. This is what makes the API reachable
  from workers on hosted compute providers (Modal, Daytona, E2B);
  a localhost `TRPC_URL` is only reachable from Docker workers, whose spawn
  path rewrites it to `host.docker.internal`.

Trade-offs: service-to-service API calls round-trip through the tunnel (as
they do in deployed environments), and TLS, preview subdomains, and MinIO
artifact routing intentionally stay out of scope (ngrok terminates TLS, the
preview proxy keeps port 18081, and dev presigned S3 URLs point directly at
MinIO).

## Local Identity

`pnpm dev` no longer seeds the database automatically. The local bootstrap
identity (`local-user` / `local@roomote.dev`) and the `default` deployment
settings row are created only by an explicit seed command:

- `pnpm db:seed` — upserts the `local-user` admin and the `default`
  deployment settings row (preview off, setup incomplete).
- `pnpm db:reset` — full reset that chains `pnpm db:up` (migrated but
  unseeded); run `pnpm db:seed` afterwards if the seeded identity is needed.
- `pnpm db:seed:demo` — idempotent demo data set; in a fresh sandbox it
  additionally marks setup complete so the app is not gated behind `/setup`.

Without an explicit seed, a fresh local database has no `default` deployment
settings row and no bootstrap user until the first real sign-in / setup runs.
Dev login (`/auth/dev-login`) still upserts its own admin user on first visit,
so that path is unaffected.

This seeded identity exists so local database relations have a stable bootstrap
owner. Browser access still requires Better Auth sign-in through Slack or
Microsoft Teams. The first real signed-in provider user becomes the local
deployment operator, and later allowed users join the same deployment with the
same operator access. Roomote does not expose local member invitations or role
management.

## PM2 Services

Default local services:

- `roomote-api` on `http://localhost:13001`
- `roomote-web` on `http://localhost:13000`
- `roomote-preview-proxy` on `http://roomotepreview.localhost:18081`
- `roomote-bullmq` on `http://localhost:13002/admin/queues`
- `roomote-controller`
- `roomote-worker-release-watcher`

These services are runtime infrastructure, not the hosted product work queue.
Roomote does not expose the `/queue` dashboard route, but immediate local
tasks still need the controller and queue plumbing to execute.

Plain `pnpm dev` includes `roomote-web-ngrok` only when
`ROOMOTE_PUBLIC_URL` is an ngrok domain. Normal `pnpm dev` restarts preserve
and reuse that PM2 process so Slack, GitHub, and auth callbacks do not rotate
every time services restart.

When another local checkout already owns ngrok's default inspect API on
`127.0.0.1:4040`, the auto-started Roomote tunnel may bind a later inspect
port. The dev CLI scans the local ngrok inspect ports and selects the tunnel
whose upstream points at the Roomote Caddy edge port (`18080`), so Roomote can
run beside the private Roomote checkout without stealing its ngrok tunnels.

Docker Compose uses an `roomote` project with `roomote-postgres`
published on host port `15432`, `roomote-redis` published on host port
`16379`, `roomote-minio` published on host ports `19000` and `19001`, and
`roomote-caddy-dev` published on host port `18080`. This
lets Roomote and the private Roomote checkout run locally at the same time
without sharing local databases, Redis instances, artifact buckets, containers,
or PM2 service names.

Useful commands:

```bash
pm2 status
pm2 logs
pm2 logs roomote-web
pm2 delete roomote-api roomote-web roomote-preview-proxy roomote-bullmq roomote-controller roomote-worker-release-watcher
```

## Doctor

`pnpm run doctor` runs the local Roomote diagnostics entrypoint in
`apps/dev/src/doctor.ts`. It checks:

- Roomote Docker containers for Postgres, Redis, and MinIO
- required PM2 services
- web sign-in, API liveness/dependency health, controller health, preview proxy
  health, and BullMQ health
- `ROOMOTE_PUBLIC_URL` shape from the current PM2 web env or shell
- whether at least one Better Auth provider, including Microsoft Teams when
  configured, and one model provider key are configured
- optional Teams bot env var completeness when any Teams bot setting is present
- live Teams Azure Bot token exchange when Teams bot credentials are complete
- Teams public webhook callback reachability plus the Azure Bot messaging endpoint and Teams app `validDomains` values to configure

Missing auth and model providers are warnings because the stack can boot without
them, and incomplete Teams bot config is a warning because Teams callbacks are
optional. Sign-in, model-backed tasks, and Teams bot callbacks need those
credentials before they are usable. Failed container, PM2, or HTTP checks exit
nonzero.

HTTP checks use the configured `ROOMOTE_WEB_PORT`, `ROOMOTE_API_PORT`,
`ROOMOTE_BULLMQ_PORT`, and `ROOMOTE_PREVIEW_PROXY_PORT` values from the
discovered PM2 web env, self-host web container env, or current shell. Legacy
`OPENROOMOTE_*_PORT` names are still accepted as fallback values. If no valid
configured port is present, doctor falls back to the standard local defaults:
13000, 13001, 13002, and 18081.

## GitHub Bootstrap

`pnpm --filter @roomote/dev bootstrap:github-installation --installation-id <id> --user-id <user-id>` stores a GitHub installation for an existing local user.

## Preview Data

Preview and production setup are intentionally outside the default local flow.
Test-data scripts that require explicit `--org-id` and `--user-id` should use
seeded database IDs.

## Sandbox and Preview Demo Seed

`pnpm db:seed:demo` (root passthrough for
`pnpm --filter @roomote/db db:seed:demo`) inserts an idempotent demo data set:
a demo user, a demo GitHub installation, two demo repositories, a demo
environment, and a few tasks (each with a cloud job so they render in Task
History) in mixed states. When the singleton deployment settings row is
missing it is inserted with setup marked complete so a freshly seeded app is
not gated behind `/setup`. Every row is keyed by a stable identifier and only
inserted when missing, so the command is safe to re-run. Existing rows are
never updated or deleted.

The script is gated so it only runs where demo data is wanted:

- Inside a Roomote task sandbox, detected via `ROOMOTE_SANDBOX_SERVER_HOST`
  (injected into every sandbox setup-command shell) or `ROOMOTE_TASK_ID`
  (harness shells).
- When the app environment resolves to `preview` (`APP_ENV=preview` via
  `resolveAppEnv`).
- Anywhere else it refuses unless `--force` is passed, and it always refuses
  when the app environment resolves to `production` outside a sandbox.

The primary use is environment configs that run the app inside a task sandbox:
add `pnpm db:seed:demo` as a setup command after
`pnpm --filter @roomote/db db:migrate` so the sandboxed app starts with a
populated dashboard instead of an empty database.
