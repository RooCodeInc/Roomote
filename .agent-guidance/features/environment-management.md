---
title: Environment Management
status: active
last_reviewed: 2026-07-09
owner: engineering
summary: Technical documentation of Roomote environment and workspace management covering single-deployment configuration, config version history, snapshots, sandbox OIDC targets, compute target mapping, preview-auth bypass behavior, and preview defaults.
---

# Environment Management

Environments are isolated, pre-configured workspaces that define how Roomote tasks execute. Each environment specifies repositories to clone, services to start, and runtime context for AI agents.

## Overview

An **environment** is a declarative configuration that controls:

- **Repositories**: Which GitHub repos to clone and which branches to check out
- **Services**: Database, cache, and tool services to start (Postgres, Redis, ClickHouse, etc.)
- **Agent Instructions**: Custom startup environment instructions delivered through the harness system-prompt path for environment-specific guidance
- **Config History**: Saved environment definition versions that users can review and load back into the YAML editor
- **Snapshots**: Cached filesystem state for fast environment restoration

Environments are deployment-scoped and mutable via `trpc.environments.update`. Updated config applies to newly provisioned workers/jobs; already-running sandboxes are not mutated in place.

## Config Version History

Roomote keeps the live environment head in `environments.config` and stores
reviewable history in the append-only `environment_config_versions` table.

- environment creation stores version `1` with source `setup`
- web dashboard edits snapshot the previous saved environment state with source
  `user`
- MCP-driven environment updates used by the setup/onboarding agent snapshot
  the previous saved state with source `agent`
- the edit page can load a saved version into the YAML editor, but the current
  environment only changes when the user saves that loaded definition

The snapshot writer skips duplicate saves when the latest saved version already
matches the live environment. That keeps the initial setup snapshot from being
stored twice on the first edit while still preserving every restorable
historical state.

The environment edit page exposes three admin-only tRPC procedures for version
history:

- `environments.listConfigVersions({ environmentId })` returns lightweight
  version metadata for the history list
- `environments.getConfigVersion({ environmentId, version })` returns the full
  saved definition for a single version

Environment definition writers should route through
`packages/db/src/lib/environment-definitions.ts#updateEnvironmentDefinition`
instead of updating `environments.config` directly. The helper keeps the live
row update, provider snapshot invalidation, optional config-version write, and
optional repository-mapping replacement in one transaction. It compares the
requested definition to the current row first, so empty or otherwise unchanged
saves do not invalidate snapshots. This matters because environment snapshots
cache setup output; any effective environment definition change must soft-delete
active provider snapshots before a stale snapshot can be reused.

## Database Schema

Environments are stored in the `environments` table with related tables for repository mappings, provider-specific environment snapshots, and sandbox OIDC targets.

### `environments` Table

| Column              | Type        | Description                                                       |
| ------------------- | ----------- | ----------------------------------------------------------------- |
| `id`                | `uuid`      | Primary key                                                       |
| `userId`            | `text`      | Optional user association (FK to `users.id`)                      |
| `createdByUserId`   | `text`      | User who created the environment (FK to `users.id`)               |
| `name`              | `text`      | Unique name within the deployment                                 |
| `description`       | `text`      | Optional human-readable description                               |
| `config`            | `jsonb`     | Full `EnvironmentConfig` JSON blob                                |
| `isEval`            | `boolean`   | Marks eval-only environments that are hidden from normal listings |
| `snapshotId`        | `text`      | Legacy Vercel-era snapshot ID — no longer read or written         |
| `snapshotCreatedAt` | `timestamp` | Legacy snapshot creation timestamp — no longer read or written    |
| `snapshotExpiresAt` | `timestamp` | Legacy snapshot expiry timestamp — no longer read or written      |
| `snapshotStatus`    | `text`      | Legacy snapshot status — no longer read or written                |
| `createdAt`         | `timestamp` | Row creation timestamp                                            |
| `updatedAt`         | `timestamp` | Row update timestamp                                              |

**Indexes:**

- `environments_user_id_idx` on `userId`
- `environments_created_by_user_id_idx` on `createdByUserId`
- `environments_snapshot_expires_at_idx` on `snapshotExpiresAt`
- `environments_name_unique` unique index on `name`

### `environment_config_versions` Table

Append-only environment definition snapshots for version history and editor
restore flows.

| Column            | Type        | Description                                                    |
| ----------------- | ----------- | -------------------------------------------------------------- |
| `id`              | `uuid`      | Primary key                                                    |
| `environmentId`   | `uuid`      | FK to `environments.id`, cascade delete                        |
| `version`         | `integer`   | Monotonic version number per environment                       |
| `config`          | `jsonb`     | Full `EnvironmentConfig` snapshot                              |
| `name`            | `text`      | Environment name stored with the snapshot                      |
| `description`     | `text`      | Environment description stored with the snapshot               |
| `source`          | `text`      | Snapshot source: `setup`, `user`, `agent`, or `api`            |
| `createdByUserId` | `text`      | Optional FK to `users.id` for the actor who triggered the save |
| `createdAt`       | `timestamp` | Row creation timestamp                                         |

**Indexes:**

- `environment_config_versions_environment_id_idx` on `environmentId`
- `environment_config_versions_environment_version_unique` unique index on `(environmentId, version)`

### Eval-only environments

Roomote onboarding and evaluation flows can create temporary environment records for verification. Those rows stay in the same `environments` table but set `isEval = true`. The flag is internal metadata, not a normal user-managed environment setting.

Normal user-facing and router-driven environment resolution paths treat eval environments as hidden:

- `GET /api/environments`, the MCP `list_environments` flow, and Slack workspace pickers only return rows where `isEval = false`
- dashboard environment lists, setup/status matching, task-suggestion workspace matching, and custom-skill environment listings only resolve non-eval environments
- PR-task environment auto-resolution and router context builders ignore eval environments when selecting a workspace

Direct ID lookups still work for eval environments. That allows an internal flow to create an eval environment, keep it out of normal listings, and still launch a task against that exact environment by passing its `environmentId`.

The environment create and MCP `PATCH` handlers treat `isEval` as reserved internal metadata. User-facing callers cannot set or toggle it through those API surfaces.

### `environment_repository_mappings` Table

Many-to-many join table linking environments to repositories for access control and metadata.

| Column          | Type        | Description                             |
| --------------- | ----------- | --------------------------------------- |
| `id`            | `uuid`      | Primary key                             |
| `environmentId` | `uuid`      | FK to `environments.id`, cascade delete |
| `repositoryId`  | `uuid`      | FK to `repositories.id`, cascade delete |
| `createdAt`     | `timestamp` | Row creation timestamp                  |

**Constraints:**

- Unique constraint on `(environmentId, repositoryId)` — each repository can only be mapped once per environment

### `environment_snapshots` Table

Provider-keyed environment snapshot state.

| Column              | Type        | Description                                                                    |
| ------------------- | ----------- | ------------------------------------------------------------------------------ |
| `id`                | `uuid`      | Primary key                                                                    |
| `environmentId`     | `uuid`      | FK to `environments.id`, cascade delete                                        |
| `provider`          | `text`      | Compute provider (`modal`, `e2b`; historical rows may carry `sandbox`)         |
| `snapshotId`        | `text`      | Provider-specific snapshot ID                                                  |
| `snapshotCreatedAt` | `timestamp` | When the provider snapshot was created                                         |
| `snapshotExpiresAt` | `timestamp` | When the provider snapshot expires                                             |
| `snapshotStatus`    | `text`      | `'pending' \| 'ready' \| 'expired' \| 'failed'`                                |
| `deletedAt`         | `timestamp` | Soft-delete marker for snapshots invalidated by environment definition changes |
| `createdAt`         | `timestamp` | Row creation timestamp                                                         |
| `updatedAt`         | `timestamp` | Row update timestamp                                                           |

**Constraints:**

- Partial unique index on `(environmentId, provider)` where `deletedAt IS NULL`

### Environment Snapshot Invalidation

Environment snapshots are active only while their `deletedAt` column is null.
Environment definition changes call `updateEnvironmentDefinition()`, which
locks the owning environment row, skips no-op saves, and soft-deletes active
`environment_snapshots` rows for that environment.

Snapshot completion uses `attachEnvironmentSnapshot()` rather than a blind
upsert. That helper also serializes on the owning environment row so attach and
invalidation transitions cannot half-apply across `environment_snapshots` rows:

- manual snapshot creation first writes a pending active row and carries that
  row id plus claim timestamp on the `SnapshotEnvironment` payload; completion
  updates only that same pending claim
- scheduled refresh jobs carry the active snapshot row id plus source snapshot
  identity they were queued from; completion updates only that still-active row
- legacy attachment sources (`legacy_sandbox_row`, `legacy_active_snapshot_row`)
  predate the `environment_snapshots` table and the removed Vercel Sandbox
  provider; they are still parsed for old payloads but always complete as
  no-ops and are never produced anymore

If an environment definition changes while a snapshot job is in flight, the
soft-deleted row makes the later completion an
idempotent no-op instead of reattaching stale filesystem state.

### `sandbox_oidc_targets` Table

Tracks externally refreshed OIDC token files written into active
environment-backed sandboxes.

| Column                | Type        | Description                                                 |
| --------------------- | ----------- | ----------------------------------------------------------- |
| `id`                  | `uuid`      | Primary key                                                 |
| `environment_id`      | `uuid`      | FK to `environments.id`, cascade delete                     |
| `cloud_job_id`        | `integer`   | Active task owner                                           |
| `compute_provider`    | `text`      | Provider label (e.g. `modal`, `e2b`, `daytona`)             |
| `compute_provider_id` | `text`      | Provider machine/instance ID                                |
| `target_kind`         | `text`      | `aws` or `custom`                                           |
| `audience`            | `text`      | Audience bound into the minted token                        |
| `token_file`          | `text`      | Absolute sandbox-local path written by Roomote              |
| `aws_role_arn`        | `text`      | Optional AWS helper metadata copied from environment config |
| `aws_region`          | `text`      | Optional AWS helper metadata copied from environment config |
| `refresh_at`          | `timestamp` | Next scheduled external refresh                             |
| `expires_at`          | `timestamp` | Current token expiry                                        |
| `created_at`          | `timestamp` | Row creation timestamp                                      |
| `updated_at`          | `timestamp` | Last refresh / ownership update timestamp                   |

Each row belongs to an active cloud job. Roomote keeps the sandbox-local token
file path stable while BullMQ refresh jobs rewrite the token in place.

## EnvironmentConfig Schema

The `config` JSONB column stores a validated `EnvironmentConfig` object defined in `packages/types/src/environment-config.ts`.

### Top-Level Fields

```typescript
{
  name: string;                        // Environment display name
  description?: string;                // Optional description
  initialUrl?: string;                 // Optional default URL for the first shared preview link
  agentInstructions?: string;          // Delivered via startup environment instructions (max 10,000 chars)
  repositories: EnvironmentRepositoryConfig[];  // At least 1 required
  tool_versions?: Record<string, string>;  // Shared workspace-root mise tool versions
  env?: Record<string, string>;        // Environment variables
  services?: ServiceConfig[];          // Services to start (postgres17, redis7, etc.)
  oidc?: EnvironmentOidcConfig;        // Optional sandbox OIDC targets
  ports?: NamedPort[];                 // Human-facing named preview ports
  previews_enabled?: boolean;          // Optional live preview opt-out while preserving ports
  mcpServers?: EnvironmentMcpServers;  // Custom MCP server configs
  skills?: Record<string, 'all' | string[]>;  // Installable skills per source
  manualSkills?: EnvironmentManualSkill[];    // Inline manual skills rendered into .agents/skills
  auth_bypass_header?: boolean | string;      // Auth bypass setting
  auth_bypass_header_name?: string;           // Custom bypass header name
}
```

Environment `skills` and `manualSkills` are installed during workspace setup
into the sandbox home under `.agents/skills/`. Task startup then refreshes the
selected packaged Roomote skill catalog in place, re-materializes the current
manual and repo-local skill entries for the run, and keeps the packaged skills
authoritative on name collisions without pruning unrelated existing runtime
skills.

Environment-backed workspaces do not reserve a separate browser-only port. Human-facing preview access comes from `config.ports`.

The admin-facing `/settings/previews` page sits above that manifest model. It
reads the runtime preview environment variables, applies the deployment-wide
`deployment_settings.metadata.previews_enabled` control, and lets admins
toggle `config.previews_enabled` per environment without deleting the saved
port list.

When `tool_versions` is declared at the environment root, Roomote writes a
shared `.tool-versions` file at the workspace root and runs `mise install`
there before task execution continues. This primarily supports
workspace-root commands and provides a broad fallback for repos that do not
already pin a given tool locally.

### `EnvironmentOidcConfig`

Sandbox OIDC is optional and mints deployment + environment-scoped claims. Roomote
issues the tokens, writes them into the sandbox filesystem, and refreshes them
externally while the sandbox stays alive.

```yaml
oidc:
  aws:
    audience: sts.amazonaws.com
    token_file: /home/roomote/.roomote/oidc/aws/token
    region: us-east-1
    role_arn: arn:aws:iam::123456789012:role/example
  custom:
    - audience: custom-audience-1
      token_file: /home/roomote/.roomote/oidc/custom-1/token
    - audience: custom-audience-2
      token_file: /home/roomote/.roomote/oidc/custom-2/token
```

Rules and defaults:

- `oidc.aws.audience` defaults to `sts.amazonaws.com`
- `oidc.aws.token_file` defaults to `/home/roomote/.roomote/oidc/aws/token`
- `oidc.aws.role_arn` is required when `aws` is configured
- `oidc.aws.region` is optional
- every `custom[]` target requires both `audience` and `token_file`
- all `token_file` values must be absolute paths
- the same `token_file` cannot be reused across `aws` and `custom[]` targets

When `oidc.aws` is present, worker workspace setup also exports the standard AWS
web-identity env vars before repository commands run:

- `AWS_WEB_IDENTITY_TOKEN_FILE`
- `AWS_ROLE_ARN`
- `AWS_REGION` and `AWS_DEFAULT_REGION` when `region` is configured

That keeps default AWS SDK and CLI credential resolution working without
custom bootstrap steps inside the sandbox workload.

The OIDC issuer is the API-facing Roomote URL. `apps/api` serves the public
discovery document at `/.well-known/openid-configuration` and the JWKS at the
URI advertised by that document, currently `/api/oidc/jwks`. Treat the issuer
URL as stable once configured with a customer identity provider because external
trust policies match it exactly.

Sandbox OIDC subjects follow `deployment:default:env:<environmentId>`, and the
token also carries `deployment_id` and `environment_id` custom claims. For AWS
trust policies:

- use `StringEquals` on the custom claims when you want one exact deployment and
  environment
- use `StringLike` on `sub` with `deployment:default:env:*` when the role should trust
  every environment in the deployment

### `EnvironmentRepositoryConfig`

```typescript
{
  repository: string;           // GitHub repo in "owner/name" format
  branch?: string;              // Branch to checkout (default: repo default branch)
  tool_versions?: Record<string, string>;  // repo-local fallback tool versions
  commands?: Command[];         // Startup commands (install, build, etc.)
}
```

When `tool_versions` is declared on a repository entry, Roomote keeps the
repo's checked-in `.tool-versions` authoritative and only injects fallback
tools that the repo has not already pinned. Those fallback entries are
materialized through a generated `mise.local.toml`, so repo-configured tool
versions fill gaps without overwriting repo-owned pins.

Workspace repository preparation uses a full `git clone` followed by the
existing fetch/reset sync path.

Environment create, update, YAML validation, setup-agent repository
selection, and API environment-definition task launch paths require all
configured repositories that resolve to active linked Roomote repository records
to belong to one GitHub App installation. This keeps
environment-backed multi-repo workspaces on the same installation-scoped GitHub
token path used by the worker. Unknown or inaccessible repository names are
still reported through the existing missing repository or access checks, but
known repositories from different installations produce a hard validation error
before the environment is persisted or a setup task is launched.

The create/edit environment agent panel shares the task runtime's structured
input UI. When the setup agent emits `request_user_input`, option prompts render
as dedicated answer cards in the panel and temporarily hide the free-form chat
box; free-text prompts continue through the chat box but submit back to the
pending request instead of becoming an ordinary follow-up message.

### `Command`

```typescript
{
  name: string;                 // Command label
  run: string;                  // Shell command to execute
  env?: Record<string, string>; // Additional env vars
  working_dir?: string;         // Working directory (alias: cwd)
  cwd?: string;
  timeout?: number;             // Timeout in seconds (default: 600)
  continue_on_error?: boolean;  // Whether to continue if command fails
  detached?: boolean;           // Run in background under PM2 supervision for repository commands
  logfile?: string;             // Log file path for detached mode
}
```

Environment repository commands with `detached: true` are started as
foreground `bash -lc` commands under PM2. Roomote gives each managed process a
stable `roomote-*` process name derived from the repo path, command name, and
command line, writes output to the configured `logfile`, deletes/restarts that
PM2 entry when setup commands are rerun, and prunes stale `roomote-*`
processes from the same repo before relaunching changed commands. PM2 keeps
the app process online if it later exits or is killed by the OOM killer. A
detached command that flaps during the initial startup window fails setup and
is removed from PM2 so bad commands do not keep retrying silently. The shipped
worker base image installs PM2 for fresh sandboxes at a pinned in-image path.
If that bundled PM2 binary is missing, detached setup fails closed instead of
installing PM2 at runtime.

Task snapshot resume jobs treat environment repository commands as
best-effort. The source snapshot already captured a previously working
environment, so `TaskPayloadKind.SnapshotResume` forces repository commands to
continue on failure, emits a user-visible startup warning, and keeps detailed
debug logs for the failed command. Fresh environment setup and environment
snapshot creation still respect each command's configured `continue_on_error`
value and fail when a strict command fails.

### `ServiceConfig`

Services are either simple string names or objects with custom ports:

```typescript
type ServiceConfig =
  | 'redis6'
  | 'redis7'
  | 'postgres15'
  | 'postgres16'
  | 'postgres17'
  | 'mysql8'
  | 'mariadb10'
  | 'clickhouse'
  | 'aws'
  | { name: ServiceName; port?: number };
```

Default ports:

- `postgres*`: 5432
- `redis*`: 6379
- `mysql8`, `mariadb10`: 3306
- `clickhouse`: 9000

`initialUrl` still defaults to `about:blank`. When a task has a primary preview port or a single preview URL, Roomote uses `initialUrl` as the default path when building the shareable preview link and the task-side preview panel. `initialUrl` accepts absolute URLs and `about:blank`. Roomote always provisions the `SANDBOX_SERVER` system surface internally.

### `NamedPort`

Environments can declare human-facing preview ports again with `config.ports`.
Each entry becomes a stable preview-proxy hostname on the cloud job, can be
selected from the task-side `Live Preview` panel, and also gets an `Open`
action that launches the preview URL in the user's own browser.

```typescript
{
  name: string;                  // Storage key and preview slug source
  port: number;                  // Sandbox app port (1024-65535)
  primary?: boolean;             // Preferred default preview when several exist
  unauthenticated?: boolean;     // Skip preview-proxy auth for this port
  proxied?: boolean;             // Route through preview-proxy auth proxy (default true)
  initial_path?: string;         // Default browser path for task-side preview links
  wildcard_prefix?: boolean;     // Allow nested preview-proxy prefixes
  subdomain?: string;            // Explicit preview-proxy subdomain prefix
  auth_bypass_paths?: string[];  // Paths that can skip preview-proxy auth
}
```

`primary` is optional. When no port is explicitly primary, Roomote treats the
first configured port as the default preview target.

Named preview ports are for human-facing app access only. The agent runtime
still uses loopback for screenshots and automation, so restoring external
preview URLs does not change how `agent-browser` reaches the app inside the
sandbox.

When a task claims or boots a machine for an environment with named preview
ports, the worker also injects `ROOMOTE_<NAME>_HOST` env vars that point at the
stable preview-proxy hostnames. Those env vars are intended for software inside
the sandbox that needs a public callback or self-reference, not for replacing
the agent's loopback access to the app.
The worker launcher derives `PREVIEW_PROXY_BASE_URL` from the current app
environment when it is not configured explicitly, so these env vars still
resolve to `preview.newmote.run` or `preview.roomote.run` instead of leaking
raw machine hosts into agent-facing environment details.

Roomote still reserves these internal names for system-managed surfaces and
they cannot be reused in `config.ports`:

- `SANDBOX_SERVER`
- `EDITOR`

**Validation:**

- `name` must be present and `repositories` must contain at least one entry
- `initialUrl` accepts only an absolute URL or `about:blank`
- `ports` may contain at most 10 entries, with at most 2 non-proxied ports and at most 9 proxied ports
- `ports[].name` must be unique and cannot reuse `SANDBOX_SERVER` or `EDITOR`
- Only one `ports[]` entry may set `primary: true`
- `ports[].subdomain`, when provided, must be unique across preview ports
- `auth_bypass_header_name` must be a valid HTTP header token when provided

## Environment Creation and Setup Flow

### 1. Create Environment (Web App)

**Endpoint:** `trpc.environments.create`
**Handler:** `apps/web/src/trpc/commands/environments/index.ts#createEnvironmentCommand`

Steps:

1. Validate `EnvironmentConfig` with Zod schema
2. Check for name uniqueness within org
3. Insert row into `environments` table
4. Create `environment_repository_mappings` for repositories from config that already exist in the org repository table
5. Return environment ID

**Async Validation:**

Before saving, the web UI can call `trpc.environments.validateConfig` to check:

- Repository accessibility via GitHub API (hard error if inaccessible)
- Branch existence (soft warning if not found)

### 2. Launch Job on a Fresh Worker (Controller)

Environment-backed tasks now launch on a fresh provider instance per job.
The controller still prefers environment snapshots when they are available, but
each job owns its own launch and there is no warm worker pool.

**Primary files:**

- `apps/controller/src/BaseController.ts`
- `apps/controller/src/RoomoteController.ts`
- `apps/controller/src/compute-providers/spawn-modal-worker.ts` (plus the
  `spawn-docker-worker.ts`, `spawn-daytona-worker.ts`, and
  `spawn-e2b-worker.ts` siblings)

**Launch Steps:**

1. Dequeue the `cloud_jobs` row and create a job-scoped auth token.
2. Load the selected environment config plus any provider-specific snapshot
   state.
3. Resolve the launch mode:
   - `task_snapshot` for task resumes
   - `environment_snapshot` when a provider snapshot is available for a normal task
   - `fresh` otherwise
4. Create or resume the provider instance.
5. If `config.oidc` is present, write the initial token files after the machine
   exists and before the detached worker command starts.
6. Persist machine metadata on the `cloud_jobs` row.
7. Launch `worker run`, `worker resume`, or `worker snapshot` on that machine.

## Snapshot Management

Snapshots are provider-bound filesystem state captures. They allow environments and tasks to resume from a saved state instead of re-cloning repos and re-running setup commands.

### Environment Snapshots

**Purpose:** Cache the fully-prepared environment (repos cloned, deps installed, services started) for faster task dispatch.

Environment snapshots are treated as a **cached base launch**, not a true
exact-state resume. When Roomote boots a sandbox from an environment snapshot,
it restores the cached environment state first and then refreshes the shipped
worker/runtime before the task starts.

**Creation Flow:**

1. User clicks "Create Snapshot" in the web UI
2. Web app calls `trpc.snapshots.createEnvironment({ environmentId, provider })`
3. Handler enqueues a `TaskPayloadKind.SnapshotEnvironment` job
4. Worker provisions the environment from the provider's fresh base-image path rather than inheriting the previous environment snapshot
5. Worker calls the active provider's snapshot API to capture filesystem state
6. BullMQ worker writes `snapshotId`, `snapshotCreatedAt`, `snapshotExpiresAt` to `environment_snapshots`
7. `snapshotStatus` transitions from `'pending'` → `'ready'`

**File:** `apps/web/src/trpc/commands/snapshots/index.ts#createEnvironmentSnapshotCommand`

**Expiry:**

- Snapshots use Roomote expiry bookkeeping (`SANDBOX_SNAPSHOT_EXPIRY_MS`, currently 7 days)
- Expired snapshots have `snapshotStatus: 'expired'`

**Clearing a Snapshot:**

Call `trpc.snapshots.clearEnvironment({ environmentId, provider })` to clear only that provider's environment snapshot and force fresh provisioning.

### Task Snapshots

**Purpose:** Pause a running task and resume it later from the exact same state.

Task snapshots keep **exact resume** semantics. Unlike environment snapshots,
Roomote does not refresh the shipped worker/runtime after restoring a task
snapshot.

**Creation Flow:**

1. User clicks "Save Snapshot" on a running task
2. Web app calls `trpc.snapshots.createCloudJob({ cloudJobId })`
3. Handler enqueues a snapshot request via BullMQ
4. BullMQ worker calls the active provider's snapshot API on the running worker
5. `snapshotId` is written to `cloudJobs.snapshotId`
6. Snapshot metadata is written back to `cloudJobs` (and to `environments` for environment snapshots)

**Resume Flow:**

1. User clicks "Resume Snapshot" on a completed/paused task
2. Web app calls `trpc.snapshots.restoreCloudJob({ sourceSnapshotId, sourceCloudJobId })`
3. Handler enqueues a new `TaskPayloadKind.SnapshotResume` job
4. Worker creates a new instance from the snapshot on the same provider that created it
5. Task execution resumes with the previous filesystem state intact

**File:** `apps/web/src/trpc/commands/snapshots/index.ts`

## Agent Instructions

The `agentInstructions` field in `EnvironmentConfig` is included in the startup `<environment-instructions>` block delivered through the harness system-prompt path when a task runs in that environment.

**Use Cases:**

- "This is a monorepo. The frontend is in `packages/web`, the API is in `packages/api`."
- "Always run `pnpm test` after making changes and fix any issues before considering the task complete."
- "When UI changes need screenshots, use the Capture visual proof task tool."

**Injection Points:** `apps/worker/src/run-task/run-task.ts` + `apps/worker/src/run-task/sandbox-instruction.ts`

The runtime prompt assembly includes:

1. Sandbox isolation context
2. Full environment config (sanitized — no secrets)
3. Resolved preview URLs (`ROOMOTE_*_HOST` env vars)
4. User-supplied `agentInstructions` placed before sandbox context inside the startup environment-instructions block

This prompt is sent to the AI agent alongside the user's task description.

### Sandbox OIDC Lifecycle

When an environment declares `config.oidc`, Roomote treats the token files as
provider-managed machine state:

1. **Task launch:** after the provider machine is ready but before the detached
   worker process starts, Roomote writes the token files onto the machine and
   creates `sandbox_oidc_targets` rows keyed by the active `cloudJobId`.
2. **External refresh:** BullMQ periodically rewrites due token files in place
   without requiring the worker process to hold minting credentials.
3. **Terminal cleanup:** when a cloud job finishes in a non-idle terminal
   state, Roomote deletes the tracked token files and removes their backing
   rows.

## Roomote-Managed Surfaces

Environment config exposes user-defined app preview ports through `config.ports`.
Roomote also provisions runtime-managed surfaces such as `SANDBOX_SERVER`.
Those system-managed surfaces are not configured through user-defined
`config.ports`.

### Auth Bypass

When `auth_bypass_header` is allowed (default: auto when needed), job launch
generates a bypass value only when the runtime exposes an authenticated
proxied preview port that needs preview-proxy traversal.
Setting `auth_bypass_header: false` disables generation even for otherwise
eligible surfaces.

**Header Name:** `x-bypass-roomote-auth` (or custom via `auth_bypass_header_name`)
**Header Value:** UUID-generated value by default (or the configured literal string)

The worker runtime then propagates that value into
`ROOMOTE_AUTH_BYPASS_VALUE` and `ROOMOTE_AUTH_BYPASS_HEADER_NAME` via
[`injectEnvVars()`](../../apps/worker/src/commands/utils/env-vars.ts#L262-L277).
That same pair is consumed by the built-in browser automation wrapper
installed in the worker image, so preview cookies can be seeded automatically
during fresh launches and resumed tasks.

## Compute Provider Mapping

Environments are compute-provider-agnostic — they work with any provider that implements the `ComputeProviderClient` interface.

### Supported Providers

| Provider  | File                                                           | Snapshot Support |
| --------- | -------------------------------------------------------------- | ---------------- |
| `docker`  | `apps/controller/src/compute-providers/spawn-docker-worker.ts` | No               |
| `modal`   | `packages/compute-providers/src/adapters/modal.ts`             | ✅ Yes           |
| `daytona` | `packages/compute-providers/src/adapters/daytona.ts`           | No               |
| `e2b`     | `packages/compute-providers/src/adapters/e2b.ts`               | ✅ Yes           |

When a launch surface omits the compute provider, Roomote falls back to the
deployment default from `resolveDefaultComputeProvider()`: the provider chosen
in the `/setup` compute step
(`deployment_settings.runtime_compute_config.defaultProvider`) when present,
otherwise the server-side `DEFAULT_COMPUTE_PROVIDER` env var. The
authenticated Home page uses the same resolution to seed its picker, and
non-UI paths such as Slack, Linear, GitHub follow-ups, and other enqueue-only
producers inherit that same default through `enqueueCloudTask()`.

Docker is a fresh-run provider only. In single-host Compose deployments,
`docker-compose.compute-docker.yml` makes Docker workers reachable by joining
them to the dedicated `roomote_worker` network (which reaches the API,
controller, and preview proxy but not Postgres/Redis/MinIO) and routing their
`SANDBOX_SERVER` surface through preview proxy. Environment snapshots remain provider-bound to
snapshot-capable providers (`modal` and `e2b`).

**Docker**, **Modal**, **Daytona**, and **E2B** are the current built-in
providers. Docker is the local and single-host self-host default for immediate
tasks and does not support environment snapshots. Modal and E2B are the
snapshot-capable hosted providers; Daytona is hosted but fresh-run only. The
org feature flag now only
controls whether authenticated users can explicitly choose a different provider
than the default.

### Provider Capabilities

```typescript
interface ComputeProviderCapabilities {
  supportsCreateInstance: boolean;
  supportsDestroyInstance: boolean;
  supportsCommandExecution: boolean;
  supportsCommandOutputStreaming: boolean;
  supportsSnapshots: boolean; // Modal and E2B
  supportsResume: boolean; // Modal and E2B
  supportsFileWrite: boolean;
}
```

Environment snapshots are provider-specific. The environments UI exposes
snapshot controls for every supported provider and sends explicit provider
overrides to the snapshot commands; `DEFAULT_COMPUTE_PROVIDER` only applies
when a producer omits the provider entirely.

## Key Files Reference

### Database Schema

- `packages/db/src/schema.ts` — `environments`, `environment_snapshots`, `environment_repository_mappings`, `sandbox_oidc_targets` tables

### Type Definitions

- `packages/types/src/environment-config.ts` — `EnvironmentConfig`, `NamedPort`, `ServiceConfig`, `Command`, `EnvironmentRepositoryConfig` schemas

### SDK / API

- `packages/sdk/src/server/routers/environments.ts` — tRPC router for environment queries
- `packages/sdk/src/server/lib/environments/` — `listEnvironments` and `findEnvironment` backend logic
- `packages/sdk/src/environments.ts` — Public SDK client exports

### Web App

- `apps/web/src/trpc/commands/environments/index.ts` — Environment CRUD commands (`createEnvironment`, `updateEnvironment`, `deleteEnvironment`, `validateConfig`)
- `apps/web/src/trpc/commands/snapshots/index.ts` — Snapshot command handlers (`createEnvironmentSnapshotCommand`, `clearEnvironmentSnapshotCommand`, `createCloudJobSnapshotCommand`, `restoreCloudJobSnapshotCommand`), exposed via `trpc.snapshots.{createEnvironment,clearEnvironment,createCloudJob,restoreCloudJob}`
- `apps/web/src/trpc/commands/setup/index.ts` — Setup wizard batch environment creation

### Worker

- `apps/worker/src/commands/setup/environment.ts` — Environment variable setup for worker process
- `apps/worker/src/run-task/sandbox-instruction.ts` — Builds agent prompt with environment config and preview URLs

### Controller

- `apps/controller/src/RoomoteController.ts` — Provider-aware job launch routing
- `apps/controller/src/compute-providers/spawn-modal-worker.ts` — Fresh Modal launch (Docker/Daytona/E2B siblings live alongside)

### Compute Providers

- `packages/compute-providers/src/adapters/modal.ts` — Modal client with snapshot support (`createSnapshot`, `resumeFromSnapshot`)
- `packages/compute-providers/src/adapters/e2b.ts` — E2B client with snapshot support

### Snapshot Processing

- `packages/sdk/src/server/lib/cloud-jobs/enqueue-snapshot.ts` — BullMQ queue for snapshot jobs
- `apps/bullmq/src/jobs/snapshot.ts` — BullMQ worker that processes snapshot creation

## Related Documentation

- [Cloud Job Execution](../architecture/cloud-job-execution.md) — End-to-end task execution flow
- [Preview Proxy](../features/preview-proxy.md) — URL routing and auth-proxy architecture
- [Database Schema](../architecture/database.md) — Full schema reference
- [SDK / tRPC](../api/trpc-sdk.md) — tRPC API reference
