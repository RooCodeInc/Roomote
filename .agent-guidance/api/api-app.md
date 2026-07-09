---
title: API App
status: active
last_reviewed: 2026-07-09
owner: engineering
summary: Technical documentation of the Hono API app covering route mounting, middleware, and the handler families hosted in apps/api.
---

# API App

`apps/api` is the Roomote host process for backend-to-backend tRPC, webhook intake, MCP proxy routes, task/session control endpoints, artifact APIs, public sandbox OIDC metadata, and health checks. The detailed contracts for individual webhook and tRPC surfaces live in neighboring docs; this page owns the application-level shape of the Hono server that mounts them.

## Core Entry Points

| File                                                                     | Role                                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [`apps/api/src/index.ts`](../../apps/api/src/index.ts)                   | Process entrypoint that installs instrumentation and calls `runApiServer()`         |
| [`apps/api/src/bootstrap.ts`](../../apps/api/src/bootstrap.ts)           | Startup wrapper that captures startup failures and flushes API Sentry before exit   |
| [`apps/api/src/server.ts`](../../apps/api/src/server.ts)                 | Builds the Hono app, installs middleware, mounts routes, and starts the HTTP server |
| [`apps/api/src/handlers/index.ts`](../../apps/api/src/handlers/index.ts) | Barrel that defines the route families mounted by the server                        |

## Route Mounting

[`createApiApp()` in `apps/api/src/server.ts`](../../apps/api/src/server.ts) mounts the current route families in one place:

| Public path prefix                                                      | Mounted handler                                | Main responsibility                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`, `/health`, `/health/api`, `/health/liveness`, `/health/controller` | `apiHealth`, `apiLiveness`, `controllerHealth` | API-process and controller heartbeat health reporting; `/health` is a rate-limited alias of the same DB+Redis readiness handler as `/` and `/health/api`, `/health/liveness` is the dependency-free process check, and authenticated callers receive the fuller diagnostic payloads |
| `/api/webhooks/github`                                                  | `github`                                       | GitHub App webhook intake                                                                                                                                                                                                                                                           |
| `/api/webhooks/slack`                                                   | `slack`                                        | Slack Events API and interactive payload intake                                                                                                                                                                                                                                     |
| `/api/webhooks/teams`                                                   | `teams`                                        | Microsoft Teams Bot Framework activity intake                                                                                                                                                                                                                                       |
| `/api/webhooks/telegram`                                                | `telegram`                                     | Telegram Bot API update intake                                                                                                                                                                                                                                                      |
| `/api/webhooks/linear`                                                  | `linear`                                       | Linear Agent Session webhook intake                                                                                                                                                                                                                                                 |
| `/api/mcp`                                                              | `mcp`                                          | Worker-facing MCP routes, including integration proxies, native MCP handlers such as Snowflake, and task and environment sub-routes                                                                                                                                                 |
| `/api/mcp/tasks`                                                        | `mcp -> tasksRouter`                           | Task search, summaries, transcript history, follow-up messages, steering, stop/cancel, compute logs, launch, and task-suggestion APIs                                                                                                                                               |
| `/api/mcp-routing`                                                      | `mcpRouting`                                   | Router-facing allowlisted MCP access during task routing                                                                                                                                                                                                                            |
| `/api/cloud-jobs`                                                       | `cloudJobsRouter`                              | Cloud job logs and worker-facing runtime streams                                                                                                                                                                                                                                    |
| `/api/artifacts`                                                        | `artifactsRouter`                              | Artifact upload, completion, metadata, and download URL APIs                                                                                                                                                                                                                        |
| `/api/tasks`                                                            | `taskArtifactsRouter`                          | Task-scoped artifact listing and artifact metadata lookup by task-relative artifact path                                                                                                                                                                                            |
| `/.well-known/openid-configuration`, `/api/oidc/jwks`                   | `oidcRouter`                                   | Public sandbox OIDC discovery metadata and JWKS for machine trust configuration                                                                                                                                                                                                     |
| `/trpc`                                                                 | `trpc`                                         | Backend-to-backend SDK tRPC router                                                                                                                                                                                                                                                  |

The production self-host proxy exposes this Hono app under
`ROOMOTE_APP_DOMAIN/_roomote-api/*` and strips `/_roomote-api` before proxying
to `api:3001`. It must not send every `/api/*` request to Hono because the
Next.js web app owns browser and OAuth paths such as `/api/auth/*`,
`/api/trpc`, `/api/slack/*`, artifact compatibility routes, and preview-auth
routes.

## Child Surface Inventory

| Sub-surface                         | Kind         | Coverage   | Owning doc                                             | Notes                                                                                                                             |
| ----------------------------------- | ------------ | ---------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/handlers/trpc/`       | api          | documented | [SDK tRPC Router](./trpc-sdk.md)                       | Mounts the backend-to-backend tRPC stack served from `/trpc`.                                                                     |
| `apps/api/src/handlers/github/`     | api          | documented | [Webhook Handlers](./webhooks.md#github-webhooks)      | GitHub webhook intake and GitHub-triggered task orchestration.                                                                    |
| `apps/api/src/handlers/slack/`      | api          | documented | [Webhook Handlers](./webhooks.md#slack-webhooks)       | Slack Events API, interactive payloads, and Slack task bootstrap.                                                                 |
| `apps/api/src/handlers/teams/`      | api          | documented | [Webhook Handlers](./webhooks.md#teams-webhooks)       | Microsoft Teams Bot Framework activity intake and provider-neutral chat task entry.                                               |
| `apps/api/src/handlers/telegram/`   | api          | documented | [Webhook Handlers](./webhooks.md#telegram-webhooks)    | Telegram Bot API update intake and provider-neutral chat task entry.                                                              |
| `apps/api/src/handlers/linear/`     | api          | documented | [Webhook Handlers](./webhooks.md#linear-webhooks)      | Linear webhook intake and Agent Session bridging.                                                                                 |
| `apps/api/src/handlers/mcp/`        | feature      | documented | [MCP Server Configuration](../features/mcp-servers.md) | Worker-facing and router-facing MCP routes, including integration proxies, native MCP handlers, auth, and integration forwarding. |
| `apps/api/src/handlers/tasks/`      | api          | documented | [API App](./api-app.md#task-and-session-handlers)      | Task launch, messaging, steering, stopping, and task-suggestion submission APIs.                                                  |
| `apps/api/src/handlers/cloud-jobs/` | api          | documented | [API App](./api-app.md#task-and-session-handlers)      | Cloud job log and stream endpoints used by running task UIs and workers.                                                          |
| `apps/api/src/handlers/oidc/`       | api          | documented | [API App](./api-app.md#public-oidc-handlers)           | Public sandbox OIDC discovery and JWKS routes mounted at the root app level.                                                      |
| `apps/api/src/handlers/artifacts/`  | api          | documented | [API App](./api-app.md#artifact-handlers)              | Artifact creation, upload completion, metadata, per-task listing, and signed download URLs.                                       |
| `apps/api/src/middleware/`          | architecture | documented | [API App](./api-app.md#runtime-and-middleware)         | Request observability, bearer-token auth, and `/health` rate-limit middleware.                                                    |
| `apps/api/src/monitoring/`          | operations   | documented | [API App](./api-app.md#runtime-and-middleware)         | API Sentry capture and request-level observability support.                                                                       |

## Runtime And Middleware

The API app uses one shared Hono process with global middleware applied before route mounting:

- `requestObservabilityMiddleware` runs on every request and supplies the request metadata used by the API's slow-request and trace logging.
- `healthRateLimitMiddleware()` applies a basic in-memory fixed-window per-client-IP budget (default 60/min, `API_HEALTH_RATE_LIMIT_PER_MINUTE`, `0` disables) to the bare `/health` alias only; over-limit requests get `429` with `Retry-After`, and the `/`, `/health/api`, and `/health/liveness` mounts stay unlimited for external monitors and deployment healthchecks.
- CORS is configured separately for `/api/*` and `/trpc/*`, with credentials enabled for both surfaces.
- `tokenAuthMiddleware()` resolves bearer tokens for worker, MCP, backend, and health-check callers.
- `/admin` gets HTTP basic auth outside development.
- `installApiObservedFetch()` installs the API's outbound observed-fetch wrapper so slow external requests and request IDs are captured consistently.

Two exact paths are intentionally outside the normal auth stack: `PUBLIC_OIDC_PATHS` in [`apps/api/src/server.ts`](../../apps/api/src/server.ts) matches `/.well-known/openid-configuration` and `/api/oidc/jwks`, and the bearer-token middleware wrapper short-circuit for those requests before continuing to the mounted handler. No broader `/api/oidc/*` or root-path auth bypass exists; only those machine-consumed discovery documents skip auth. Health routes still remain callable without credentials because the bearer-token middleware is optional there, but valid authenticated callers can receive the richer diagnostic payloads while unauthenticated callers see only the minimal public fields.

The startup wrapper in [`apps/api/src/bootstrap.ts`](../../apps/api/src/bootstrap.ts) is intentionally small: the Hono app is created lazily, startup exceptions are reported to the API Sentry project, and the process exits only after `flushApiSentry()` completes.

## Task And Session Handlers

The API app hosts the non-browser control plane that does not fit cleanly in the tRPC routers:

- `apps/api/src/handlers/tasks/` exposes task search, task summaries, task transcript history, follow-up message delivery, steering messages, stop requests, and task-suggestion submission.
- Those task-control handlers are served from `/api/mcp/tasks` because `handlers/mcp/index.ts` mounts `tasksRouter` under the MCP surface; the top-level `/api/tasks` mount is reserved for `taskArtifactsRouter`.
- `POST /api/mcp/tasks` is the admin-authenticated generic launch endpoint for programmatic task execution. It still accepts the existing standard-task launch shape, and now also accepts environment-definition and suggested-task launches with repository-set targeting, optional `environmentId`, `setupGuidance`, transcript visibility controls, and the useful task enqueue passthroughs such as `branch`, `sha`, `computeProvider`, `harness`, `model`, and `reasoningEffort`; `bootstrap` remains a standard-task-only passthrough so environment-definition launches always enter the generated `$environment-setup` workflow. `harness` + `model` are resolved through the shared `resolveEvalHarnessSelection` helper (the same one the Slack `!eval` launcher uses): a `model` is translated into `payload.harnessModelOverrides` for the resolved harness (OpenCode catalog models also pin `harness: 'opencode-server'`), and an inconsistent pairing — a non-catalog model on OpenCode, an OpenCode-only model on OpenCode, an unknown harness, or `reasoningEffort` on OpenCode — returns `400` instead of silently dropping the model. Programmatic launches opt out of the removed hosted Work Queue behavior and always return `{ success: true, cloudJobId, taskId }`.
- `GET /api/mcp/tasks/:taskId/summary` now includes `linkedEnvironmentId` and `linkedEnvironmentName` when the latest cloud job payload is linked to an environment-definition record, so smoke tests and worker callers can follow onboarding-created environments without heuristic matching.
- `apps/api/src/handlers/cloud-jobs/` exposes cloud-job log access and stream endpoints for running tasks.
- These handlers complement the SDK tRPC router instead of replacing it: long-lived worker/runtime calls still prefer `/trpc`, while UI-specific or integration-specific HTTP endpoints continue to live under `/api/mcp/tasks`, `/api/tasks`, or `/api/cloud-jobs` depending on whether they are control-plane or artifact-specific.

This split is why `apps/api` needs its own application-level doc: the app is more than a tRPC host, and more than a webhook host.

## Public OIDC Handlers

One non-browser surface lives directly in `apps/api` rather than under the SDK router:

- `apps/api/src/handlers/oidc/` mounts the public sandbox OIDC endpoints. `/.well-known/openid-configuration` returns the issuer metadata rooted at `Env.TRPC_URL` after trimming trailing slashes, and `/api/oidc/jwks` returns the active verification keys with the shared OIDC metadata cache headers. Both routes fail closed when sandbox OIDC key material is not configured.

## Artifact Handlers

The remaining handler families are application-owned rather than product-surface-owned:

- `apps/api/src/handlers/artifacts/` implements artifact creation, upload completion, metadata reads, per-task artifact listing, and signed download URL helpers.
  These routes accept only `cj` bearer tokens and must bind the token claims to
  the persisted `cloud_jobs` row. Artifact writes (creation and upload
  completion) must confirm that row belongs to the requested task. Artifact
  reads (metadata, download URLs, and the `GET /api/tasks/:taskId/artifacts`
  listing, which returns the latest uploaded version per path with `viewUrl`
  and signed image `rawUrl` values matching the upload response) allow the
  job's own task plus cross-task reads of any visible task, mirroring the
  cross-task read access the MCP task routes already grant to cloud job
  tokens.
- `apps/api/src/handlers/environments/` is currently mounted through the MCP surface rather than the main server barrel, because worker and tool-driven environment operations reuse the MCP auth/mount path.

## Relationship To Neighboring Docs

Use this page when the question is about **how `apps/api` is structured as an app process**.

Use neighboring docs when the question is about a narrower contract:

- [SDK tRPC Router](./trpc-sdk.md) for the backend-to-backend router under `/trpc`
- [Webhook Handlers](./webhooks.md) for GitHub, Slack, Teams, Telegram, and Linear webhook semantics
- [MCP Server Configuration](../features/mcp-servers.md) for MCP proxy behavior and configuration
- [Cloud Job Execution Architecture](../architecture/cloud-job-execution.md) for worker/controller runtime behavior downstream of the API app
