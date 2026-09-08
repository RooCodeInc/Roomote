# Local Development

This guide is for contributors who want to develop Roomote from a local
checkout. If you want to operate Roomote for a team, start with the public
[Self-hosting docs](https://docs.roomote.dev/self-hosting) instead.

## Prerequisites

| Tool | Version | Notes |
| ---- | ------- | ----- |
| macOS | Latest | This guide is optimized for macOS. Apple Silicon runs the task worker natively (no amd64 emulation). |
| Docker Desktop | Latest | Provides Docker Engine and Compose for local services. |
| mise | Latest | Manages the repository toolchain. |
| ngrok | Latest | Optional, only when `R_PUBLIC_URL` uses an ngrok domain. |
| OpenCode CLI | Latest | Required to run tasks and server-side model calls. Install with `npm install -g opencode-ai`. |
| Python 3 | Latest | Required by the server-side OpenCode CLI helper. Install with `brew install python` if `python3` is missing. |

The dev toolchain runs on Node.js 24.13.1, pinned in `.tool-versions`,
`.nvmrc`, and `.node-version`. The `package.json` `engines` field accepts
22.x or 24.x, and `.npmrc` has `engine-strict=true`.

## Environment Setup

Roomote uses [mise](https://mise.jdx.dev/) to manage tool versions:

```sh
mise install
pnpm install
```

Treat the repo-managed `mise` toolchain as the default for commands like
`node`, `npm`, `pnpm`, `uv`, and `python`. If a tool is missing or resolves to
the wrong version, rerun `mise install` and retry with
`mise exec -- <command>`.

Copy the local env example only when you need to set a public callback URL or
provider credentials:

```sh
cp .env.local.example .env.local
```

Useful local values:

- `R_PUBLIC_URL` - stable public HTTPS URL for OAuth and webhook
  callbacks. If this is an ngrok domain, `pnpm dev` starts and reuses
  `ngrok http --url=<domain> 13000` for you.
- `R_MODEL` - required for local tasks. Use a models.dev-style
  `provider/model` id and expose the matching provider API key.
- source-control provider credentials - configured during `/setup`, or
  preconfigured in `.env.local` when boot-time env vars should satisfy setup.

A minimal model setup looks like this:

```sh
R_MODEL=openrouter/anthropic/claude-sonnet-4
OPENROUTER_API_KEY=...
```

For full provider setup, use the public docs:

- [Models and inference](https://docs.roomote.dev/models)
- [Communications](https://docs.roomote.dev/communications)
- [Source control](https://docs.roomote.dev/source-control)
- [Environment variables](https://docs.roomote.dev/environment-variables)

## Public Callback URLs

Local development needs a public HTTPS URL when you test auth providers,
communications providers, source-control callbacks, or Linear webhooks.

`pnpm dev` resolves one canonical public URL before starting services:

1. If `R_PUBLIC_URL` is set to an ngrok domain, Roomote starts or reuses
   `ngrok http --url=<domain> 13000`.
2. If `R_PUBLIC_URL` is set to any other HTTPS URL, Roomote uses it
   without starting ngrok.
3. If `R_PUBLIC_URL` is missing, startup fails before services start.

ngrok is convenient but not required. Any public HTTPS endpoint that reaches
port `13000` works, including Cloudflare Tunnel, Tailscale Funnel, a reverse
proxy in front of your own domain, or a deployed self-host URL.

Use a stable public URL for integration work. Slack, GitHub, Linear, OAuth
sign-in, and other providers store callback and webhook URLs in their own app
settings. If the URL changes, update those dashboards and restart `pnpm dev`.

If you use ngrok, install and authenticate it once:

```sh
brew install ngrok
ngrok config add-authtoken <your-ngrok-token>
```

### Granola managed automation webhooks

Create the custom automation before configuring its Granola binding. The public
[Granola guide](https://docs.roomote.dev/integrations/granola#managed-automation-triggers)
covers admin approval, shared-credential privacy, filters, and destination choice.
The meeting-data integration remains read-only; managed subscriptions are a
separate automation control surface.

Public: notes visible to everyone in the Granola workspace. The `public` scope
does not mean Internet-published notes and does not expand the shared key's access.

Provider ingress is `POST /api/webhooks/automations/:id`, where `:id` is the
trigger UUID, not the automation UUID; the route base is
`/api/webhooks/automations`. The managed callback is derived from
`R_PUBLIC_URL` (falling back to `R_APP_URL`) and requires public HTTPS. This
public, signature-authenticated route is distinct from the management API below.
It verifies Standard Webhooks HMAC-SHA256 over the raw request body with
`webhook-id`, `webhook-timestamp`, and `webhook-signature`, enforces a five-minute
timestamp tolerance and a 16 KiB body limit, and requires the envelope event ID
to match the signed header. The ingress only records event identity metadata;
it does not launch execution or persist raw payloads or meeting content.

Management routes are mounted under `/api/mcp/custom-automations` and use MCP
authentication plus acting-user authorization, not public webhook authentication:

| Method and relative path | MCP action | Authorization |
| --- | --- | --- |
| `GET /:id/webhook` | `webhook_inspect` | Owner or admin |
| `POST /:id/webhook` | `webhook_configure` | Admin |
| `DELETE /:id/webhook` | `webhook_remove` | Admin |
| `POST /:id/webhook/deliveries/:deliveryId/retry` | `webhook_retry` | Owner or admin |

See `apps/api/src/handlers/custom-automations/index.ts` for route handlers and
`packages/types/src/manage-custom-automations-tool.ts` for the shared MCP schema
and request mapping. Configuration replaces filters and applies defaults for
omitted fields; it is not a partial patch. Inspection must not expose signing
secrets. `canRetry` from inspection is authoritative: only `failed` deliveries
with no `sessionId` can be retried. Neither `running` deliveries nor previously
executed failures can be replayed. A queued retry is not a successful completed
run; unknown running outcomes require Session inspection, not replay.

The SDK service and dispatch implementation are in
`packages/sdk/src/server/automations/automation-webhooks.ts` and
`packages/sdk/src/server/automations/automation-webhook-dispatch.ts`. The database
admission and retention helpers are in
`packages/db/src/lib/automation-webhooks.ts`. Check these contracts together:

- Per-trigger daily invocation caps default to 20 and accept 1 through 100.
  Global webhook limits are 5 active invocations and 200 new invocations per UTC
  day. Daily accounting counts first launch reservations, not completions;
  retries of the same reservation do not count as a new invocation.
- Terminal deliveries (`succeeded` or `failed`) are eligible for cleanup after
  seven days from settlement, in bounded batches. Live work is not expired.
  Events older than seven days are rejected after deduplication metadata expires.
  Delivery retention does not imply deletion of Session context.
- Dispatch fetches a bounded note summary through the authenticated shared
  Granola connection and passes it as untrusted evidence for the saved prompt.
  It rechecks automation/owner availability, current admin approval, and the
  shared connection. Signing secrets remain encrypted at rest and are never
  returned by management inspection.
- Management fails closed locally while updating the provider. Interrupted
  `pending` or `deleting` operations can be reclaimed after two minutes. This
  management lease is distinct from delivery dispatch leases and never permits
  replaying work that already started.

Webhook execution uses the core durable runtime in
`packages/sdk/src/server/lib/fast-agent-parent-event-queue.ts`: the queued event
is promoted from `queued` to `inline` admission and resumes the same recorded
turn with its durable action journal after interruption or retry backoff.
Ordinary setup/reply failures are bounded to three attempts; inference retry
handoffs use the existing persisted runtime budget rather than consuming that
ordinary-attempt allowance. This is separate from the delivery dispatch retry
limit and is not an exactly-once guarantee for arbitrary external effects.
Inspect uncertain effects rather than assuming that replay is safe.

Ordinary removal cleans up the owned remote endpoint before deleting the local
binding. The service also reconciles endpoints with this trigger's exact
callback path (`/api/webhooks/automations/:id`) across host changes, not the full
URL, when a create response was lost, because the one-time signing
secret cannot be recovered. It removes that orphan before creating anew, not
unrelated subscriptions. Deleting an automation with a binding requires remote
cleanup first; provider failures leave the binding paused and recoverable.

For revoked credentials, first restore access to the same shared connection and
retry removal. If restoration is impossible, the admin-only `webhook_remove`
action accepts optional `forceLocalRemoval: true` for explicit emergency orphan
recovery. For an existing binding, the result is
`{removed: true, remoteCleanupRequired: {providerEndpointId, callbackUrl}}`.
Local removal skips provider calls, not the live-run guard: both ordinary and
emergency removal reject `dispatching` or `running` deliveries. Pause and wait
for settlement; inspect unknown outcomes rather than deleting or replaying them.
Preserve the returned endpoint ID and exact callback URL for authorized manual
cleanup in Granola, matching the exact trigger-specific path across host changes
if the ID is unknown. Confirm the remote orphan
is deleted before declaring cleanup complete or registering a replacement.
Revoking credentials alone does not prove remote deletion, and force removal
does not revoke the provider endpoint. The absent local binding prevents its
subsequent deliveries from being accepted.

Use mocked Granola responses and synthetic signed deliveries for local automated
checks. Do not create live subscriptions as part of ordinary tests. Before
claiming a deployment is ready, separately obtain authorization to verify the
real subscription, public HTTPS callback, matching and nonmatching events,
Session/report delivery, and remote update/removal. Mocked tests and docs checks
do not establish that external verification happened; record it explicitly as
not performed when no live checks were run. Never put API keys, signing secrets,
or private meeting content into test fixtures, logs, or proof artifacts.

## Database Services

Roomote uses local defaults for development services:

- Web: `http://localhost:13000`
- API/tRPC: `http://localhost:13001`
- BullMQ runtime dashboard: `http://localhost:13002/admin/queues`
- Preview proxy: `http://roomotepreview.localhost:18081`
- PostgreSQL: `postgres://postgres:password@localhost:15432/roomote_development`
- Redis: `redis://localhost:16379`
- MinIO API: `http://localhost:19000`
- MinIO console: `http://localhost:19001`

Roomote keeps server-side MinIO access on the local API port. Presigned
artifact URLs default to `R_PUBLIC_URL`, and the local Caddy edge proxies the
signed `/<bucket>/*` paths to MinIO. This lets E2B, Modal, Daytona, and other
hosted workers upload artifacts through the same public edge they use for API
callbacks. Set `S3_PRESIGN_ENDPOINT` explicitly only when using a separate
worker-reachable object-storage endpoint.

Start the database, Redis, and artifact-storage services:

```sh
pnpm db:up
```

Reset the local database:

```sh
pnpm db:reset
```

The reset leaves the database migrated but unseeded, so the setup bootstrap flow
runs from scratch. Run `pnpm db:seed` if you want the local admin identity back.

## Running the App

Start all Roomote services:

```sh
pnpm dev
```

`pnpm dev` uses PM2 to start the web app, API, preview proxy, BullMQ dashboard,
controller, and worker release watcher. It also resolves the public callback
URL, prepares the database, builds the local worker release archive, and ensures
the `roomote-worker:local` image exists.

Common options:

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--reset` | `false` | Reset the database before starting services. |
| `--verbose` | `false` | Enable verbose output with stdio logging. |
| `--skip-worker-release-build` | `false` | Reuse the existing worker artifact from `./releases`. |
| `--use-release` | `false` | Use GitHub worker releases instead of the local worker build. |
| `--worker-release-channel` | `stable` | GitHub worker release channel for `--use-release`. |
| `--worker-release-version` | unset | Optional GitHub worker release version pin. |

Examples:

```sh
pnpm dev
pnpm dev --reset
pnpm dev --skip-worker-release-build
pnpm dev --use-release --worker-release-channel preview --worker-release-version 0.0.371-preview.1
pnpm dev --verbose
```

Services are managed with PM2 after startup:

```sh
pm2 status
pm2 logs
pm2 logs roomote-web
pm2 dashboard
pm2 restart roomote-web
pm2 delete roomote-api roomote-web roomote-preview-proxy roomote-bullmq roomote-controller roomote-worker-release-watcher
```

## Local Diagnostics

After `pnpm dev` starts, run:

```sh
pnpm run doctor
```

The doctor checks local Postgres, Redis, MinIO, PM2 services, web/API,
controller, preview proxy, BullMQ health, public callback URL, auth provider
configuration, model provider configuration, and optional Teams bot settings.
Use `pnpm run doctor` instead of `pnpm doctor` because `pnpm doctor` is a pnpm
built-in command.

## Development Commands

Testing:

```sh
pnpm test
pnpm exec dotenvx run -f .env.test -- pnpm --filter <package> exec vitest run path/to/file.test.ts
```

Code quality:

```sh
pnpm lint
pnpm check-types
pnpm format
pnpm lint:fast
pnpm check-types:fast
pnpm knip
pnpm check
```

Database operations:

```sh
pnpm --filter @roomote/db db:push
pnpm db:generate
pnpm db:migrate
pnpm db:reset
```

Package management:

```sh
pnpm install
pnpm --filter @roomote/web add package-name
pnpm update
```

Storybook:

```sh
pnpm storybook
```

## Troubleshooting

### Database connection errors

```sh
docker ps
pnpm db:down && pnpm db:up
```

### Local environment problems

- Start from an empty `.env.local` when debugging core local startup.
- Copy `.env.local.example` only for overrides or integration credentials.
- If `pnpm dev` fails while starting ngrok, check that `R_PUBLIC_URL`
  matches your assigned ngrok domain and that ngrok has an auth token.
- If task creation hangs during classification or title generation, verify
  `python3` is available and that this succeeds:

```sh
opencode run --model <provider/model> "Return ok"
```

### Package installation issues

```sh
pnpm store prune
find . -name node_modules | xargs rm -rvf
pnpm install
```

### Docker issues

Restart Docker Desktop first. If the local Docker cache is badly wedged, clean
unused Docker data:

```sh
docker system prune -a
```

## Local Environment Variables

Roomote local development reads `.env.local` for operator-owned overrides. The
file is not encrypted and should not be committed.

Use `.env.local.example` as the reference for optional keys. Core local values
such as Postgres, Redis, MinIO artifact storage, web/API URLs, signing keys,
encryption keys, and preview proxy URLs have development defaults in
`@roomote/env`.

For production or shared self-host deployments, provide real secrets through
the deployment environment instead of relying on local defaults.

## Test Recipe

Test `@roomote/api` locally:

```sh
curl -X GET "http://localhost:13001/trpc/auth.me" \
  -H "Authorization: Bearer $(pnpm --silent --filter @roomote/auth development:create-auth-token local@roomote.dev local 3600000)" \
  -H "Content-Type: application/json" | jq
```
