---
title: Redis & BullMQ Infrastructure
status: active
last_reviewed: 2026-07-10
owner: engineering
summary: Technical documentation of Redis usage covering cloud-job queues, BullMQ job processors, caching patterns, scheduled jobs, and sandbox OIDC refresh.
---

# Redis & BullMQ Infrastructure

Roomote uses Redis for cloud-job queueing, scheduled/background jobs, caching, distributed locking, and integration state.

## Overview

Redis serves four primary roles in Roomote:

1. **Cloud Job Queue** — CloudJobQueue uses Redis lists with BLPOP for controller-owned cloud-job dispatch.
2. **BullMQ Queues** — Scheduled producers and maintenance jobs (heartbeat, snapshot refresh, conflict scan) plus delayed Slack follow-up jobs (account-link education DMs, PR inactivity checks)
3. **Caching** — Feature flag metadata, auth session data, routing state
4. **Distributed Locking** — Scope-based concurrency control for PR review jobs, repo-level conflict resolution locks

## Redis Connection Factory

### `@roomote/redis`

The `@roomote/redis` package exports a singleton Redis client factory:

**File:** `packages/redis/src/index.ts`

```typescript
import { Redis } from 'ioredis';
import { Env } from '@roomote/env';

let redis: Redis | null = null;

export const getRedis = () => {
  if (!redis) {
    redis = new Redis(Env.REDIS_URL, {
      maxRetriesPerRequest: null, // Required by BullMQ
      connectTimeout: 5000,
    });
  }
  return redis;
};
```

**Configuration:**

- `maxRetriesPerRequest: null` — BullMQ requirement; allows indefinite retries for blocking operations
- `connectTimeout: 5000` — Fail fast on initial connection

### BullMQ-specific Connection

BullMQ apps (`apps/bullmq`) use a separate connection factory with enhanced retry logic and TLS support:

**File:** `apps/bullmq/src/redis.ts`

```typescript
const options: RedisOptions = {
  host: url.hostname,
  port: parseInt(url.port || '6379'),
  maxRetriesPerRequest: null, // Required by BullMQ
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 5_000);
    return delay;
  },
  lazyConnect: false,
};

if (url.protocol === 'rediss:') {
  options.tls = {};
}
```

**Features:**

- Exponential backoff with max 5s delay
- TLS support via `rediss://` protocol
- Event logging (connect, ready, close, error, reconnecting)
- Graceful shutdown with `quit()` fallback to `disconnect()`

## CloudJobQueue

The CloudJobQueue manages `cloud_jobs` launches with scope-based deduplication and BLPOP-based blocking dequeue. Normal producers go through `enqueueCloudTask()`, which creates the `cloud_jobs`/`tasks` rows and pushes `{ id, scope }` to Redis for the controller.

**File:** `packages/cloud-agents/src/server/cloud-job-queue.ts`

### Architecture

- **Queue Key:** `queue:cloud-jobs`
- **Dequeue:** `BLPOP` with configurable timeout (default 10s)
- **Scope Locks:** Per-job scope (e.g., `owner/repo:123` for PR review jobs) prevents concurrent execution of the same PR review

### Key Methods

#### `enqueue(entry: CloudJobQueueEntry)`

1. **Deduplication:** Scans existing queue entries with the same scope
2. **Eviction:** Removes superseded jobs (matching scope) via `LREM`
3. **Database Cancellation:** Marks evicted jobs as `Canceled` in DB (best-effort, non-blocking)
4. **Insertion:** `RPUSH` the new entry to the tail of the list

```typescript
export interface CloudJobQueueEntry {
  id: number; // cloudJobs.id
  scope: string; // Unique key for deduplication (e.g., "owner/repo:prNumber")
}
```

**Scope Generation:**

- **PR Review Jobs:** `${payload.repo}:${payload.prNumber}` — prevents multiple concurrent reviews for the same PR
- **Other Jobs:** `crypto.randomUUID()` — unique scope, no deduplication

#### `dequeue(blocking = true): CloudJobQueueEntry | null`

1. **BLPOP:** `BLPOP queue:cloud-jobs {timeout}` — blocks until an entry is available or timeout expires
2. **Validation:** Parses JSON, skips invalid entries
3. **Duplicate Detection:** Tracks seen IDs within a single dequeue call; if an ID is seen twice, re-enqueues and returns `null`
4. **Lock Acquisition:** Attempts `acquireLock(entry)` with scope as key
5. **Re-enqueue on Lock Failure:** If lock fails (another worker holds it), re-enqueues the job and continues loop

**Lock Implementation:**

```typescript
private async acquireLock(entry: CloudJobQueueEntry): Promise<boolean> {
  const result = await this.redis.set(
    entry.scope,           // Key: job scope (e.g., "owner/repo:42")
    entry.id,              // Value: cloudJobId
    'EX',
    Math.ceil(TASK_TIMEOUT_MS / 1000), // TTL: 1 hour
    'NX',                  // Only set if key does not exist
  );
  return result === 'OK';
}
```

**TTL:** Lock expires after 1 hour (`TASK_TIMEOUT_MS`), ensuring stale locks don't block jobs indefinitely.

#### `releaseLock(scope: string)`

Deletes the scope lock key. Called by `releaseCloudTask()` when a job completes or fails.

### Usage in Controller

**File:** `apps/controller/src/BaseController.ts`

The controller dequeues Redis cloud-job entries and falls back to orphaned-job recovery when Redis is empty:

```typescript
while (this.isRunning) {
  // Update heartbeat
  await getRedis().set(
    REDIS_KEYS.CONTROLLER_HEARTBEAT,
    Date.now().toString(),
    'EX',
    600, // 10 minutes
  );

  const id = await dequeueCloudTask();

  if (id) {
    const cloudJob = await db.query.cloudJobs.findFirst({
      where: eq(cloudJobs.id, id),
    });
    if (cloudJob) {
      this.spawnWorkerInBackground(cloudJob);
    }
  } else {
    // No job available; check for orphaned jobs every 60s
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
```

**Heartbeat Key:** `controller:heartbeat` (TTL: 10 minutes) — monitoring tool to detect controller liveness.

The old scheduled BullMQ `QueueConsumer` bridge has been removed. BullMQ remains the right place for scheduled producers and maintenance jobs, and those producers should call `enqueueCloudTask()` when they need to launch Roomote work.

## BullMQ Queues

BullMQ handles scheduled, recurring, and ad-hoc jobs that require retry logic and job persistence.

**Dashboard:** `http://localhost:13002/admin/queues` (basic auth in non-dev environments)

### Queue Definitions

| Queue Name                          | Purpose                                                                                                                          | Schedule  | File                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------- |
| `scheduled-jobs`                    | Cron-style scheduled jobs (heartbeat, sleep check, snapshot refresh, etc.)                                                       | Various   | `apps/bullmq/src/scheduler.ts`                          |
| `sandbox-oidc-refresh-jobs`         | Sandbox OIDC token rotation for active environment-backed task machines                                                          | Every 60s | `apps/bullmq/src/sandbox-oidc-refresh-queue.ts`         |
| `snapshot-jobs`                     | Sandbox snapshot creation                                                                                                        | On-demand | `apps/bullmq/src/snapshot-queue.ts`                     |
| `slack-account-link-education-jobs` | Send the one-hour post-link Slack education DM                                                                                   | On-demand | `apps/bullmq/src/slack-account-link-education-queue.ts` |
| `slack-pr-inactivity-check-jobs`    | Check PRs for inactivity and notify via Slack                                                                                    | On-demand | `apps/bullmq/src/slack-pr-inactivity-queue.ts`          |
| `pr-review-notification-jobs`       | Notify the owning task's originating conversation (Slack, Teams, or Telegram) about new PR review feedback once the task is idle | On-demand | `apps/bullmq/src/pr-review-notification-queue.ts`       |

The Slack account-link education queue is fed by successful Slack mapping writes in the web app. Jobs use deterministic BullMQ `jobId` values plus a short Redis claim key to suppress duplicate scheduling across retries, then re-check the active installation and current `slack_user_mappings` row before opening a DM and posting the education message.

### Scheduled Jobs Queue

**File:** `apps/bullmq/src/scheduler.ts`

Uses BullMQ's `upsertJobScheduler` to create repeating jobs:

```typescript
await queue.upsertJobScheduler(
  ScheduledJobName.Heartbeat,
  { every: 1 * 60 * 60 * 1000 }, // Every hour
);

await queue.upsertJobScheduler(
  ScheduledJobName.SleepCheck,
  { every: 60 * 1000 }, // Every 60 seconds
);

await queue.upsertJobScheduler(
  ScheduledJobName.RefreshSnapshots,
  { every: 24 * 60 * 60 * 1000 }, // Every 24 hours
);

await queue.upsertJobScheduler(
  ScheduledJobName.Coach,
  { every: 60 * 60 * 1000 }, // Every 60 minutes
);

await queue.upsertJobScheduler(
  ScheduledJobName.ConflictScan,
  { every: 60 * 60 * 1000 }, // Every 60 minutes
);

await queue.upsertJobScheduler(
  ScheduledJobName.Announcer,
  { every: 60 * 60 * 1000 }, // Every 60 minutes
);

await queue.upsertJobScheduler(
  ScheduledJobName.Suggester,
  { every: 60 * 60 * 1000 }, // Every 60 minutes
);

await queue.upsertJobScheduler(
  ScheduledJobName.SentryTriage,
  { every: 60 * 60 * 1000 }, // Every 60 minutes
);

await queue.upsertJobScheduler(
  ScheduledJobName.DependabotTriage,
  { every: 60 * 60 * 1000 }, // Every 60 minutes
);

await queue.upsertJobScheduler(
  ScheduledJobName.BackgroundAgentOnboarding,
  { every: 60 * 60 * 1000 }, // Every 60 minutes
);
```

**Worker Configuration:**

- **Concurrency:** 5
- **Retries:** 3 attempts with exponential backoff (initial delay: 2s)
- **Retention:** Completed jobs kept for 1 hour (max 100); failed jobs kept for 24 hours

**Job Processors:**

- `heartbeatJob` — Updates Redis with scheduler health timestamp
- `sleepCheckJob` — Claims due runtime sleep actions once `cloud_jobs.sleepAt` is reached, snapshotting resumable jobs and destroying non-resumable provider instances
- `refreshSnapshotsJob` — Creates daily `SnapshotEnvironment` refresh jobs for ready environment snapshots, skips environments that already have an active refresh job, and leaves the current snapshot in place until the replacement succeeds
- `coachJob` — Runs the background coaching analysis on its scheduled cadence, combining review feedback, task transcripts, and repo guidance (`AGENTS.md` plus `.agent-guidance/README.md` when present) so recommendations prefer reusable code/tests or the nearest maintained doc before top-level `AGENTS.md` changes
- `conflictScanJob` — Scans repositories for merge conflicts on idle, labeled PR branches
- `announcerJob` — Builds scheduled Slack digests of merged pull requests
- `pullRequestAnalyticsSyncJob` — Refreshes the Postgres-backed GitHub PR facts cache used by web analytics, processing a bounded set of active repositories each run and respecting repo cooldowns after GitHub rate-limit responses
- `suggesterJob` — Due-gates the deployment by `suggesterFrequency` plus `suggesterLastRunAt`, then enqueues a hidden Suggested Tasks cloud task over active GitHub repositories while attaching per-repo environment coverage to the prompt so scheduled ideas can launch into a specific environment-backed repo workspace or fall back to explicit bare-repo mode
- `sentryTriageJob` — Built on the shared scheduled-triage runner (`apps/bullmq/src/scheduled-jobs/scheduled-triage-runner.ts`), which due-gates by the `sentry_triage` row in `background_automations` and verifies the configured Slack destination. The job additionally verifies an authenticated deployment-scoped Sentry MCP connection, resolves repository-to-environment coverage for active repositories, then enqueues a hidden read-only `SuggestedTasks` job that invokes the packaged `$sentry-triage` skill and asks for at most one repo-scoped `act` automation work item (suggest items are rejected) so the follow-up stays on the late-bound single-closeout Slack path as other execution tasks. Sentry follow-up work items must target a repository from the prompt's `Repository environments` section, copy the matching `targetEnvironmentId`, and do not allow bare-repo fallback. The scheduler posts a plain Slack report only for blockers, no-op runs, or non-launchable findings, and updates the automation row's `lastRunAt`
- `dependabotTriageJob` — Built on the same shared scheduled-triage runner, which handles the `dependabot_triage` due-gating and the Manager Channel check. The job additionally verifies an active GitHub installation, narrows the scan scope to repositories that already have configured Roomote environments, and enqueues a hidden read-only `SuggestedTasks` job that invokes the packaged `$dependabot-triage` skill and asks for up to three environment-backed `act` automation work items for the highest-priority cohesive updates, with at most one item per target environment (suggest items are rejected). The scheduled producer records the background automation run linkage when it creates the cloud job so `submit_automation_work_items` can verify the scan source. Each execution task starts silently with only trusted Slack channel metadata, late-binds its Slack thread on the first meaningful outbound reply, and updates tracked automation-thread metadata so later Slack replies route back into the execution task instead of the original scan task. The scheduler posts a plain Slack report only for blockers, no-op runs, or missing eligible configured-environment candidates, and updates the automation row's `lastRunAt`
- `ciFailureTriageJob` — Serves only the manual Run-now trigger for the webhook-driven CI Failure Triage automation; it is never registered with a job scheduler (the automatic trigger is the GitHub `workflow_run.completed` handler in apps/api, which launches an immediate per-repository scan and records `triggerKind: 'webhook'`). Built on the shared scheduled-triage runner, the manual scan verifies an active GitHub installation, narrows the scan scope to repositories with configured Roomote environments, and enqueues a hidden read-only `SuggestedTasks` job that invokes the packaged `$ci-failure-triage` skill against failed default-branch workflow runs since the previous pass. Scans ask for up to three environment-backed `act` automation work items (one per target environment, suggest items rejected) with repro-first execution prompts and stable failure fingerprints so repeated triage of the same broken state deduplicates. Clean scans stay silent in Slack; only GitHub setup/auth blockers are reported to the manager channel
- `securityAuditorJob` — First due-gates by the `security_auditor` row in `background_automations`, verifies GitHub plus the configured Slack destination, enqueues at most one hidden read-only `SuggestedTasks` audit over up to 250 merged PRs per scheduler pass, and persists a scan cursor in automation settings when more PRs remain so large backlogs drain across later hourly passes instead of being skipped. Follow-up work items are act-only, must target repositories from the prompt's `repository_environments` section, must copy the matching `targetEnvironmentId`, and do not allow bare-repo fallback.

BullMQ startup now only upserts the currently supported scheduler ids. Legacy
scheduler cleanup is an explicit operator action via
`apps/bullmq/scripts/cleanup-legacy-scheduled-jobs.ts`, which inspects the
`scheduled-jobs` queue and removes unknown scheduler ids and unknown delayed
jobs only when run with `--apply`.

Example operator commands:

```bash
pnpm --filter @roomote/bullmq exec tsx scripts/cleanup-legacy-scheduled-jobs.ts
pnpm --filter @roomote/bullmq exec tsx scripts/cleanup-legacy-scheduled-jobs.ts --apply
```

`sleepCheckJob` is the single BullMQ owner for due sleep transitions on snapshot-capable compute providers. The worker persists the authoritative `sleepAt` deadline, refreshes it every 45 seconds while a turn is actively running, and uses at least a 60-second active-task lease even when the task's idle keepalive is zero so live turns are not claimed as due sleep immediately. Once the task goes idle, the deadline stops moving and falls back to the normal keepalive window. BullMQ claims the due action by setting `cloud_jobs.sleepRequestedAt`, and then it either requests a snapshot for resumable task types or destroys the provider instance directly for non-resumable ones.

The sleep check must keep candidate reads bounded because it runs every minute
against the hot `cloud_jobs` table. It selects only the columns needed for
provider status checks, event recording, and snapshot/shutdown decisions, caps
each due-sleep, stale-worker, and provider-timeout candidate scan to one batch,
orders bounded due and stale batches by `sleepAt` and `workerHeartbeatAt` so
the oldest actionable rows drain first, and relies on the
`cloud_jobs_sleep_check_due_idx`, `cloud_jobs_sleep_check_stale_worker_idx`, and
`cloud_jobs_sleep_check_active_idx` partial indexes for the shared active-job
predicate.

### Sandbox OIDC Refresh Queue

**File:** `apps/bullmq/src/sandbox-oidc-refresh-queue.ts`

`refreshSandboxOidcJob` is the single BullMQ owner for ongoing sandbox OIDC
rotation. It runs in the dedicated `sandbox-oidc-refresh-jobs` queue every 60
seconds instead of sharing the general `scheduled-jobs` worker pool, so slow
token writes cannot consume scheduled-job slots needed by sleep checks and long
scheduled jobs cannot delay token refresh work.

Each refresh pass claims due machine groups from `sandbox_oidc_targets`, rewrites
the target token files in place, and deletes stale rows when the referenced
cloud job no longer matches the provider machine. Tokens are
minted with a one-hour lifetime and refreshed 20 minutes before expiry. Claimed
rows are leased for two minutes, which leaves enough expiry runway for retries if
a BullMQ worker exits or a provider write fails mid-pass.

The SDK refresh loop processes claimed machines with bounded parallelism and
continues after per-machine failures. The job result reports refreshed, cleaned,
and failed machine counts so one unavailable sandbox does not block refresh for
the rest of the batch.

### Snapshot Jobs Queue

**File:** `apps/bullmq/src/snapshot-queue.ts`

**Processor:** `apps/bullmq/src/jobs/snapshot.ts`

Handles asynchronous snapshot creation for provider machines (Modal and E2B today):

1. **Fetch CloudJob:** Load job record from database
2. **Validate Instance Status:** Check if the provider instance is running via `createComputeProviderClient()`
3. **Create Snapshot:** Call `client.createSnapshot({ instanceId })`
4. **Update Database:**
   - Set `cloudJobs.snapshotId`, `snapshotCreatedAt`, `status = Completed`
   - If job type is `SnapshotEnvironment`, attach the ready snapshot to the pending `environment_snapshots` row via `attachEnvironmentSnapshot()` (the legacy `environments` snapshot columns are no longer written)
5. **Drain Pending Messages:** Call `drainLinearMessagesToResumeJob()` and `drainSlackMessagesToResumeJob()` to prevent message loss during manual snapshots

**Expiry:** Snapshots use Roomote expiry bookkeeping of 7 days (`SANDBOX_SNAPSHOT_EXPIRY_MS`).

### Slack PR Inactivity Queue

**File:** `apps/bullmq/src/slack-pr-inactivity-queue.ts`

**Processor:** `apps/bullmq/src/jobs/slack-pr-inactivity-check.ts`

On-demand queue for checking PR inactivity and sending Slack notifications when PRs have been idle for a configured threshold.

### PR Review Notification Queue

**File:** `apps/bullmq/src/pr-review-notification-queue.ts`

**Processor:** `apps/bullmq/src/jobs/pr-review-notification.ts`

Notification-only relay of GitHub PR review activity back to the originating conversation (Slack, Teams, or Telegram) of the task that owns the pull request. The GitHub webhook handlers (`pull_request_review.submitted`, `pull_request_review_comment.created`) call `enqueuePrReviewNotification()` (`packages/sdk/src/server/lib/cloud-jobs/pr-review-notification.ts`) for non-mention review events on task-linked PRs. Pending events accumulate in a per-`(task, PR)` Redis list behind a debounce window, and a scheduled-marker key with `NX` suppresses duplicate job scheduling. When the delayed job fires it defers (re-schedules) while the owning task is still executing a turn (checked with the phase-based `isCloudTaskExecutingTurn()`, because live sandboxes keep an `Idle` status during follow-up turns and only `taskPhase` reflects mid-turn state) — the notification only posts while the task is idle, and if the task never goes idle before the deferral cap (roughly the 24-hour pending-events TTL) the pending feedback is dropped instead of posting mid-run. The BullMQ processor is a thin transport adapter: `preparePrReviewNotificationDelivery()` in `packages/sdk/src/server/lib/cloud-jobs/pr-review-notification-delivery.ts` owns route resolution, PR-state triage context, helper-model message generation, and provider-specific link formatting, while `recordPrReviewNotificationDeliveryBestEffort()` persists the transcript entry and tracks Slack replies as out-of-band so `getIsSlackDiverged()` re-surfaces the notification to the next follow-up turn via `<replying_to>`. Web replies re-surface it too: the transcript entry is tagged `metadata.source: pr_review_notification` (an out-of-band source in `@roomote/types` task-message constants), and the web tRPC send paths (live-sandbox `sendPrompt` and snapshot-resume `restoreCloudJobSnapshot`) atomically claim un-resurfaced rows with `claimPendingOutOfBandTaskMessages()` (`packages/db/src/lib/out-of-band-task-messages.ts`) and prepend them to the user's prompt as an `<out_of_band_context>` block (built and display-stripped by `wrapOutOfBandContext()` / `normalizeTranscriptUserText()` in `@roomote/types`); claimed rows are stamped `metadata.outOfBandResurfacedAt` so later turns skip them, and failed sends release the claim. A not-worth-notifying decision still drops the notification deliberately — except for batches containing a Roomote self-review `review_summary` event, whose results are always passed along even when the review found nothing — while delivery-preparation failures throw so the job requeues the drained events and rethrows into BullMQ's retry/backoff, only dropping the feedback once retries are exhausted. When delivery preparation approves, the job posts one aggregated model-written message (no hardcoded header or footer; when the feedback has unhandled findings the message ends by asking whether the user wants the agent to work on them). No agent turn is started and no code is changed; the user's reply in the thread is what re-engages the task.

## Distributed Locking

### `withRedisLock` (Low-level Primitive)

**File:** `packages/redis/src/lock.ts`

```typescript
export async function withRedisLock<T>(
  key: string,
  options: { ttlSeconds?: number; redis?: Redis },
  fn: () => Promise<T>,
): Promise<LockResult<T>>;
```

**Behavior:**

1. **Acquire:** `SET key ownerId EX ttl NX`
2. **On Success:** Execute `fn()`. If it succeeds, let the lock expire naturally (TTL-based). If it throws, release the lock immediately and re-throw.
3. **On Failure:** Return `{ acquired: false }` immediately (no blocking)

**Safe Release:** Uses Lua script to conditionally delete only if value matches the owner ID, preventing accidental release of another process's lock.

**Use Cases:** Creation-guarding locks where the lock should outlive the operation briefly (e.g., preventing duplicate resource creation).

### `withContention` (Leader/Follower Pattern)

**File:** `packages/redis/src/lock.ts`

```typescript
export async function withContention<T>(
  key: string,
  options: ContentionOptions<T>,
): Promise<ContentionResult<T>>;
```

**Behavior:**

1. **Try Acquire:** Call `withRedisLock(key, fn)`
2. **Leader Path:** If acquired, run `onAcquired()` and return `{ acquired: true, value }`
3. **Follower Path:** If lock is held by another process:
   - Poll `onContended()` at `intervalMs` (default: 500ms) for up to `maxAttempts` (default: 10)
   - If `onContended()` returns a non-`undefined` value, return `{ acquired: false, value }`
   - If polling exhausted, return `{ acquired: false, value: undefined }`

**Use Cases:** Coordinating creation of shared resources where followers can wait for the leader to finish and then retrieve the result.

### Repo-Level Conflict Locks

**File:** `apps/api/src/handlers/github/conflict-resolution/repo-lock.ts`

```typescript
export async function acquireRepoLock(
  redis: RedisClient,
  owner: string,
  repo: string,
): Promise<(() => Promise<void>) | null>;
```

**Key Pattern:** `conflict-resolution:lock:{owner}/{repo}`

**Purpose:** Ensures only one conflict-resolution run executes per repository at a time. Prevents redundant scans when multiple PRs have conflicts simultaneously.

**TTL:** Configurable via `CONFLICT_LOCK_TTL_SECONDS` (default 15 minutes).

**Release:** Returns a closure that uses a Lua script to conditionally delete the lock only if the value matches the original lock owner.

## Caching Patterns

### Feature Flag Metadata Cache

**File:** `packages/feature-flags/src/cache.ts`

```typescript
export class MetadataCache {
  constructor(private redis: Redis) {}

  async get(
    entityType: 'user' | 'organization',
    entityId: string,
  ): Promise<MetadataRecord | null>;
  async set(
    entityType: 'user' | 'organization',
    entityId: string,
    metadata: MetadataRecord,
  ): Promise<void>;
  async invalidate(
    entityType: 'user' | 'organization',
    entityId: string,
  ): Promise<void>;
}
```

**Key Pattern:** `feature-flags:metadata:{entityType}:{entityId}`

**TTL:** 5 minutes (300 seconds)

**Purpose:** Caches user/org metadata used for feature flag evaluation, reducing repeated database queries.

**Invalidation:** Called when user or deployment metadata changes.

### Auth Session Cache (Web App)

Browser sessions are backed by Better Auth database tables. Roomote keeps local authentication user/deployment scoped and does not use Better Auth workspace management.

### Preview Proxy Auth State

**File:** `apps/preview-proxy/src/services/auth.ts`

```typescript
export async function storeState(
  state: string,
  redirectUri: string,
  cloudJobId: number,
): Promise<void> {
  const data = JSON.stringify({
    redirectUri,
    cloudJobId,
    createdAt: Date.now(),
  });
  await redis.setWithExpiry(`preview:state:${state}`, data, 600); // 10 minutes
}

export async function validateState(
  state: string,
): Promise<{ redirectUri: string; cloudJobId: number } | null> {
  const data = await redis.get(`preview:state:${state}`);
  if (!data) return null;
  await redis.del(`preview:state:${state}`); // One-time use
  return JSON.parse(data);
}
```

**Key Pattern:** `preview:state:{state}` (where `state` is a UUID)

**TTL:** 10 minutes (600 seconds)

**Purpose:** Stores OAuth state parameter during preview authentication flow. Ensures state is valid and used only once (deleted on validation).

## Message Queueing (Communication Providers & Linear)

### Communication Provider Messages

**File:** `packages/communication/src/messages.ts`

```typescript
export async function queueCommunicationMessage(
  provider: CommunicationProvider,
  cloudJobId: number,
  message: QueuedCommunicationMessage,
): Promise<void> {
  const key = getCommunicationMessagesKey(provider, cloudJobId);
  await redis.rpush(key, JSON.stringify(message));
  await redis.expire(key, 3600); // 1 hour TTL
}

export async function getCommunicationMessages(
  provider: CommunicationProvider,
  cloudJobId: number,
): Promise<QueuedCommunicationMessage[]> {
  const key = getCommunicationMessagesKey(provider, cloudJobId);
  // Atomic: LRANGE then DEL via MULTI
  const results = await redis.multi().lrange(key, 0, -1).del(key).exec();
  // ... parse results ...
}
```

**Key Patterns:** `slack:messages:{cloudJobId}`, `teams:messages:{cloudJobId}`, `telegram:messages:{cloudJobId}`

**TTL:** 1 hour (3600 seconds)

**Purpose:** Queues chat follow-up messages for an active cloud job. Slack compatibility helpers in `packages/slack/src/slack-messages.ts` delegate to this queue; Teams and Telegram use the provider-neutral helpers directly, and future chat providers should do the same.

**Atomicity:** `getCommunicationMessages` uses a `MULTI` transaction to ensure no messages are lost between `LRANGE` and `DEL`.

### Linear Messages

**File:** `packages/linear/src/queue-linear-message.ts`

```typescript
export async function queueLinearMessage(
  cloudJobId: number,
  sessionId: string,
  payload: AgentSessionEventPayload,
): Promise<boolean> {
  const message: LinearSessionMessage = {
    sessionId,
    organizationId,
    action,
    payload,
    timestamp,
  };
  const key = `linear:messages:${cloudJobId}`;
  await redis.rpush(key, JSON.stringify(message));
  await redis.expire(key, LINEAR_MESSAGE_QUEUE_TTL); // 1 hour
}

export async function clearLinearMessageQueue(
  cloudJobId: number,
): Promise<void> {
  const key = `linear:messages:${cloudJobId}`;
  await redis.del(key);
}
```

**Key Pattern:** `linear:messages:{cloudJobId}`

**TTL:** 1 hour (3600 seconds)

**Purpose:** Same pattern as Slack messages. Queues Linear session events for active jobs.

## Event Deduplication (Slack Webhooks)

**File:** `apps/api/src/handlers/slack/index.ts`

```typescript
const SLACK_EVENT_DEDUP_PREFIX = 'slack:event:';
const EVENT_DEDUP_TTL_SECONDS = 3600; // 1 hour

// Store event ID with TTL
await redis.set(
  `${SLACK_EVENT_DEDUP_PREFIX}${body.event_id}`,
  '1',
  'EX',
  EVENT_DEDUP_TTL_SECONDS,
  'NX',
);
```

**Purpose:** Slack retries webhook delivery if the first attempt times out. Storing the `event_id` with `NX` (only if not exists) ensures duplicate events are ignored.

**TTL:** 1 hour — Slack typically retries within a few minutes, so 1 hour provides ample margin.

## Redis Key Patterns Reference

| Key Pattern                                      | Purpose                                   | TTL        | Source                                                          |
| ------------------------------------------------ | ----------------------------------------- | ---------- | --------------------------------------------------------------- |
| `queue:cloud-jobs`                               | Primary job queue (list)                  | None       | `CloudJobQueue`                                                 |
| `{scope}`                                        | Job scope lock (PR review, etc.)          | 1 hour     | `CloudJobQueue.acquireLock`                                     |
| `controller:heartbeat`                           | Controller liveness timestamp             | 10 minutes | `BaseController`                                                |
| `scheduler:last-update`                          | Scheduler heartbeat timestamp             | 24 hours   | `apps/bullmq/src/scheduled-jobs/heartbeat.ts`                   |
| `scheduler:update-history`                       | List of recent scheduler updates (max 10) | None       | `apps/bullmq/src/scheduled-jobs/heartbeat.ts`                   |
| `slack:messages:{cloudJobId}`                    | Queued Slack messages for active job      | 1 hour     | `packages/slack/src/slack-messages.ts`                          |
| `teams:messages:{cloudJobId}`                    | Queued Teams messages for active job      | 1 hour     | `packages/communication/src/messages.ts`                        |
| `telegram:messages:{cloudJobId}`                 | Queued Telegram messages for active job   | 1 hour     | `packages/communication/src/messages.ts`                        |
| `linear:messages:{cloudJobId}`                   | Queued Linear messages for active job     | 1 hour     | `packages/linear/src/queue-linear-message.ts`                   |
| `slack:event:{event_id}`                         | Slack webhook event deduplication         | 1 hour     | `apps/api/src/handlers/slack/index.ts`                          |
| `teams:activity:{activity_id}`                   | Teams webhook activity deduplication      | 5 minutes  | `apps/api/src/handlers/teams/index.ts`                          |
| `telegram:update:{update_id}`                    | Telegram webhook update deduplication     | 5 minutes  | `apps/api/src/handlers/telegram/index.ts`                       |
| `slack:pending_workspace_selections`             | Slack workspace selection state           | Varies     | `@roomote/redis/REDIS_KEYS`                                     |
| `preview:state:{state}`                          | Preview proxy OAuth state parameter       | 10 minutes | `apps/preview-proxy/src/services/auth.ts`                       |
| `feature-flags:metadata:{entityType}:{entityId}` | Feature flag metadata cache               | 5 minutes  | `packages/feature-flags/src/cache.ts`                           |
| `auth:{userId}`                                  | Cached Better Auth user object            | 1 hour     | `apps/web/src/lib/server/auth-cache-service.ts`                 |
| `conflict-resolution:lock:{owner}/{repo}`        | Conflict resolution repo-level lock       | 15 minutes | `apps/api/src/handlers/github/conflict-resolution/repo-lock.ts` |

## BullMQ Dashboard

**URL:** `http://localhost:13002/admin/queues`

**Features:**

- Real-time queue metrics (waiting, active, completed, failed, delayed)
- Job scheduler (cron-style repeating jobs) inspection
- Retry failed jobs
- View job details and stack traces

**Authentication:**

- Development: No auth
- Production/Preview: Basic auth (`admin` / `DASHBOARD_PASSWORD` env var)

**Health Endpoint:** `GET /admin/health`

Returns Redis status, queue counts, and timestamp.

**Stats Endpoint:** `GET /admin/stats`

Returns queue metrics and repeating job schedules.

## Key Files Reference

### Core Redis Packages

- `packages/redis/src/index.ts` — Redis client factory, REDIS_KEYS constants
- `packages/redis/src/lock.ts` — `withRedisLock`, `withContention` primitives

### CloudJobQueue

- `packages/cloud-agents/src/server/cloud-job-queue.ts` — Queue implementation, enqueue/dequeue logic
- `apps/controller/src/BaseController.ts` — Controller dequeue loop, heartbeat

### BullMQ

- `apps/bullmq/src/index.ts` — Dashboard server setup
- `apps/bullmq/src/redis.ts` — BullMQ-specific Redis connection
- `apps/bullmq/src/scheduler.ts` — Scheduled jobs queue
- `apps/bullmq/src/sandbox-oidc-refresh-queue.ts` — Dedicated sandbox OIDC refresh queue
- `apps/bullmq/src/snapshot-queue.ts` — Snapshot job queue
- `apps/bullmq/src/slack-pr-inactivity-queue.ts` — Slack PR inactivity queue
- `apps/bullmq/src/pr-review-notification-queue.ts` — PR review-feedback notification queue (Slack, Teams, Telegram)
- `apps/bullmq/src/jobs/snapshot.ts` — Snapshot job processor
- `apps/bullmq/src/scheduled-jobs/heartbeat.ts` — Heartbeat job
- `apps/bullmq/src/scheduled-jobs/refresh-sandbox-oidc.ts` — Sandbox OIDC refresh job
- `apps/bullmq/src/scheduled-jobs/refresh-snapshots.ts` — Snapshot refresh job
- `apps/bullmq/src/scheduled-jobs/sleep-check.ts` — Due sleep-action dispatcher for runtime provider instances
- `apps/bullmq/src/scheduled-jobs/conflict-scan.ts` — Conflict scan job

### Caching

- `packages/feature-flags/src/cache.ts` — Feature flag metadata cache
- `apps/web/src/lib/server/auth-cache-service.ts` — Better Auth auth cache
- `apps/preview-proxy/src/services/auth.ts` — Preview proxy OAuth state

### Message Queueing

- `packages/slack/src/slack-messages.ts` — Slack message queue
- `packages/slack/src/drain-slack-messages.ts` — Drain messages on job completion
- `packages/linear/src/queue-linear-message.ts` — Linear message queue
- `packages/linear/src/drain-linear-messages.ts` — Drain messages on job completion

### Distributed Locking

- `apps/api/src/handlers/github/conflict-resolution/repo-lock.ts` — Repo-level conflict locks

## Monitoring & Observability

### Controller Heartbeat

**Key:** `controller:heartbeat`

**Update Frequency:** Every iteration of the controller loop (typically < 1s when jobs are available, ~1s when idle)

**TTL:** 10 minutes

**Purpose:** External monitoring can query this key to verify the controller is alive. If the key is missing or the timestamp is stale, the controller may be stuck or down.

### Scheduler Heartbeat

**Key:** `scheduler:last-update`

**Update Frequency:** Every hour (via scheduled job)

**TTL:** 24 hours

**Purpose:** Verifies BullMQ scheduler is processing jobs. The scheduler also maintains a history of recent updates in `scheduler:update-history` (max 10 entries).

### BullMQ Metrics

All BullMQ queues expose metrics via the dashboard at `http://localhost:13002/admin/queues`:

- **Waiting:** Jobs in the queue waiting to be processed
- **Active:** Jobs currently being processed by workers
- **Completed:** Completed jobs (retained for 1 hour, max 100)
- **Failed:** Failed jobs (retained for 24 hours)
- **Delayed:** Jobs scheduled for future execution
- **Repeat:** Cron-style repeating jobs

**Programmatic Access:** `GET /admin/stats` returns JSON with queue counts and repeating job schedules.

## Best Practices

### Lock TTLs

Always set a TTL on distributed locks to prevent deadlocks from crashed workers:

```typescript
await redis.set(key, ownerId, 'EX', ttlSeconds, 'NX');
```

**Typical TTLs:**

- CloudJob scope locks: 1 hour (`TASK_TIMEOUT_MS`)
- Conflict resolution locks: 5 minutes
- Feature flag creation locks: 30 seconds

### Atomic Operations

Use Lua scripts or `MULTI` transactions for atomic read-modify-write:

```typescript
// Atomic get-and-delete
const results = await redis.multi().lrange(key, 0, -1).del(key).exec();
```

### Idempotent Event Handling

Use `SET ... NX` to deduplicate webhook events:

```typescript
const deduped = await redis.set(
  `slack:event:${event_id}`,
  '1',
  'EX',
  3600,
  'NX',
);

if (deduped !== 'OK') {
  console.log('Duplicate event, skipping');
  return;
}
```

### Cache Expiry

Set realistic TTLs based on data volatility:

- **High-frequency updates** (auth sessions): 1 hour
- **Low-frequency updates** (feature flag metadata): 5 minutes
- **One-time tokens** (OAuth state): 10 minutes

### BullMQ Retry Strategy

Configure retries with exponential backoff:

```typescript
defaultJobOptions: {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
}
```

**Retention:** Keep completed jobs for debugging (1 hour, max 100) but expire failed jobs more slowly (24 hours) for post-mortem analysis.

## Troubleshooting

### Queue is Growing Unbounded

**Symptoms:** `queue:cloud-jobs` list length keeps growing; no jobs are being dequeued.

**Likely Causes:**

1. Controller is down (check `controller:heartbeat` key)
2. All jobs are failing lock acquisition (scope collision)
3. Database connection issues preventing job lookups

**Resolution:**

- Verify controller is running: `pm2 status` or check logs
- Inspect queue contents: `redis-cli LRANGE queue:cloud-jobs 0 -1`
- Check for stuck scope locks: `redis-cli KEYS '*:*'` and look for PR-scope locks with long TTLs

### BullMQ Jobs Stuck in "Active"

**Symptoms:** Dashboard shows jobs in "active" state for hours.

**Likely Causes:**

1. Worker process crashed mid-job
2. Job timed out but worker didn't gracefully fail it
3. Redis connection lost during job execution

**Resolution:**

- Restart BullMQ worker: `pm2 restart bullmq`
- Manually retry/fail stuck jobs via dashboard
- Check worker logs for errors

### Cache Misses on Every Request

**Symptoms:** High Redis GET miss rate, slow responses.

**Likely Causes:**

1. TTL too short for the data's update frequency
2. Cache key pattern mismatch (e.g., userId vs user_id)
3. Redis eviction policy evicting keys prematurely

**Resolution:**

- Increase TTL if appropriate
- Add logging to verify cache key format
- Check Redis memory usage: `redis-cli INFO memory`

### Lock Contention

**Symptoms:** Jobs re-enqueued repeatedly; no progress.

**Likely Causes:**

1. TTL too short (lock expires before job completes)
2. Worker not releasing lock on error
3. Multiple workers trying to acquire the same scope lock

**Resolution:**

- Increase lock TTL if jobs legitimately take longer
- Verify `safeRelease()` is called in error paths
- Check logs for lock acquisition failures

## Related Documentation

- [Database Architecture](./database.md) — Postgres schema, migrations, Drizzle ORM
- [Compute Providers](./compute-providers.md) — Worker spawning and provider abstractions
- [Authentication & Authorization](./auth.md) — Job tokens, Better Auth integration
- [Feature Flags](./feature-flags.md) — Redis-backed feature flag evaluation
