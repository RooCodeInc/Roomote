---
title: Anonymous Analytics & Version Checks
status: active
last_reviewed: 2026-07-08
owner: engineering
summary: How the opt-out anonymous analytics pipeline and mandatory daily version check work, from the deployment's anonymous IDs and gating rules to the hosted Ping service and PostHog forwarding.
---

# Anonymous Analytics & Version Checks

Roomote deployments can send anonymous product telemetry to the hosted
**Ping** service (`ping.roomote.dev`, separate private repo), which forwards
events to PostHog and maintains an anonymous instance registry. Version
checks flow through the same service but are independent of the analytics
opt-out.

## Identifiers

Two anonymous identifiers, both 12-character nanoids generated lazily in
code (never in SQL) and never exposed through any user-facing mutation:

- **Instance ID** — `deployment_settings.instance_analytics_id`, created by
  `getInstanceAnalyticsId()` (`packages/db/src/lib/telemetry-ids.ts`).
  Stable across versions; a database wipe mints a new one.
- **User analytics ID** — `users.analytics_id`, created by
  `getUserAnalyticsId()` on first use.

Neither is derived from customer data. PostHog user-level events use the
user analytics ID as `distinct_id`; the Ping service attaches the instance
ID as a PostHog group so user activity can be sliced per instance.

## Gating

Two layers, both enforced server-side:

1. **Environment gate** — `isTelemetryEnvAllowed()`
   (`packages/telemetry/src/server/index.ts`): telemetry only leaves
   deployments with a baked `RELEASE_VERSION` and `APP_ENV` other than
   `development`. `ROOMOTE_FORCE_TELEMETRY=1` overrides for testing.
   Nothing (analytics **or** version checks) is sent when this gate fails.
2. **Admin setting** — the `anonymous_analytics_enabled` key in
   `deployment_settings.metadata` (opt-out: absent means enabled),
   evaluated by `isAnonymousAnalyticsEnabledFromMetadata()`
   (`packages/feature-flags/src/index.ts`). Set from the StepInvoke setup
   step and **Settings > Misc** (`miscSettings` tRPC router, admin-gated).
   Version checks ignore this setting.

## Capture paths

- **Server events** — `captureEvent()` in `@roomote/telemetry/server`:
  fire-and-forget in-memory batching to `POST {ROOMOTE_PING_BASE_URL}/v1/events`,
  5s timeout, dropped on failure, never throws. Seed events:
  `task_created` (`enqueueCloudTask`), `task_completed` (`finishCloudJob`),
  `user_invited` (`createInviteCommand`), `setup_completed`
  (`completeSetupCommand`).
- **Browser page views + events** — `TelemetryProvider`
  (`apps/web/src/components/layout/TelemetryProvider.tsx`) dynamic-imports
  the tracker (`apps/web/src/lib/telemetry/tracker.ts`) only when
  `AuthorizedUser.anonymousAnalyticsEnabled` is true, so disabled
  deployments never load tracking code. Paths are reduced to route patterns
  by `normalizePath()` (query strings dropped except `/setup*`). Events
  relay through `POST /api/telemetry`, which re-enforces the setting and
  resolves the user's anonymous ID server-side; the browser never talks to
  Ping directly. `useTelemetry()` exposes arbitrary client capture.
- **Daily instance report + version check** — the `InstancePing` BullMQ job
  (`apps/bullmq/src/scheduled-jobs/instance-ping.ts`, every 24h): always
  runs the version check (stores `latest_known_version` /
  `latest_version_checked_at` on `deployment_settings`; no UI reads these
  yet), then sends the aggregate stats blob from
  `collectInstanceReportStats()` (`packages/db/src/lib/instance-report.ts`)
  when analytics is enabled. The blob carries `reportSchemaVersion` and only
  aggregate counts and provider/product names (MCPs are listed by ID).
  Report delivery failure throws so the scheduled-jobs queue's built-in
  retry (3 attempts, exponential backoff) re-attempts the daily heartbeat;
  event and version-check failures stay warn-and-drop.

## Local dev verification

Anonymous analytics local testing is an internal developer workflow. Keep
these instructions in `.agent-guidance/`; do not copy local Ping setup into
`apps/docs/`, which is public user-facing documentation.

When testing Roomote against a locally running Ping service, set these
Roomote env vars in `.env.local`:

| Variable | Value for local Ping testing | Notes |
| --- | --- | --- |
| `ROOMOTE_PING_BASE_URL` | `http://localhost:3000` | Points Roomote's telemetry client at the local Ping service instead of `https://ping.roomote.dev`. |
| `ROOMOTE_FORCE_TELEMETRY` | `1` | Overrides the local development environment gate so events, version checks, and instance reports can leave the process. |
| `RELEASE_VERSION` | any non-empty dev value, for example `dev-ping-local` | Required even when force-enabled: Roomote includes it as `appVersion`, and the Ping service rejects payloads without `appVersion`. |

The admin setting must also be enabled for analytics events and the daily
instance report. The setting is opt-out, so a missing
`deployment_settings.metadata.anonymous_analytics_enabled` key counts as
enabled; an explicit `false` blocks analytics but not the version check.

The local Ping service itself also needs its own private-repo env configured:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Ping's Postgres database, usually the local `roomote_ping_development` database from the Ping repo compose file. |
| `POSTHOG_API_KEY` | Required by Ping startup; use a real key for forwarding tests or the Ping repo's local dummy value when only validating request handling. |
| `POSTHOG_HOST` | Optional PostHog host override; the Ping repo's dev script can point this at an unreachable local URL to prove best-effort dropping. |
| `GITHUB_RELEASES_REPO` | Repository used by `/v1/version-check` to resolve the latest release. A bad repo or missing access returns a Ping-side error even when analytics payloads work. |
| `GITHUB_TOKEN` | Optional, but needed when the releases repository is private or rate-limited. |

Useful probes once both processes are running:

```bash
curl -i http://localhost:3000/health

curl -i -X POST http://localhost:3000/v1/events \
  -H 'content-type: application/json' \
  --data '{"instanceId":"dev-instance","appVersion":"dev-ping-local","sentAt":"2026-07-08T00:00:00.000Z","events":[{"event":"task_created","distinctId":"dev-user","timestamp":"2026-07-08T00:00:00.000Z"}]}'

pnpm exec dotenvx run -f .env.local -- tsx -e "import { captureInstanceEvent, flushTelemetry, checkLatestVersion, sendInstanceReport } from '@roomote/telemetry/server'; (async () => { console.log(await checkLatestVersion()); await captureInstanceEvent('task_created', { source: 'local_dev_probe' }); await flushTelemetry(); console.log(await sendInstanceReport({ reportSchemaVersion: 1, source: 'local_dev_probe' })); })();"
```

Expected behavior: Ping health returns `200`, `/v1/events` returns `202`,
`checkLatestVersion()` returns the Ping response or `null` after logging a
dropped version-check failure, and `sendInstanceReport()` returns `true` only
when the Ping service accepts the report. Telemetry client failures should log
warnings and remain non-fatal to Roomote product paths.

## Rules for adding telemetry

- Never send PII, repository names, task contents, raw URLs, or free text.
- Event names must match `TELEMETRY_EVENT_NAME_PATTERN` (snake case or
  PostHog `$` events).
- All capture must flow through `@roomote/telemetry` so gating stays
  centralized; telemetry failures must never affect product behavior.
- `apps/worker` must not import `@roomote/telemetry/server` (worker import
  boundaries); worker-side needs go through the API.
- The public docs page (`apps/docs/anonymous-analytics.mdx`) must stay in
  sync with what is actually collected.
