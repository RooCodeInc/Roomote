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

## LLM Evaluations

The LLM routing service uses [Promptfoo](https://www.promptfoo.dev/)
evaluations to verify routing prompts against a live LLM.

```sh
pnpm evals
pnpm eval:router
pnpm eval:router:followup
pnpm eval:router:view
pnpm eval:router:share
```

Eval configs and datasets live in `packages/cloud-agents/evals/router/`.
They are not run in CI by default. Runtime routing, title generation, and
summaries use `R_SMALL_MODEL`, falling back to `R_MODEL`. Set
`ROUTER_EVAL_PROVIDER` or `ROUTER_FOLLOWUP_EVAL_PROVIDER` to test a
different promptfoo provider.

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
