---
title: Database Architecture
status: active
last_reviewed: 2026-07-09
owner: engineering
summary: Technical documentation of the database architecture covering PostgreSQL schema, the tasks/task_runs work-execution spine, ClickHouse analytics, Drizzle ORM patterns, encrypted columns, migrations, and test factories.
---

# Database Architecture

Roomote uses a multi-database architecture with PostgreSQL as the primary transactional database, ClickHouse for analytics and time-series data, and Redis for caching and queue management.

## Overview

### Database Stack

- **PostgreSQL 17**: Primary relational database for all application data
- **ClickHouse**: Analytics and time-series data (worker logs, metrics)
- **Redis 7**: Job queue (BullMQ), real-time pub/sub (socket.io adapter), feature flags, and caching

### ORM & Type Safety

- **Drizzle ORM**: Type-safe query builder with full TypeScript integration
- **postgres** client library for connection pooling
- Single schema file at `packages/db/src/schema.ts` defining all tables and relations
- Migration files in `packages/db/drizzle/`

### Web Runtime Initialization

For `apps/web`, the database singleton is initialized explicitly during the Next.js Node.js runtime bootstrap after dotenvx-backed env validation completes. The web runtime must not lazily construct the shared DB client from ambient `process.env`, because warm Vercel instances can otherwise retain a client that was created from stale or missing env state. In practice:

- `apps/web` bootstraps dotenvx runtime env from `instrumentation.ts`
- that bootstrap explicitly initializes `@roomote/db` with the validated `DATABASE_URL`
- any later web-runtime DB access before explicit initialization fails fast instead of silently falling back to an ambient process env lookup

## Schema Organization

### Single Flat File Pattern

All schema definitions live in `packages/db/src/schema.ts` as a single flat file. Most table declarations are co-located with a nearby `relations()` definition for Drizzle's relational query API.

**Structure:**

```typescript
export const tableName = pgTable('table_name', {
  /* columns */
});
export const tableNameRelations = relations(tableName, ({ one, many }) => ({
  // relation definitions
}));
```

This pattern keeps related definitions together and makes the schema easier to navigate than splitting across multiple files.

## Key Table Groups

### Core Tables

**users**

- Primary key: `id` (text, assigned by the auth/seed layer)
- Stores local user entity, email, name, avatar, admin state, and active/deleted state
- `metadata` stores user metadata and user-scoped feature flags plus persisted personal preferences such as `color_theme`, `narration_mode`, and `show_debug_ui`
- Soft deletes via `deletedAt`
- Indexes on email and createdAt

**deploymentSettings**

- Singleton deployment row keyed by `id`
- Stores deployment-wide setup state, setup task linkage, initial admin user, and onboarding timestamps
- `licenseKey` holds the deployment's signed Roomote license key (nullable; verified at read time — see [Licensing & Seat Limits](../features/licensing.md))
- Owns deployment state directly; Roomote is a single-deployment app and every active user belongs to that deployment

**tasks**

The durable unit of work. One task = one conversation/piece of work; execution attempts live on `task_runs` (1:N, fresh launch plus snapshot resumes).

- Primary key: `id` (text, generated via `generateTaskId()`)
- **Classification** (stamped at creation, query-load-bearing): `workflow` (`standard` | `pr_review` | `pr_conflict_resolve` | `scan` | `mcp_recommendations` | `setup_onboarding` | `env_snapshot` | `eval`), `surface` (`web` | `api` | `slack` | `teams` | `telegram` | `linear` | `github` | `gitlab` | `gitea` | `ado` | `system`), `trigger` (`message` | `webhook` | `schedule` | `manual`), and `visibility` (`visible` | `hidden`, default `visible`). Hidden launches (scans, env snapshots, MCP recommendations) pass `visibility: 'hidden'`; user-facing queries filter with `isVisibleTask()` (`eq(tasks.visibility, 'visible')`)
- **Terminal state**: `state` (`active` | `completed` | `failed` | `canceled`, default `active`) replaces the old `completed` boolean. Only the `finishCloudJob()` terminal path writes it; live runtime phase stays on runs
- **Initiator stamp** (immutable, written once at creation): `initiatorKind` (`user` | `automation`), `initiatorUserId` (FK → `users`), `initiatorAutomation` (FK → `automations.key`; rows for every key are seeded by `ensureAutomationRows`), `actorExternalId` (raw external actor id such as a Slack user id or GitHub login, populated for either kind), and `actorDisplayName`. A CHECK constraint (`tasks_initiator_shape_check`) enforces the shape: a `user` initiator has no automation key and at least one of `initiatorUserId` / `actorExternalId`; an `automation` initiator has an automation key and no user FK
- **Commit-author block** (evaluated unconditionally at enqueue by `evaluateCommitAuthor()`): `commitAuthorKind` (`roomote` | `user` | `external`), `commitAuthorUserId`, `commitAuthorLogin`, `commitAuthorExternalId` (GitHub numeric id as text for `{id}+{login}@users.noreply.github.com` noreply emails), and `prAssigneeLogin`. The `external` kind preserves commit identity for unlinked humans with a GitHub identity (e.g. PR authors on conflict-resolution tasks)
- **Channel bindings** (nullable, deliberately NOT unique — one thread can host many tasks): `slackChannelId`, `slackThreadTs`, `linearSessionId`, `linearIssueId`, `linearOrganizationId`
- **Conversation cargo**: `title`, `prompt` (the initial task prompt; per-attempt/resume prompts live on runs), `draftPrompt`, `requestedWorkKind`/`requestedWorkKindSource`/`requestedWorkKindConfidence`, and `harnessInstructions`
- Stores harness type, model, and `computeDurationMs`; OpenCode per-message inference accounting is stored in `taskInferenceUsageEvents` and aggregate cost is computed from those raw events until a read path needs a dedicated cache
- **Soft delete** via `deletedAt`; queries filter `isNull(tasks.deletedAt)`. There is no tombstone table — S3 artifact cleanup reads soft-deleted rows directly
- Indexes on initiatorUserId, initiatorAutomation, workflow, `(visibility, activityAt)`, harnessSessionId, timestamp, activityAt, and createdAt

**taskPins**

- Allows users to pin tasks for quick access
- Unique constraint on `(userId, taskId)`
- Composite index on `(userId, updatedAt)` for efficient recent pins queries

**taskSuggestions**

- Deployment-wide persisted Suggested Tasks batches for the Home-page onboarding rail and scheduled automation runs
- Stores the suggestion title, prompt-ready brief, selected repository IDs, sort order, and optional `dismissedAt` timestamp
- Unique index on `(sourceTaskId, sortOrder)` preserves ordering within a single source task's generated batch
- `sourceTaskId` is nullable, so the database does not enforce deployment-wide uniqueness on `sortOrder` for rows that are not tied to a source task

**backgroundAgentSettings**

- Singleton deployment-wide configuration for background automation
- Includes shared `globalAgentInstructions` injected into all tasks, optional `styleGuidance` layered onto the default user-facing tone guidance, plus optional `suggesterInstructions` used only when generating Suggested Tasks
- Stores the shared `managerSlackChannelId` used by manager-facing Slack delivery, plus legacy per-feature channel columns that still backfill or fall back until the shared manager channel is explicitly saved
- Also stores the optional `platformIssueSlackChannelId` legacy row used for admin-visible Slack alerts when running tasks report admin-fixable platform blockers
- Persists cadence and last-run state for scheduled automations so BullMQ can due-gate the deployment independently of the global hourly scheduler

**backgroundAutomations / backgroundAutomationTargets**

- Stores deployment-wide durable automation rows keyed by automation key, with optional JSON `schedule`, JSON `settings`, and destination/scope rows in `backgroundAutomationTargets`
- `review_code` owns the Review Code automation config: enabled state, automatic review behavior (`reviewOnCommit`, `reviewDraftPrs`), whether automatic review includes PRs from authors outside Roomote (`reviewAllPullRequestAuthors`), comment-only approval policy, linked-task relay toggle, and `relayEligibleCreatorIds`
- GitHub PR-review webhook handlers read the `review_code` row through `getReviewCodeAutomationSettings()` instead of reading any cloud-agent table
- Slack-posting and scheduled automations store their per-automation destinations or repository/service scopes in `backgroundAutomationTargets` when the setting is target-shaped rather than a scalar JSON setting

**taskPlatformIssueReports**

- Stores admin-fixable platform/configuration/access blockers explicitly reported by running tasks through the `report_platform_issue` MCP tool
- Links each report to the task, run, and optionally the persisted `task_messages` row that carried the tool result
- Persists the raw `{ title, summary }` report payload plus `slackPostedAt` so Slack delivery stays one-alert-per-report when a deployment-level alert channel is configured

**setupNewQueuedTasks**

- Stores the prompts selected during `/setup` while the onboarding environment build is still running
- Associates each queued prompt with the active setup onboarding task, the selecting user, and later the created environment plus launched task
- Uses `(setupOnboardingTaskId, sortOrder)` as the ordered queue key for one launch queue per setup task

**taskArtifacts**

- Stores file metadata for task outputs (S3 paths)
- Versioned artifacts with unique constraint on `(taskId, path, version)`
- Links to the run (`runId`) that created the artifact
- `uploaded` boolean tracks S3 upload status

**taskShares**

- Public/deployment-scoped sharing via unique `shareToken`
- Optional expiration via `expiresAt`
- `visibility` is stored as text with default `'deployment'`

**taskPullRequests**

- The only PR home: tracks PRs/MRs linked to a task across all source-control providers
- **Write-order inversion for PR-triggered work**: `pr_review` and `pr_conflict_resolve` launches INSERT their `task_pull_requests` row at enqueue, inside the task-creation transaction, from the `prLinkage` the caller passes to `enqueueCloudTask()`. Execution-time extraction only appends additional PRs the agent created
- Execution-time extraction prefers the structured PR-delivery tool result emitted by successful create/refresh PR flows, then falls back to parsing trusted `gh pr create`, `gh pr checkout`, and branch-scoped `gh pr list` command output from task messages
- `sourceControlProvider` (`github`/`gitlab`/`gitea`/`ado`, defaults to `github`) + `host` + optional `repositoryId` FK→`repositories` disambiguate a PR across providers and self-managed hosts; backfilled from `prUrl` for historical rows
- Stores PR URL, number, title, repository, status, plus review-flow state that used to live on cloud jobs: `prSha` (last observed head SHA, keyed by review dedup), `prBaseRef`, `prBaseSha`, and the GitHub-native `githubReactionId`, `githubCheckRunId`, `githubReviewCommentId`
- PR-review dedup queries (e.g. skip-already-reviewed-head, has-active-resolution-task) are `tasks JOIN task_pull_requests` reads, plus the latest run status where needed
- Unique constraint prevents duplicate PR URLs per task; webhook-facing readers scope lookups by `(sourceControlProvider, repository, prNumber)` to avoid cross-provider collisions

There is no `deletedTasks` tombstone table anymore; task deletion is a soft delete (`tasks.deletedAt`) and S3 artifact cleanup reads the soft-deleted rows.

### Task Runs & Execution

**taskRuns** (`task_runs`; renamed from `cloud_jobs` — many TS identifiers such as `CloudJob` and `cloudJobId` still use the old vocabulary pending a later rename pass)

One row per sandbox execution attempt of a task. A task has 1:N runs: one `fresh` run plus any number of `resume` runs. Resume creates a new run row on the same task — there is no cross-run field copying and no chain-walking; "runs of task X" is the whole story.

- Primary key: `id` (integer, auto-increment identity)
- `taskId`: real FK → `tasks(id)` with `ON DELETE CASCADE`
- `kind`: `fresh` | `resume` (replaces the old `SnapshotResume` task type as a classification signal); `sourceRunId` (FK → `task_runs.id`) is the parent run when resuming
- `actingUserId` (nullable FK → `users`): **the only user column on runs**. The launching or most recently acting human; null for automation runs. Set at enqueue, updated by follow-up senders/resumers. Job tokens and MCP OAuth key off it, falling back to the deployment service principal when null (see [Authentication & Authorization](./auth.md))
- `payloadKind`: runtime payload dispatch key (renamed from `type`; snake_case `TaskPayloadKind` values such as `standard`, `scan`, `github_pr_review`, `snapshot_resume`). No query outside runtime dispatch may branch on it — queries use `tasks.workflow`/`surface`/`visibility`
- `prompt`: the per-attempt prompt (including the deferred resume prompt); the initial task prompt lives on `tasks.prompt`
- Status lifecycle uses `CloudTaskStatus` values (`pending`, `dequeued`, `processing`, `preparing`, `spawning`, `connecting`, `running`, `completed`, `failed`, `canceled`, `idle`); `taskPhase` tracks live harness phase
- **Compute provider routing**: `vendor` identifies the worker backend (`docker`, `modal`, `daytona`, or `e2b`). Resumes inherit the source run's provider; fresh launches otherwise fall back to the requested `computeProvider` or the deployment default
- **Preview infrastructure**: `machineDomain`, `machineDomains`, `initialPaths`, `primaryPortName`, `proxyPorts`, `authBypassValue`, `authBypassHeaderName`
- **Snapshots/sleep**: `snapshotId`, `sourceSnapshotId`, `snapshotRequestedAt`, `snapshotCreatedAt`, `snapshotFailedAt`, `keepaliveMs`, `sleepAt`, `sleepRequestedAt`
- **Worker identity/liveness**: `workerReleaseTag`, `workerVersion`, `workerCommit`, `workerHeartbeatAt`
- **Git tracking**: `baseShas` stores HEAD SHA for each repo at run start
- Milestone timestamps (unchanged): `createdAt`, `dequeuedAt`, `provisionStartedAt`, `provisionReadyAt`, `startedAt`, `setupCompletedAt`, `harnessStartedAt`, `runtimeTaskStartedAt`, `firstAssistantOutputAt`, `completedAt`, `canceledAt`, segmented by `launchMode`

Deleted from runs (now on `tasks` or gone entirely): `userId`, all attribution/effective-author columns, `title`, `draftPrompt`, `requestedWorkKind*`, `harnessInstructions`, Slack/Linear channel bindings, the `pr*`/`githubPr*` columns (moved to `task_pull_requests`), and `type` (split into `tasks.workflow`×`surface`×`trigger`×`visibility` plus `runs.payloadKind`).

**taskRunEvents** (`task_run_events`; renamed from `cloud_job_events`)

- Append-only audit history for run lifecycle decisions and provider operations
- `runId` is a real FK → `task_runs(id)` CASCADE; `taskId` is a real FK → `tasks(id)` CASCADE
- See [Cloud Job Execution](./cloud-job-execution.md) for the event-source taxonomy

**taskMessages**

- Stores Roomote runtime message events from task execution in a protocol-agnostic envelope structure
- `protocol`: currently `'roomote_runtime'`
- `eventType`: Event-specific type (e.g., `roomote_runtime.tool_result`, `roomote_runtime.plan`)
- **Content layers**:
  - `contentBlocks`: Canonical renderable UI content (text, images, resources)
  - `metadata`: Envelope/routing context (sessionId, sender, sequence numbers)
  - `payload`: Event-specific typed machine state
- `source`: Where message originated ('web', 'slack', etc.) for notification routing
- Unique constraint on `(taskId, protocol, ts, eventType)` prevents duplicates
- `contentSchema` deprecated (kept for migration compatibility)

**taskInferenceUsageEvents**

- Stores hidden per-assistant-message OpenCode inference usage for task accounting
- Unique on `(harnessSessionId, messageId)` so replayed or retried persistence updates the same usage row instead of double-counting
- Captures provider/model IDs, input/output/reasoning/cache token counts, context tokens, cost in micro-USD, cost source, and OpenCode message timestamps
- `agent` stamps which harness agent produced the message: the main agent (`build`) for main-session turns and the subagent name (for example `explore` or `visual`) for child-session turns. The worker records child-session (subagent) assistant messages as their own usage rows, so per-agent cost grouping covers subagent spend too.
- Links to task (`taskId`, cascade) and run (`runId`, nullable, set-null). There is no private `userId` copy on usage satellites — per-user cost is a join through `tasks.initiatorUserId`
- No inference-usage rollup table exists today. Add one only when a concrete task-list, dashboard, or reporting read path needs cached aggregates.

### Integration Tables

**GitHub**

- **githubInstallations**: GitHub App installation for the deployment
  - `installationId`: GitHub's installation ID
  - `accountLogin`: GitHub org/user name
  - `permissions`: JSON blob of granted permissions
  - Unique on `installationId`

- **githubPendingInstallations**: Temporary records during setup flow

- **githubUserMappings**: Maps GitHub users to Roomote users
  - Stores encrypted OAuth tokens (`accessToken`, `refreshToken`)
  - `tokenExpiresAt` for token refresh logic
  - Unique on `githubUserId`

- **repositories**: Source-control repositories linked to the deployment
  - `sourceControlProvider`: `github`, `gitlab`, `gitea`, or `ado` (provider-scoped)
  - `host`: source-control instance host (e.g. `github.com`, a self-managed GitLab/Gitea host, `dev.azure.com`); nullable, backfilled from `htmlUrl`
  - Links to `githubInstallations` (GitHub app installations only)
  - `githubRepoId`: GitHub's repo ID (GitHub rows only); `externalRepoId` for other providers
  - `fullName`: owner/repo (or org/project/repo for ADO) format
  - `isActive`: Whether repo is enabled for agents
  - Unique on `githubRepoId`, and on `(sourceControlProvider, externalRepoId)` / `(sourceControlProvider, fullName)`

**Slack**

- **slackInstallations**: Slack workspace installations
  - `teamId`: Slack workspace ID (unique)
  - `botAccessToken`, `userAccessToken`: Installation tokens
  - `scopes`: JSON array of granted scopes

- **slackUserMappings**: Maps Slack users to Roomote users
  - Unique on `(slackUserId, slackTeamId)`

- **slackAuthTokens**: One-time tokens for user authentication flow
  - Links Slack threads to authenticated user context
  - Time-limited via `expiresAt`

**Linear**

- **linearInstallations**: Linear workspace installations
  - `linearOrganizationId`: Linear workspace ID (unique)
  - Encrypted `accessToken`, `refreshToken`
  - `appUserId`: The app's user ID in Linear workspace

- **linearUserMappings**: Maps Linear users to Roomote users
  - Unique on `(linearUserId, linearOrganizationId)`

- **linearAuthTokens**: One-time tokens for user authentication flow

- **linearPendingSelections**: Elicitation flow state
  - Tracks workspace selection during interactive prompts
  - Runtime uses `awaiting_workspace` and `completed`
  - `workspaceOptions`: Presented choices

### Environment Management

**environments**

- Multi-repository workspace configurations
- `config`: `EnvironmentConfig` JSON defining repos, services, commands, ports
- **Snapshot state**: lives in provider-keyed `environment_snapshots` rows
  (`snapshotId`, `snapshotStatus`, `snapshotCreatedAt`, `snapshotExpiresAt`,
  soft-delete `deletedAt`). The same-named legacy columns on `environments`
  are a Vercel-era mirror that is no longer read or written.
- Unique on `name`

**environmentRepositoryMappings**

- Junction table linking environments to repositories
- Unique on `(environmentId, repositoryId)`

**environmentVariables**

- Deployment-scoped or user-scoped environment variables
- `value`: Encrypted via `encryptedJson<string>()`
- Tracks who created and last updated
- Unique on `name`

### API Keys & Secrets

**userApiKeys**

- User-specific API keys for external services
- `apiKey`: Encrypted
- Unique on `(userId, provider)`

### MCP (Model Context Protocol)

**deploymentMcpEnablements**

- Deployment-level toggles for MCP server availability
- `mcpId`: MCP server identifier
- `enabled`: Boolean toggle
- Unique on `mcpId`

**mcpConnections**

- Deployment or user-level MCP server connections
- `authConfig`: OAuth/auth configuration
- Encrypted `accessToken`, `refreshToken`
- `authStatus`: 'pending' | 'authenticated' | 'error'
- Unique on `(userId, mcpId)` with null-aware handling for deployment-scoped connections
- A nullable `userId` represents a deployment-scoped connection

**oauthState**

- PKCE state for MCP OAuth flows
- Encrypted `codeVerifier`
- Time-limited via `expiresAt`

### Audit & Metadata

**webhooks**

- Audit log for incoming webhooks (GitHub, Slack, Linear)
- `deliveryId`: Unique webhook delivery identifier
- Status tracking: `succeededAt`, `failedAt`, `ignoredAt` (mutually exclusive via check constraint)

**alternativeSoftwareRequests**

- User requests for alternative integrations
- `category`: 'version_control' | 'collaboration' | 'task_management'

## Encrypted Columns

### Custom Drizzle Types

**Location:** `packages/db/src/lib/custom-types.ts`

Roomote defines two custom Drizzle column types for transparent encryption at rest:

#### `encryptedJson<TData>(name: string)`

Stores encrypted JSON data.

**Type behavior:**

- **INSERT**: Accepts `TData` (e.g., `Record<string, string>`) which gets encrypted
- **SELECT**: Returns `string | null` (the encrypted base64 value)
- **UPDATE**: Accepts either `TData` (re-encrypts) or `string` (passes through if already encrypted)

**Usage example:**

```typescript
// Schema definition
value: encryptedJson<Record<string, string>>('value');

// Insert
await db.insert(environmentVariables).values({
  value: { API_KEY: 'sk-123' }, // Encrypted automatically
});

// Query
const variable = await db.query.environmentVariables.findFirst();
console.log(variable.value); // "base64encodedstring..."

// Decrypt
import { decryptSecrets } from '@roomote/db/server';
const decrypted = await decryptSecrets(variable.value);
console.log(decrypted); // { API_KEY: "sk-123" }
```

**Used in:**

- `environmentVariables.value`

#### `encryptedText(name: string)`

Stores encrypted text strings.

**Type behavior:**

- **INSERT**: Accepts plain string which gets encrypted
- **SELECT**: Returns `string | null` (the encrypted base64 value)
- **UPDATE**: Accepts string (encrypts) or passes through if already encrypted

**Usage example:**

```typescript
// Schema definition
accessToken: encryptedText('access_token');

// Insert
await db.insert(githubUserMappings).values({
  accessToken: 'ghp_abc123', // Encrypted automatically
});

// Query
const mapping = await db.query.githubUserMappings.findFirst();
console.log(mapping.accessToken); // "base64encodedstring..."

// Decrypt
import { decryptText } from '@roomote/db/server';
const token = decryptText(mapping.accessToken);
console.log(token); // "ghp_abc123"
```

**Used in:**

- `githubUserMappings.accessToken`, `refreshToken`
- `linearInstallations.accessToken`, `refreshToken`
- `userApiKeys.apiKey`
- `mcpConnections.accessToken`, `refreshToken`
- `oauthState.codeVerifier`

### Encryption Implementation

**Location:** `packages/db/src/lib/encryption.ts`

- **Algorithm**: AES-256-GCM
- **Key derivation**: scrypt with random 32-byte salt per value
- **Authenticated encryption**: 16-byte GCM tag prevents tampering
- **Random IV**: 16 bytes per encryption operation
- **Key source**: `Env.ENCRYPTION_KEY` (must be set in environment)
- **Output format**: Base64-encoded concatenation of `[salt(32) + iv(16) + tag(16) + encrypted_data]`

**Helper functions:**

- `encrypt(text: string): string` - Encrypts plain text
- `decrypt(encryptedText: string): string` - Decrypts to plain text
- `encryptJSON<T>(data: T): string` - Encrypts JSON-serialized data
- `decryptJSON<T>(encryptedText: string): T` - Decrypts and parses JSON
- `decryptSecrets<T>(encryptedSecrets: string | null): Promise<T | null>` - Async wrapper with error handling
- `decryptText(encryptedString: string): string` - Alias for `decrypt()`

**Important:** Always use `decryptSecrets()` or `decryptText()` from `@roomote/db/server` after querying encrypted columns. Never try to use the raw encrypted string.

## Package Exports

### `@roomote/db` (Client-Safe)

**Source:** `packages/db/src/index.ts`

Minimal export containing only TypeScript types. Safe to import in browser/client code.

```typescript
export * from './types';
```

### `@roomote/db/server` (Server-Only)

**Source:** `packages/db/src/server.ts`

Full server-side export including:

**Database client & utilities:**

```typescript
import { db, createDb, disconnect } from '@roomote/db/server';
```

**Drizzle ORM operators:**

```typescript
import {
  eq,
  inArray,
  and,
  or,
  not,
  asc,
  desc,
  gt,
  gte,
  lt,
  lte,
  count,
  max,
  isNotNull,
  isNull,
  like,
  sql,
} from '@roomote/db/server';
```

**All schema tables:**

```typescript
import { users, deploymentSettings, tasks, taskRuns, repositories, ... } from '@roomote/db/server';
```

**Encryption helpers:**

```typescript
import {
  decryptSecrets,
  decryptText,
  encrypt,
  decrypt,
} from '@roomote/db/server';
```

**Utility functions:**

```typescript
import {
  createRowMapper,
  generateTaskId,
  createTaskWithRetry,
} from '@roomote/db/server';
```

**Test factories:** (See Test Factories section)

## Migration Workflow

### Development Workflow

1. **Edit schema**: Modify `packages/db/src/schema.ts`
2. **Generate migration**: `pnpm db:generate`
   - Runs `drizzle-kit generate` to create SQL in `packages/db/drizzle/`
   - Review the generated SQL file before applying
3. **Apply migration**: `pnpm db:migrate`
   - Runs `drizzle-kit migrate` to execute pending migrations
   - Safe to run multiple times (idempotent)

### Quick Iteration (Development Only)

For rapid schema experimentation without creating migration files:

```bash
pnpm --filter @roomote/db db:push
```

**Warning:** This uses `drizzle-kit push` which directly syncs schema to database, bypassing migrations. Only use locally during active development. Never use in production.

### Migration Files

**Location:** `packages/db/drizzle/`

- Named with pattern: `NNNN_adjective_character.sql`
- Generated by Drizzle Kit based on schema changes
- Tracked in `drizzle/meta/` snapshot files
- The data-model rebuild collapsed historical migrations; intermediate migrations on the `data-model-simplification` branch are throwaway until the final baseline collapse lands

**Running migrations in scripts:**

```typescript
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db } from '@roomote/db/server';

await migrate(db, { migrationsFolder: './drizzle' });
```

## ClickHouse Usage

**Current Status:** No ClickHouse-specific schema/client code lives in `packages/db/src/`.

ClickHouse service setup currently lives in worker runtime services (for example `apps/worker/src/services/clickhouse.ts`). It is used for analytics/time-series style workloads such as:

- Worker execution logs
- Performance metrics
- Usage analytics

Database package responsibilities remain PostgreSQL schema/queries and shared DB utilities.

## Test Factories

### Factory Library

**Location:** `packages/db/src/fixtures/factories/`

Built with **fishery** + **@faker-js/faker** for generating realistic test data.

**Available factories:**

- `userFactory` - Creates users with local-compatible IDs
- `taskFactory` - Creates tasks; defaults to a `standard`/`web`/`manual`/`visible` classification with a `user` initiator, generating a fake `actorExternalId` when no `initiatorUserId` is supplied so the initiator CHECK holds
- `runFactory` - Creates task runs (renamed from `cloudJobFactory`); auto-creates a backing task when `taskId` is omitted because `task_runs.task_id` is a real FK
- `githubInstallationFactory` - Creates GitHub installations
- `repositoryFactory` - Creates GitHub repositories
- `slackInstallationFactory` - Creates Slack installations
- `slackUserMappingFactory` - Maps Slack users to Roomote users
- `environmentFactory` - Creates environment configurations

**Exported from:** `@roomote/db/server`

### Usage in Tests

```typescript
import { db, userFactory, taskFactory, runFactory } from '@roomote/db/server';

// Create related records
const user = await userFactory.create();
const task = await taskFactory.create({
  initiatorUserId: user.id,
});
const run = await runFactory.create({
  taskId: task.id,
  actingUserId: user.id,
});

// Query the database
const result = await db.query.tasks.findFirst({
  where: eq(tasks.id, task.id),
});
```

**Factory pattern benefits:**

- Generates valid foreign keys automatically
- Uses faker for realistic data (names, emails, URLs)
- Supports overrides via `.create({ field: value })`
- Directly inserts into database (not mocks)

### Test Database Setup

`packages/db/src/fixtures/seed.ts` is a development seeding script (not a global test truncation hook).

At the monorepo level, `pnpm test` runs `pnpm --filter @roomote/db db:push:test` before workspace tests.

**Database safety checks** in `packages/db/src/db.ts`:

- Enforces `localhost`, `127.0.0.1`, or `::1` hostname in test mode
- Requires database name to be `test` or end with `_test` / `-test`
- Throws error if test database requirements not met

## Key Files Reference

### Schema & ORM

- `packages/db/src/schema.ts` - Single source of truth for all tables and relations
- `packages/db/src/db.ts` - Database client creation and connection management
- `packages/db/src/server.ts` - Server-side package exports
- `packages/db/src/index.ts` - Client-safe type-only exports

### Encryption

- `packages/db/src/lib/encryption.ts` - AES-256-GCM encryption/decryption
- `packages/db/src/lib/custom-types.ts` - `encryptedJson()` and `encryptedText()` column types

### Utilities

- `packages/db/src/lib/task-id.ts` - `generateTaskId()` for creating task identifiers
- `packages/db/src/lib/map-raw-row.ts` - `createRowMapper()` for transforming raw SQL results
- `packages/db/src/create-task.ts` - `createTaskWithRetry()` for atomic task creation with error handling

### Testing

- `packages/db/src/fixtures/factories/` - Fishery factories for test data generation
- `packages/db/src/fixtures/seed.ts` - Development seed script

### Migrations

- `packages/db/drizzle/` - Migration SQL files
- `packages/db/drizzle/meta/` - Drizzle Kit snapshot metadata

## Best Practices

### Schema Changes

1. Always edit `packages/db/src/schema.ts` as the source of truth
2. Generate migration with `pnpm db:generate` and review the SQL
3. Test migration locally before committing
4. Run `pnpm db:migrate` to apply changes

### Working with Encrypted Data

1. **Never** try to decrypt on the client - encrypted columns are server-only
2. Always import helpers from `@roomote/db/server`, not `@roomote/db`
3. Use `decryptSecrets()` for JSON columns, `decryptText()` for text columns
4. Handle null values when decrypting (columns may be null)

### Testing

1. Use factories instead of manual SQL inserts when a factory exists
2. Use the real test database when queries, auth scoping, transactions, or persistence semantics are part of the behavior under test
3. For orchestration-only unit tests, mock collaborators at the boundary instead of trying to reproduce SQL behavior in mocks
4. Verify database state after mutations when persistence is part of the contract

### Queries

1. Import operators from `@roomote/db/server`: `eq`, `and`, `or`, etc.
2. Use Drizzle's relational query API for joins:
   ```typescript
   await db.query.tasks.findFirst({
     where: eq(tasks.id, taskId),
     with: { user: true },
   });
   ```
3. For complex queries, use the SQL builder:
   ```typescript
   await db
     .select()
     .from(tasks)
     .where(and(eq(tasks.initiatorUserId, userId), isNull(tasks.deletedAt)));
   ```

### Package Imports

- **Client code**: Import from `@roomote/db` (types only)
- **Server code**: Import from `@roomote/db/server` (full API)
- Never mix - client imports will break if they pull in server code
