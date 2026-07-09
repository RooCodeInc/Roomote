---
title: Monitoring & Health Checks
status: active
last_reviewed: 2026-07-09
owner: engineering
summary: Technical documentation of local health monitoring covering API endpoints, request observability, optional Sentry capture, controller heartbeat, orphan detection, and common debugging patterns.
---

# Monitoring & Health Checks

Roomote's monitoring infrastructure provides local visibility into system health through dedicated endpoints, automated orphan detection, scheduled health checks, PM2 logs, and the BullMQ dashboard. This document covers operational monitoring patterns, debugging workflows, and key implementation details. Roomote emits opt-out anonymous product analytics through the hosted Ping service (see [Anonymous Analytics & Version Checks](../features/anonymous-analytics.md)); PostHog also remains available as an operator-configured MCP integration that agents can inspect when a workspace connects it.

## Overview

Health monitoring is implemented across eleven primary layers:

1. **API health endpoints** — Database and Redis connectivity checks
2. **API request observability** — Slow endpoint logging, per-endpoint tallies, and outbound third-party request timing
3. **Web error capture** — Optional Sentry browser/App Router/server/edge reporting from the Next.js app
4. **API Sentry error capture** — Optional startup failures and uncaught Hono request errors
5. **Controller Sentry reporting** — Optional process-level exception capture for the dispatcher service
6. **Worker Sentry reporting** — Optional process-level exception capture and harness-log attribution for worker executions
7. **Worker setup logs** — Local setup logs emitted through worker/runtime logs
8. **BullMQ Sentry reporting** — Queue-level operational failure capture for scheduled jobs and snapshot flows
9. **Controller heartbeat** — Active controller liveness tracking via Redis
10. **Orphan detection** — Automated recovery of stuck jobs
11. **BullMQ dashboard** — Queue inspection and job management

## Web Error Reporting

The web app initializes `@sentry/nextjs` for browser, Node.js, and edge runtime error capture. Browser errors are captured from `instrumentation-client.ts`, App Router global errors are reported from `global-error.tsx`, and server request errors flow through the Next.js `onRequestError` export in `instrumentation.ts`. The app shell does not initialize hosted third-party browser analytics providers such as PostHog, GTM, or HubSpot; the only product analytics is Roomote's own opt-out anonymous pipeline, which relays through the app backend to the Ping service (see [Anonymous Analytics & Version Checks](../features/anonymous-analytics.md)).

**Implementation:**

- `apps/web/src/instrumentation-client.ts`
- `apps/web/src/instrumentation.ts`
- `apps/web/src/app/global-error.tsx`
- `apps/web/src/components/layout/UserAnalyticsContext.tsx`
- `apps/web/src/lib/server/sentry-context.ts`
- `apps/web/next.config.ts`

### DSN, Project, And Metadata

- Runtime event ingestion uses `NEXT_PUBLIC_SENTRY_DSN`.
- Sentry release creation and source-map uploads are configured for `roomote/roomote` in `apps/web/next.config.ts`.
- `apps/web/next.config.ts` now derives one canonical web release from `VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, or `RELEASE_VERSION`, injects it into `NEXT_PUBLIC_SENTRY_RELEASE`, and passes the same release name to the Sentry build plugin so browser, Node.js, and edge events all attribute to the same release.
- Source-map upload is enabled only when both `SENTRY_AUTH_TOKEN` and a non-empty release value are available at build time; otherwise the plugin leaves source maps disabled for upload.
- Environment tags resolve through `APP_ENV`, `ROOMOTE_APP_ENV`, or the production fallback.
- User context is set from authenticated layout/server auth paths.

### Captured Paths

- Browser JavaScript errors and unhandled client exceptions
- Browser session replays, including replay-on-error sampling
- App Router global errors rendered by `global-error.tsx`
- Next.js Node.js and edge runtime request errors
- tRPC procedure errors that are not expected non-internal `TRPCError` responses

## Controller Sentry Reporting

The controller now initializes `@sentry/node` before `dist/index.js` runs so startup failures, top-level process errors, dequeue-loop faults, and worker-spawn failures can be reported from the dispatcher service.

**Implementation:**

- `apps/controller/src/instrument.ts`
- `apps/controller/src/monitoring/sentry.ts`
- `apps/controller/src/index.ts`
- `apps/controller/src/BaseController.ts`
- `apps/controller/scripts/watchman.sh`
- `.docker/app/Dockerfile` (shared app image; the controller service starts
  through the `controller` dispatcher command)

### Startup Path

- Local dev starts the controller with `node --watch --import ./dist/instrument.js ./dist/index.js`.
- The production container starts the controller with `node --import ./dist/instrument.js ./dist/index.js`.
- `instrument.ts` performs the one-time `Sentry.init()` call before the rest of the controller module graph loads.

### DSN And Metadata

- `CONTROLLER_SENTRY_DSN` overrides the controller DSN when set.
- `SENTRY_DSN` is the shared fallback override when a controller-specific DSN is not set.
- If neither env var is present, controller Sentry stays disabled.
- The controller reports `serverName=controller`, tags the scope with `roomote.service=controller`, forwards release metadata from `VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, or `RELEASE_VERSION`, and currently sets `sendDefaultPii: true`.

### Captured Paths

- Process startup failure in `apps/controller/src/index.ts`
- Unhandled promise rejections
- Uncaught exceptions
- Dequeue-loop failures in `BaseController.start()`
- Error-level controller message events when orphan recovery has to start a job through the database fallback path
- Worker artifact-watch failures
- Worker spawn failures routed through `handleSpawnJobError()`

## Worker Sentry Reporting

The worker initializes `@sentry/node` from `apps/worker/src/monitoring/sentry.ts` and reports both process-level worker failures and selected harness error logs.

**Implementation:**

- `apps/worker/src/monitoring/sentry.ts`
- `apps/worker/src/logging/harness-logger.ts`
- `apps/worker/src/run-task/create-harness.ts`
- `apps/worker/src/sandbox-server/lib/harnesses/opencode-server/start.ts`
- `apps/worker/scripts/worker.ts`

### Release And Worker Metadata

- `WORKER_SENTRY_DSN` overrides the worker DSN when set.
- `SENTRY_DSN` is the shared fallback override when a worker-specific DSN is not set.
- If neither env var is present, worker Sentry stays disabled.
- The worker reports `serverName=worker` and tags the initial scope with `roomote.service=worker`.
- Worker events that include a `cloudJobId` in their shared monitoring context also promote that value into the searchable `roomote.cloud_job_id` Sentry tag.
- The controller launch paths also stamp provider-agnostic worker runtime metadata into the worker process environment before execution starts. Worker Sentry merges that runtime metadata into the `worker` context on every event when available:
  - `orgSlug`
  - `environmentId`
  - `computeProvider` using the stable provider id (`modal`, `docker`, `daytona`, or `e2b`)
  - `computeProviderFingerprint`
  - `computeProviderFingerprintKind`
- `computeProviderFingerprint` is intentionally provider-agnostic. Each compute provider supplies its own stable runtime fingerprint while keeping the schema uniform:
  - Modal reports the configured base image reference with fingerprint kind `base-image`
  - Docker reports the worker image, Daytona the snapshot name, and E2B the template ID, all with fingerprint kind `base-image`
- Worker events also promote `computeProvider` into the searchable `roomote.compute_provider` tag.
- Sentry `release` now prefers `WORKER_RELEASE_TAG` when the sandbox launch path provides it.
- If `WORKER_RELEASE_TAG` is unavailable, the worker falls back to the existing generic release env vars: `VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, or `RELEASE_VERSION`.
- As additional attribution, the worker also tags events with:
  - `roomote.worker_release_tag` from `WORKER_RELEASE_TAG` when present
  - `roomote.worker_version` from the installed worker archive's `/sandbox/worker/VERSION` file
  - `roomote.worker_commit` from the installed worker archive's `/sandbox/worker/COMMIT` file

This makes it possible to identify which shipped worker artifact produced a Sentry event even when the generic deploy-level release env vars are unset inside the sandbox.

For job-scoped persistence, the worker also sends the same runtime artifact metadata through `sdk.cloudJobs.dequeue()` / `sdk.cloudJobs.resume()` so `task_runs.workerReleaseTag`, `task_runs.workerVersion`, and `task_runs.workerCommit` record which worker runtime actually executed the job. Sentry remains the cross-event observability surface; the `task_runs` row is now the durable per-job source of truth.

### Captured Paths

- Process startup failures
- Unhandled promise rejections
- Uncaught exceptions
- Explicit worker error messages captured through the worker monitoring helpers
- Roomote runtime envelope persistence failures emitted from `subscribeHarnessCallbacks()` with cloud job, task, session, and envelope metadata
- Warning-level harness restart signals when cancellation never settles and the worker has to restart the direct OpenCode subprocess to recover the active session
- Warning-level `opencode-server` disconnect events with signal `opencode-server-disconnect`, including transport counters, pending RPC state, recent method history, and task/session identifiers

## BullMQ Sentry Reporting

BullMQ initializes `@sentry/node` from `apps/bullmq/src/monitoring/sentry.ts` and reports selected queue-level operational failures.

**Implementation:**

- `apps/bullmq/src/monitoring/sentry.ts`
- `apps/bullmq/src/index.ts`
- `apps/bullmq/src/jobs/snapshot.ts`

### DSN And Metadata

- `BULLMQ_SENTRY_DSN` overrides the BullMQ DSN when set.
- `SENTRY_DSN` is the shared fallback override when a BullMQ-specific DSN is not set.
- If neither env var is present, BullMQ Sentry stays disabled.
- BullMQ reports `serverName=bullmq`, tags the initial scope with `roomote.service=bullmq`, forwards release metadata from `VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, or `RELEASE_VERSION`, and sets `sendDefaultPii: false`.
- BullMQ events promote key queue context into searchable tags when present, including `cloudJobId`, `taskId`, `taskPhase`, `computeProvider`, `queueJobId`, `snapshotIntentId`, `triggerPath`, `sandboxId`, `snapshotStage`, provider response status, provider error code, and provider request id.

### Captured Paths

- Terminal snapshot creation failures from the snapshot queue after provider-specific reconciliation, if any, did not recover a usable snapshot id. These events use signal `snapshot-failed` and include cloud job, task, org, provider, sandbox, queue attempt, snapshot intent, trigger path, snapshot stage, pre-snapshot status, post-failure status, a normalized root-cause summary, and provider response details such as status, error code, error message, and request id when available.

## API Request Observability

The API server now records three additional operational signals:

- **Slow inbound requests** are logged when a request spends at least `API_SLOW_REQUEST_THRESHOLD_MS` in the Hono stack. The default is `5000ms`.
- **Per-endpoint inbound request tallies** are kept in memory since process start and exposed from authenticated `GET /health/api` requests.
- **Slow outbound third-party requests** are logged when a `fetch`-based request leaves the trusted Roomote/internal host set and exceeds the configured threshold.

**Key files:**

- `apps/api/src/middleware/requestObservabilityMiddleware.ts`
- `apps/api/src/monitoring/request-endpoint-metrics.ts`
- `apps/api/src/server.ts`
- `apps/api/src/handlers/proxy-response-stream.ts`
- `packages/types/src/request-observability.ts`
- `packages/github/src/api.ts`
- `packages/slack/src/web-client.ts`

### Slow Endpoint Logging

`requestObservabilityMiddleware` wraps every request handled by `apps/api` and emits a warning log when the total request duration crosses the configured threshold.

Logged fields:

- `method`
- `path`
- `status`
- `durationMs`
- `requestId` when the caller sends `x-request-id`

This is intended to answer "which endpoints are getting slow?" without enabling full verbose request logging for every request.

### Per-Endpoint Request Tallies

The API process also keeps a per-instance, since-start tally of inbound requests grouped by method and endpoint.

- Normal REST routes use Hono's matched route templates so dynamic segments collapse into stable keys like `/api/mcp/tasks/:taskId/messages`.
- `GET /health/api`, `GET /health/liveness`, `GET /health/controller`, and `GET /` are excluded so the monitoring endpoint does not measure itself or count platform health probes.
- `/trpc/*` keeps its raw pathname so procedure names remain distinct.
- The tracked table is capped at `256` unique endpoints. If the process sees additional unseen endpoints after that, they do not evict existing rows; instead they increment `overflowedUniqueEndpointCount` and `overflowedRequestCount`.

This snapshot is process-local and resets on deploy or restart. It is intended for debugging live instances, not for long-term historical reporting.

### Public vs. authenticated health payloads

Self-host Caddy exposes API health paths under
`ROOMOTE_APP_DOMAIN/_roomote-api` and strips that prefix before proxying to
Hono, so the health routes intentionally split their response shape:

- unauthenticated requests to `GET /_roomote-api/`,
  `GET /_roomote-api/health/api`, `GET /_roomote-api/health/liveness`, and
  `GET /_roomote-api/health/controller` return only `server`, `ok`, and
  `timestamp`
- authenticated bearer-token requests to those same routes retain the detailed
  diagnostics such as environment metadata, API request tallies, proxy stream
  snapshots, and controller error strings

This keeps machine-readable readiness and liveness checks public without
publishing deployment internals or job-state details.

### Observed External Request Logging

The API process installs a global observed `fetch` wrapper at startup. For external HTTP(S) targets, it:

- logs slow external requests with the provider host and redacted path
- leaves request semantics alone: it does not inject timeouts, modify signals, or wrap errors

Streaming proxy routes add one more layer of attribution on top of that: when an upstream response body fails after headers were already returned, the route-level stream wrapper logs a single-line error with the proxy name, method, path, status, auth scope, and any nested Undici error code. This is the signal to look for when upstream SSE or chunked responses die mid-stream.

Internal Roomote URLs are excluded from the external-request logging path by hostname and preview-domain allowlist matching so internal service-to-service calls stay out of the third-party signal.

GitHub still participates automatically because Octokit uses the API process's runtime `fetch`.

Explicit outbound timeouts now live only at the call sites that intentionally want them. For example:

- **Slack WebClient** has its own per-request timeout because it does not use the global `fetch` path.
- **Sandbox follow-up messages** keep their route-local `30_000ms` timeout.
- **MCP session termination (`DELETE`)** keeps a proxy-local timeout while streamable `GET`/`POST` traffic stays unbounded except for caller disconnects.
- **MCP stream proxies** disable Undici's default response-body timeout so long silent SSE/chunked responses are not terminated after five minutes of inactivity.

### Environment Variables

These settings are defined in `packages/env/src/index.ts` and default safely when unset:

- `API_SLOW_REQUEST_THRESHOLD_MS` — inbound request warning threshold, default `5000`
- `API_SLOW_EXTERNAL_REQUEST_THRESHOLD_MS` — outbound warning threshold, default `2000`
- `SLACK_API_TIMEOUT_MS` — explicit timeout used by the Slack WebClient wrapper, default `10000`
- `API_EXTERNAL_REQUEST_TIMEOUT_MS` — legacy compatibility fallback for `SLACK_API_TIMEOUT_MS`; the global observed `fetch` wrapper no longer applies this timeout automatically

For production, set these explicitly in the API environment so threshold changes are deliberate and auditable.

## API Sentry Error Capture

The API server now initializes `@sentry/node` from [`apps/api/src/instrument.ts`](../../apps/api/src/instrument.ts) before the rest of the process boots.

- Startup failures from [`apps/api/src/index.ts`](../../apps/api/src/index.ts) are captured before the process exits, including failures that happen while the API server module is loading.
- Uncaught Hono errors flow through the global `app.onError()` hook in [`apps/api/src/server.ts`](../../apps/api/src/server.ts).
- Expected `HTTPException` responses are preserved without being reported to Sentry. `HTTPException`s with 5xx status codes are still reported so unexpected server-side failure paths stay visible.
- Captured request errors include method, path, URL, optional `x-request-id`, and token-derived tags for org, user, token type, and cloud job where available.

### Configuration

- `API_SENTRY_DSN` overrides the API DSN explicitly.
- `SENTRY_DSN` remains a shared fallback if a deployment prefers one generic server-side Sentry variable.
- If neither env var is present, API Sentry stays disabled.
- Environment and release tags are derived from `ROOMOTE_APP_ENV` / `APP_ENV` / `NODE_ENV` and `VERCEL_GIT_COMMIT_SHA` / `GITHUB_SHA` / `RELEASE_VERSION`.

### Key Files

- [`apps/api/src/instrument.ts`](../../apps/api/src/instrument.ts)
- [`apps/api/src/bootstrap.ts`](../../apps/api/src/bootstrap.ts)
- [`apps/api/src/monitoring/sentry.ts`](../../apps/api/src/monitoring/sentry.ts)
- [`apps/api/src/index.ts`](../../apps/api/src/index.ts)
- [`apps/api/src/server.ts`](../../apps/api/src/server.ts)

## API Health Endpoints

### GET /health/liveness

Process-local liveness check. It always returns 200 while the process can serve requests and intentionally does **not** touch PostgreSQL or Redis.

**Implementation:** `apps/api/src/handlers/health/liveness.ts`

**Why it must stay dependency-free:** liveness checks are for process supervision. If they depend on the shared database or Redis, a dependency slowdown can make every API process look dead at once. Deep dependency checks belong to readiness-style health endpoints and human-facing diagnostics.

**Response shape:** unauthenticated callers receive only `server`, `ok`, and
`timestamp`. Authenticated bearer-token callers additionally receive the
environment metadata used for deeper operator diagnostics.

### GET /health/api

Basic health check for the API server. Validates connectivity to PostgreSQL and Redis. Monitored externally by Better Stack (the "Roomote / API" monitor checks `/`, which serves the same handler).

**Implementation:** `apps/api/src/handlers/health/api.ts`

**Unauthenticated public response:**

```json
{
  "server": "api",
  "ok": true,
  "timestamp": "2026-03-13T10:00:00.000Z"
}
```

**Authenticated response:**

```json
{
  "server": "api",
  "environment": {
    "NODE_ENV": "production",
    "APP_ENV": "production"
  },
  "monitoring": {
    "longLivedProxyStreams": {
      "activeCount": 2,
      "oldestAgeMs": 330000,
      "countsByAge": {
        "atLeast1m": 1,
        "atLeast5m": 1,
        "atLeast15m": 0
      },
      "byRoute": {
        "mcp:GitHub": 2
      },
      "warningActive": false,
      "warningThresholds": {
        "activeCount": 20,
        "oldestAgeMs": 600000
      }
    },
    "requestEndpointMetrics": {
      "sinceStartedAt": "2026-03-13T09:55:00.000Z",
      "totalRequests": 42,
      "trackedEndpointCount": 3,
      "overflowedUniqueEndpointCount": 0,
      "overflowedRequestCount": 0,
      "endpoints": [
        {
          "method": "GET",
          "route": "/api/mcp/tasks/:taskId/messages",
          "count": 18,
          "statusCounts": {
            "2xx": 17,
            "3xx": 0,
            "4xx": 0,
            "5xx": 1,
            "other": 0
          },
          "avgDurationMs": 54,
          "maxDurationMs": 181,
          "lastDurationMs": 47,
          "lastSeenAt": "2026-03-13T10:00:00.000Z"
        },
        {
          "method": "GET",
          "route": "/trpc/tasks.list",
          "count": 14,
          "statusCounts": {
            "2xx": 14,
            "3xx": 0,
            "4xx": 0,
            "5xx": 0,
            "other": 0
          },
          "avgDurationMs": 23,
          "maxDurationMs": 91,
          "lastDurationMs": 19,
          "lastSeenAt": "2026-03-13T09:59:58.000Z"
        }
      ]
    }
  },
  "ok": true,
  "error": undefined,
  "timestamp": "2026-03-13T10:00:00.000Z"
}
```

**Status codes:**

- `200` — All checks passed
- `503` — Database or Redis connectivity failure

**Checks performed:**

- PostgreSQL: `SELECT 1`
- Redis: `PING`
- Long-lived proxy stream snapshot:
  - `activeCount` is the number of currently streaming MCP proxy responses on this instance
  - `oldestAgeMs` and `countsByAge` show whether stream lifetimes are clustering in the 1m/5m/15m buckets (cumulative — a 6m stream counts in both `atLeast1m` and `atLeast5m`)
  - `byRoute` shows which proxy surface is holding the streams
  - `warningActive` mirrors the in-process warning threshold check and does not change the endpoint's HTTP status by itself
- Request endpoint metrics snapshot:
  - `sinceStartedAt` marks when this process started tracking requests
  - `endpoints` is sorted by request count, then average duration
  - dynamic REST routes are normalized to matched route templates, while `/trpc/*` keeps raw pathnames
  - `/`, `/health/api`, `/health/liveness`, and `/health/controller` are excluded from the tally
  - overflow counters indicate that more unique endpoints were seen than the in-memory table can retain

### GET /health/controller

Comprehensive health check for the controller subsystem. Validates controller liveness and detects stuck jobs.

**Implementation:** `apps/api/src/handlers/health/controller.ts`

**Unauthenticated public response:**

```json
{
  "server": "controller",
  "ok": false,
  "timestamp": "2026-03-13T10:00:00.000Z"
}
```

**Authenticated response:**

```json
{
  "server": "controller",
  "environment": {
    "NODE_ENV": "production",
    "APP_ENV": "production"
  },
  "ok": false,
  "error": "Controller stale: last heartbeat 450.0s ago (threshold: 300s); Jobs stuck in queue (not dequeued within 60 min): [12345]",
  "timestamp": "2026-03-13T10:00:00.000Z"
}
```

**Status codes:**

- `200` — All checks passed
- `503` — One or more checks failed

**Checks performed:**

1. **Controller heartbeat check**
   - Reads `controller:heartbeat` Redis key
   - Fails if key is missing or older than 300 seconds
   - Threshold: `CONTROLLER_STALE_THRESHOLD_SECONDS = 300`

2. **Stuck in queue check**
   - Detects jobs that remain in `Pending` status (never dequeued)
   - Query conditions:
     - `status = Pending` (via `dequeuedAt IS NULL`)
     - `canceledAt IS NULL` and `completedAt IS NULL`
     - `createdAt < NOW() - 60 minutes`
   - Threshold: `STUCK_IN_QUEUE_THRESHOLD_MINUTES = 60`

3. **Stuck after dequeue check**
   - Detects jobs dequeued but never started
   - Query conditions:
     - `dequeuedAt IS NOT NULL`
     - `startedAt IS NULL`
     - `canceledAt IS NULL` and `completedAt IS NULL`
     - `dequeuedAt < NOW() - STUCK_AFTER_DEQUEUE_THRESHOLD_MINUTES minutes`
   - Threshold: `STUCK_AFTER_DEQUEUE_THRESHOLD_MINUTES` (derived from the bounded sandbox launch budget; currently 10)

## Controller Heartbeat

The controller publishes a heartbeat to Redis on every dequeue loop iteration to signal that it is alive and processing jobs.

**Implementation:** `apps/controller/src/BaseController.ts:84-89`

**Redis key:** `controller:heartbeat` (exported via `REDIS_KEYS.CONTROLLER_HEARTBEAT`)

**Value:** Unix timestamp in milliseconds (e.g., `1710327600000`)

**TTL:** 600 seconds (`HEARTBEAT_TTL_SECONDS = 600`)

**Update frequency:** Every dequeue loop iteration (~1 second when idle, immediate when jobs are available)

**Monitoring pattern:**

```typescript
const lastHeartbeat = await getRedis().get(REDIS_KEYS.CONTROLLER_HEARTBEAT);
const elapsedSeconds = (Date.now() - parseInt(lastHeartbeat, 10)) / 1000;

if (elapsedSeconds > 300) {
  // Controller is stale — may be down or stuck
}
```

## Orphan Detection and Recovery

The controller runs orphan detection every 30 seconds to identify and recover jobs that were enqueued but never processed.

**Implementation:** `apps/controller/src/orphaned-cloud-jobs.ts`

### Detection Criteria

**Orphaned before dequeue:**

Jobs stuck in `Pending` status for an extended period.

- Status: `CloudTaskStatus.Pending`
- `createdAt` between 5 minutes ago and 24 hours ago
- Query: `getOrphanedBeforeDequeueJobs()`

**Orphaned after dequeue:**

Jobs that were dequeued but never started executing.

- Status: `CloudTaskStatus.Dequeued`
- `dequeuedAt` older than the bounded sandbox launch envelope plus one orphan-scan interval (currently just over 9 minutes)
- Query: `getOrphanedAfterDequeueJobs()`

### Recovery Process

When an orphaned job is detected:

1. **Logging:** Job details are logged including `id`, `type`, `repo`, and age in minutes
2. **Deduplication:** In-memory `orphanMap` prevents the same job from being recovered multiple times within one dequeue-orphan threshold window (derived from the bounded sandbox launch budget)
3. **Lock release:** `releaseCloudTask()` removes the Redis scope lock stored under the job scope itself
4. **State reset:** `dequeuedAt` is cleared in the database
5. **Controller retry:** The recovered job is returned to the controller loop and spawned directly

**Key implementation details:**

```typescript
// Release the lock and clear dequeuedAt before returning.
await releaseCloudTask(cloudJob);

await db
  .update(taskRuns)
  .set({ dequeuedAt: null })
  .where(eq(taskRuns.id, cloudJob.id));
```

The orphan map prevents thrashing by tracking recovery attempts:

```typescript
const orphanMap = new Map<number, number>();

// Clean up stale entries once the bounded spawn window has expired
for (const [jobId, timestamp] of orphanMap.entries()) {
  if (now - timestamp > ORPHAN_RETRY_DEDUPE_WINDOW_MS) {
    orphanMap.delete(jobId);
  }
}

// Only recover jobs not recently attempted
const cloudJob = orphanedJobs.find((job) => !orphanMap.has(job.id));
```

Fresh sandbox launches now also emit controller-correlated phase logs and bounded retries before orphan recovery becomes relevant. Operators should expect logs for sandbox create or resume, worker file upload, worker install, detached worker launch, cleanup, and periodic 30-second warnings while a spawn promise is still pending.

## BullMQ Dashboard

The BullMQ dashboard provides visibility into scheduled jobs and queue state.

**URL:** `http://localhost:3002/admin/queues` (development)

**Port:** 3002

**Implementation:** `apps/bullmq/src/index.ts`

**Authentication:** HTTP basic auth (username: `admin`, password: `DASHBOARD_PASSWORD` env var), gated on whether `DASHBOARD_PASSWORD` is configured — **not** on `NODE_ENV`. The self-host stack runs this service with `NODE_ENV=development`, so a `NODE_ENV`-based skip would leave Bull Board (write access to every queue) unauthenticated there. When `DASHBOARD_PASSWORD` is unset, `/admin/*` fails closed with `503` and the dashboard is disabled while the queue workers keep running (`resolveAdminDashboardAuth` in `apps/bullmq/src/admin-auth.ts`). The dashboard port is published to `127.0.0.1` only in the dev and self-host compose stacks. The operational `/admin/health` endpoint is exempt from dashboard auth so the `pnpm dev` doctor health probe and external monitoring can poll it without credentials; Bull Board (`/admin/queues`) and `/admin/stats` remain protected.

**Queues monitored:**

- `scheduler` — Periodic system jobs (heartbeat, runtime sleep checks, snapshot refresh)
- `snapshot` — Environment snapshot creation jobs
- `slackPrInactivity` — PR inactivity notifications

**Health endpoint:** `GET /admin/health`

```json
{
  "status": "ok",
  "timestamp": "2026-03-13T10:00:00.000Z",
  "services": {
    "redis": "ready",
    "queues": {
      "scheduler": {
        "waiting": 0,
        "active": 1,
        "completed": 1234,
        "failed": 2,
        "delayed": 0,
        "repeat": 2
      }
    }
  }
}
```

**Stats endpoint:** `GET /admin/stats`

Returns detailed queue statistics and repeatable job schedules.

### Scheduled Health Jobs

**Heartbeat job:**

- File: `apps/bullmq/src/scheduled-jobs/heartbeat.ts`
- Purpose: BullMQ scheduler liveness signal (separate from controller heartbeat)
- Redis keys:
  - `scheduler:last-update` — Latest timestamp (24h TTL)
  - `scheduler:update-history` — Last 10 timestamps (FIFO list)

**Snapshot refresh job:**

- File: `apps/bullmq/src/scheduled-jobs/refresh-snapshots.ts`
- Purpose: Queue daily refreshes for ready environment snapshots without clearing the current snapshot first
- Triggers: Snapshot recreation for environment snapshots that have gone at least a day since their last successful creation
- Log detail: BullMQ logs now include the run start time and cutoff, candidate discovery counts, per-candidate `environmentId`/provider/source/snapshot age metadata before enqueue, explicit skip logs when a refresh is already in flight for that environment/provider, the resulting refresh `cloudJobId` on success, and the same candidate context plus stack traces on failures. Those logs are the primary first stop when scheduled refreshes misfire.

**Runtime sleep-action job:**

- File: `apps/bullmq/src/scheduled-jobs/sleep-check.ts`
- Purpose: Claim due sandbox sleep actions once the persisted `task_runs.sleepAt` deadline is due, then snapshot resumable jobs or shut down non-resumable ones. The same job also treats stale `task_runs.workerHeartbeatAt` timestamps as a worker-health failure signal: if the sandbox is still running it snapshots resumable jobs or fails non-resumable ones, and if the sandbox is already gone it fails the job directly.
- Cloud job events: `sleep_check` now records candidate-evaluation start plus the observed provider status and timeout before it enqueues a snapshot, completes an idle job without a snapshot, or fails the job. That makes it possible to distinguish "snapshot was never claimed" from "snapshot was requested and later failed" using `cloud_job_events` alone.
- Worker runtime events: `worker_runtime` records persisted runtime-state snapshots, harness connect/disconnect transitions, harness task-state events, shutdown signals, runtime task registration, and worker heartbeat loop failures. This is the primary source for understanding what the worker believed the task phase and sleep deadline were before BullMQ stale-worker recovery ran.
- Terminal lifecycle preservation: `job_lifecycle` finish events now retain the previous `taskPhase`, `sleepAt`, `sleepRequestedAt`, `snapshotRequestedAt`, `snapshotCreatedAt`, `workerHeartbeatAt`, `runtimeTaskId`, and the persisted worker release tag/version/commit even though the terminal `task_runs` row may clear some of those live runtime fields.
- Cadence: Every 60 seconds

## Debugging Patterns

### Queue Locks

Jobs use Redis locks to prevent concurrent execution of the same scope (e.g., PR review jobs).

**Lock key pattern:** the raw job scope string (for example `<repo>:<prNumber>` for PR jobs)

**Lock TTL:** 3600 seconds (1 hour, matches `TASK_TIMEOUT_MS`)

**Implementation:** `packages/cloud-agents/src/server/cloud-job-queue.ts`

**Debugging:**

```bash
# Check if a job is locked
redis-cli GET "owner/repo:123"

# Check lock TTL
redis-cli TTL "owner/repo:123"

# Manually release a stuck lock
redis-cli DEL "owner/repo:123"
```

**Lock acquisition:**

```typescript
const result = await redis.set(
  entry.scope,
  entry.id,
  'EX',
  Math.ceil(TASK_TIMEOUT_MS / 1000), // 3600 seconds
  'NX',
);
```

### Stuck States

**Symptom:** Job remains in queue but never executes

**Common causes:**

1. **Lock contention:** Another job holds the scope lock
2. **Orphan detection window:** Job age is between 5 minutes (orphan threshold) and detection interval
3. **Controller down:** Heartbeat stale, no dequeue loop running
4. **Redis connectivity:** Queue operations failing silently

**Diagnosis:**

```sql
-- Find jobs stuck in Pending
SELECT id, type, payload->>'repo', created_at, dequeued_at
FROM task_runs
WHERE dequeued_at IS NULL
  AND canceled_at IS NULL
  AND completed_at IS NULL
  AND created_at < NOW() - INTERVAL '10 minutes'
ORDER BY created_at DESC;

-- Find jobs stuck after dequeue
SELECT id, type, payload->>'repo', dequeued_at, started_at
FROM task_runs
WHERE dequeued_at IS NOT NULL
  AND started_at IS NULL
  AND canceled_at IS NULL
  AND completed_at IS NULL
  AND dequeued_at < NOW() - INTERVAL '10 minutes'
ORDER BY dequeued_at DESC;
```

**Resolution:**

1. Verify controller heartbeat: `redis-cli GET controller:heartbeat`
2. Check scope lock: `redis-cli GET "<scope>"`
3. Wait for orphan detection (runs every 30s, after the bounded launch window elapses) or manually trigger recovery:

```typescript
import { releaseCloudTask } from '@roomote/cloud-agents/server';
import { db, taskRuns, eq } from '@roomote/db/server';

const job = await db.query.taskRuns.findFirst({
  where: eq(taskRuns.id, jobId),
});

await releaseCloudTask(job);
await db
  .update(taskRuns)
  .set({ dequeuedAt: null })
  .where(eq(taskRuns.id, jobId));
```

### Snapshot Confusion

**Symptom:** SnapshotResume job fails to restore expected state

**Debugging:**

```sql
-- Trace snapshot lineage
SELECT
  id,
  type,
  task_id,
  source_snapshot_id,
  payload->>'sourceCloudJobId' AS source_job,
  created_at
FROM task_runs
WHERE task_id = '<task-id>'
ORDER BY created_at;
```

**Check environment snapshot status:**

```sql
SELECT provider, snapshot_id, snapshot_status, deleted_at, updated_at
FROM environment_snapshots
WHERE environment_id = '<environment-id>';
```

(The legacy snapshot columns on `environments` are no longer read or written;
`environment_snapshots` rows are the only source.)

**Common issues:**

- `snapshotStatus = 'failed'`: Initial snapshot creation failed (check the cloud job error and `cloud_job_events`)
- `sourceSnapshotId` mismatch: Worker restored from wrong snapshot
- Missing snapshot: provider snapshot expired or was deleted

## Key Files Reference

- `apps/api/src/handlers/health/api.ts` — API health endpoint
- `apps/api/src/handlers/health/controller.ts` — Controller health checks
- `apps/controller/src/BaseController.ts` — Controller heartbeat (lines 84-89), shutdown logic
- `apps/controller/src/orphaned-cloud-jobs.ts` — Orphan detection and recovery
- `apps/bullmq/src/index.ts` — BullMQ dashboard server (port 3002)
- `apps/bullmq/src/scheduled-jobs/heartbeat.ts` — BullMQ scheduler heartbeat
- `apps/bullmq/src/scheduled-jobs/refresh-snapshots.ts` — Snapshot refresh trigger
- `packages/cloud-agents/src/server/cloud-job-queue.ts` — Queue lock management
- `packages/redis/src/index.ts` — Redis key definitions (`REDIS_KEYS`)
