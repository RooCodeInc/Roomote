---
title: Cloud Job Execution Architecture
status: active
last_reviewed: 2026-07-03
owner: engineering
summary: Cloud job execution system covering direct cloud-job submission, controller dispatch, worker runtime, sandbox OIDC refresh, snapshots, and completion.
---

# Cloud Job Execution Architecture

This document describes the current work execution system across cloud-job submission, controller dispatch, worker runtime, snapshots, and completion.

It is intended for engineers and coding agents who need to debug or extend job execution behavior.

## Child Surface Inventory

| Sub-surface                                           | Kind         | Coverage   | Owning doc                                                 | Notes                                                                                        |
| ----------------------------------------------------- | ------------ | ---------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/controller/src/`                                | architecture | documented | [Controller Runtime](#controller-runtime)                  | Queue dequeue loop, provider dispatch, and orphan recovery.                                  |
| `apps/worker/src/`                                    | architecture | documented | [Worker Execution Lifecycle](#worker-execution-lifecycle)  | Workspace setup, harness startup, task execution, snapshot/resume, and task sleep deadlines. |
| `apps/bullmq/src/`                                    | operations   | documented | [Snapshot and Resume Model](#snapshot-and-resume-model)    | Snapshot jobs, resume coordination, and scheduled background task hooks.                     |
| `packages/cloud-agents/src/server/cloud-job-queue.ts` | architecture | documented | [Job Creation and Queueing](#job-creation-and-queueing)    | Enqueue path, queue scope, and compute-provider selection.                                   |
| `packages/sdk/src/server/lib/cloud-jobs/`             | api          | documented | [SDK tRPC Router (Backend-to-Backend)](../api/trpc-sdk.md) | Worker-facing dequeue/update/done RPC helpers used once the worker claims the job.           |

## System Overview

Roomote launches work by creating `cloud_jobs` and linked `tasks` records
immediately, then pushing the cloud job ID onto the Redis-backed controller
queue. Callers receive stable task links as soon as launch validation and
persistence succeed. Execution has four major stages:

1. Cloud-job/task creation
2. Controller Redis dequeue + machine dispatch
3. Worker setup + harness execution
4. Completion, notifications, and optional snapshot/resume

Core components:

| Component         | Primary paths                                                                               | Responsibility                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Web/API producers | `apps/web/src/trpc/commands/cloud-jobs/index.ts`, `apps/api/src/handlers/*`                 | Validate launch requests and call the shared cloud-job enqueue helper              |
| Queue helper      | `packages/cloud-agents/src/server/cloud-job-queue.ts`                                       | Create `cloud_jobs`/`tasks`, run pre-enqueue hooks, and push Redis queue entries   |
| Controller        | `apps/controller/src/*`                                                                     | Dequeue cloud jobs from Redis, recover orphaned jobs, and launch provider machines |
| Worker runtime    | `apps/worker/scripts/worker.ts`, `apps/worker/src/commands/*`, `apps/worker/src/run-task/*` | Setup repos/services, run harness, persist progress                                |
| SDK server        | `packages/sdk/src/server/routers/cloud-jobs.ts`, `packages/sdk/src/server/lib/cloud-jobs/*` | Worker-facing RPC for dequeue/update/done/messages/snapshot                        |
| Snapshot worker   | `apps/bullmq/src/jobs/snapshot.ts`                                                          | Create snapshots and finalize snapshot metadata                                    |
| Data model        | `packages/db/src/schema.ts`                                                                 | Source of truth for cloud job state                                                |

## End-to-End Flow

```text
Producer (web/api/webhook)
  -> enqueueCloudTask()
  -> create cloud_jobs/tasks rows
  -> push { id, scope } to Redis queue

Controller loop
  -> dequeueCloudTask()
  -> load cloud_jobs row
  -> mark cloud_jobs.status=dequeued
  -> create job token
  -> spawn or resume provider machine

Worker process
  -> sdk.cloudJobs.dequeue()/resume() => status=processing + startedAt
  -> fresh dequeue generates prompt + harnessInstructions
  -> resume reuses persisted harnessInstructions and prior session
  -> setup workspace/services
  -> status: preparing -> spawning -> connecting -> running
  -> persist messages/logs/taskPhase
  -> done(completed|failed|canceled|idle)

finishCloudJob()
  -> release lock
  -> final status + timestamps
  -> notifications / cleanup
  -> optional snapshot / resume chain
```

## Cloud Job Creation and Enqueueing

Runtime producers call `enqueueCloudTask()` in
`packages/cloud-agents/src/server/cloud-job-queue.ts`. The helper validates the
launch request, creates or reuses the linked `tasks` row, persists the
`cloud_jobs` execution attempt, optionally runs a producer-supplied
`beforeEnqueue` hook, and pushes the job onto the Redis controller queue.

Web task launches, `POST /api/mcp/tasks`, SDK `cloudJobs.enqueue`, integration
webhooks, automation work items, and snapshot-resume handoffs all receive direct
task links from the persisted `cloud_jobs` row. Web and API surfaces return
`{ success: true, cloudJobId, taskId }`, while SDK `cloudJobs.enqueue` maps the
result to `{ id, taskId }`. The web tRPC `queue` router, `/queue` dashboard
routes, `queue_items` table, Chore Queue feature flag, and controller
claim-time queue pipeline have been removed.

`cloud_jobs` is the execution history and worker bootstrap state for all new
work. Producers that need to link external state after the task ID exists, such
as automation work-item execution launches, should use `beforeEnqueue` so a
failed linkage cancels the newly created cloud job before it reaches the
controller queue.

## Cloud Job Creation

Primary create path: `enqueueCloudTask()` in `packages/cloud-agents/src/server/cloud-job-queue.ts`.

Key behavior:

- Validates user, task, repository, and environment constraints before insert.
- Auto-resolves `environmentId` for PR task types when missing.
- Defaults new launches to `opencode-server` through the shared launch-default constant. New cloud job rows should not contain any other coding harness.
- Caller-provided model overrides reach the harness through the shared [`resolveEvalHarnessSelection`](../../packages/types/src/eval-harness-selection.ts) helper on two surfaces: the Slack `!eval` launcher and the programmatic launch API (`POST /api/mcp/tasks` -> [`launchTask`](../../apps/api/src/handlers/tasks/launchTask.ts)). Both translate a valid OpenCode catalog `model` into `payload.harnessModelOverrides['opencode-server']`; non-catalog model names, unknown harness values, and reasoning-effort overrides are rejected instead of being silently routed to another runtime.
- The internal Slack `!eval` launcher (gated by `SlackEvalLauncher`) is the one launch surface that maps caller-provided harness/model overrides into the launch. The shared [`resolveEvalHarnessSelection`](../../packages/types/src/eval-harness-selection.ts) helper resolves `--harness` / `--model` into an optional `task.harness` pin and `payload.harnessModelOverrides`; both the Slack command parser (to return usage errors) and [`startSlackAppMentionTask`](../../packages/slack/src/start-slack-app-mention.ts) (to build the payload) call it. `--harness` may only select `opencode-server`. When omitted, a recognized OpenCode catalog model (`getOpenCodeRequestedModelCatalogEntry`) infers and pins `task.harness = 'opencode-server'` and sets `harnessModelOverrides['opencode-server']`. `resolveEffectiveHarnessModelState` resolves the persisted `tasks.model` from the OpenCode override so eval launches record their actual model rather than the default.
- `SnapshotResume` jobs inherit the source job's persisted `payload.harnessModelOverrides` instead of re-evaluating deployment feature-flag state, so resumed harness runs keep the same runtime model as the original launch.
- Persists an initial `requestedWorkKind` decision on every new `cloud_jobs` row. StandardTask launches honor explicit bootstrap overrides first, Slack/Linear/Web/API launches fall back to a dedicated prompt classifier when needed, and `SnapshotResume` jobs inherit the source job's persisted value.
- Persists a task-attribution snapshot onto each new `cloud_jobs` row and any newly created `tasks` row. Enqueue stays conservative by default: automation and setup flows can stamp an explicit automatic override, user-facing StandardTask launches backfill as web-created work, and `SnapshotResume` only upgrades to human attribution when the initiating surface carries a concrete Roomote user identity. For resumed follow-ups, attribution prefers `payload.resumePromptUserId` when present so the persisted creator follows the current resumer even if the job owner stays tied to the source task for runtime continuity; Slack and Linear resumes still preserve those source kinds when their routing metadata is present.
- Creates or reuses `tasks` records (`taskId`) and links the execution attempt to org, user, and task. Newly created task rows persist the effective OpenCode runtime model from any validated override so task history and admin surfaces match the harness configuration that actually runs.
- Supports an internal `beforeEnqueue` hook for producers that must persist external launch linkage after the cloud job row exists but before the job reaches the controller queue. If that hook throws, or if the Redis queue push fails afterward, enqueue cancels the new cloud job and reports the failure without leaving a recoverable pending job behind.
- Resolves a launch class (`human`, `automation`, or `maintenance`) only to choose the persisted `keepaliveMs` runtime policy for new cloud jobs. Launch classes are not a chore queue concept, are not persisted as their own cloud-job field, and are not exposed to authorship rules; authorship should match durable task attribution fields such as `sourceKinds`, `taskTypes`, repository, and `humanCreated`.
- Resolves the job's compute provider from `CloudTask.computeProvider`, falling back to `DEFAULT_COMPUTE_PROVIDER` when the caller omits it. The local-first default is `docker`, which makes local and single-host self-host controllers run immediate tasks in job-scoped Docker worker containers instead of requiring hosted provider credentials. The web Home surface exposes an explicit compute-provider picker for all users; omitted-provider launches from Slack, Linear, GitHub, CLI resume paths, and other enqueue-only producers inherit the env default. `SnapshotResume` jobs inherit the source job's provider when one exists.
- Enqueues Redis queue entry `{ id, scope }` when called with default `enqueue: true`. Explicit direct-run jobs that are claimed by an already-running worker may pass `enqueue: false`.

Queue scope and dedup:

- PR review jobs use deterministic scope: `<repo>:<prNumber>`.
- All other jobs use random UUID scope (effectively no dedup).
- Enqueue evicts older queued entries with the same scope and marks them canceled.

## Redis Queue and Lock Semantics for Direct Paths

`CloudJobQueue` (same file as above):

- Queue key: `queue:cloud-jobs`.
- Dequeue is blocking (`BLPOP`) with short timeout loop.
- On dequeue, queue tries to acquire a Redis lock on the scope key (`SET NX EX`).
- Lock TTL is based on `TASK_TIMEOUT_MS` (currently 1 hour).
- `releaseCloudTask()` deletes the scope key and is called on completion/error/orphan recovery.

This scope lock protects Redis-queued cloud jobs from duplicate PR-review execution. Producers that need stricter dedupe should use deterministic job scope behavior or source-specific persistence guards before calling `enqueueCloudTask()`.

## Controller Runtime

Entry point: `apps/controller/src/index.ts`.

Controller selection:

- `RoomoteController` is the runtime entry point.
- One controller process handles mixed backends by branching on `cloud_jobs.vendor`.
- The default provider now comes from `DEFAULT_COMPUTE_PROVIDER`. Explicit user-facing provider overrides are always allowed on the web; omitted-provider jobs inherit the configured default.

Main loop: `BaseController.start()` in `apps/controller/src/BaseController.ts`.

Per-iteration behavior:

1. Write heartbeat to Redis (`controller:heartbeat`, TTL 600s).
2. Dequeue the next Redis cloud-job entry.
3. Load the `cloud_jobs` row and start spawn in background (bounded by concurrency).
4. If no Redis job is available, periodically scan for orphaned jobs.

Spawn behavior:

- `dequeueCloudJob()` sets status to `dequeued`, stamps `dequeuedAt`, and creates a job token.
- When the worker later claims the job through `sdk.cloudJobs.dequeue()` or `sdk.cloudJobs.resume()`, it stamps `startedAt` before prompt generation and other pre-run network work so health/recovery checks stop treating that launch as "not started" once the worker has actually taken ownership.
- That same bootstrap claim now persists the actual worker artifact metadata reported by the running worker (`workerReleaseTag`, `workerVersion`, `workerCommit`) onto the `cloud_jobs` row. This is the source of truth for which shipped worker runtime actually executed the job.
- `spawnWorker()` now always hands off to the provider-specific fresh or snapshot-backed launch path after dequeue. `resolveComputeProviderTarget()` maps a missing or unsupported `cloud_jobs.vendor` to the deployment default (ultimately `docker`).
- Fresh launches use bounded phase timeouts inside the provider spawn helpers instead of waiting indefinitely in one spawn attempt: worker bootstrap (archive upload plus `install-worker.sh`) is currently capped at 120 seconds, and the detached `worker resume` launch at 60 seconds, with best-effort status and command-plane diagnostics logged before teardown if the launch request times out.
- While a spawn promise is still pending, the controller emits a periodic warning every 30 seconds with the elapsed spawn time so a stuck launch does not go silent in logs.
- Machine launches that need environment OIDC material now emit dedicated `machine_oidc` cloud-job events around the token-file upload and install-command steps, including bounded pre-step instance-status snapshots, so resume-path flake can be distinguished between provider readiness, file-write, and command-exec failures without waiting for worker startup.
- Before the controller hands control to the worker runtime, it resolves a small observability payload and injects it into the worker environment:
  - org slug
  - environment ID when the job is environment-scoped
  - compute-provider label
  - compute-provider-specific runtime fingerprint plus a fingerprint kind

That payload is provider-agnostic at the schema level, but each compute provider is responsible for supplying the fingerprint value that best identifies the runtime image it launched. Today every provider reports a `base-image` fingerprint: Modal its base image reference, Docker its worker image, Daytona its snapshot name, and E2B its template ID.

Orphan recovery (`apps/controller/src/orphaned-cloud-jobs.ts`):

- Pending jobs older than 5 minutes (up to 24h) are considered stuck before dequeue.
- Dequeued jobs are only considered orphaned after the bounded sandbox launch envelope expires plus one orphan-scan interval (currently just over 9 minutes).
- Recovery releases scope lock and clears `dequeuedAt` before reprocessing.
- Recovery uses an in-memory dedupe window equal to the dequeue-orphan threshold so repeated stuck launches can be retried again promptly without thrashing every scan tick.
- When the controller actually starts a job from this database fallback path, it also emits an error-level Sentry signal so the missing Redis dequeue path creates an actionable issue instead of only a controller log line.

Health checks (`apps/api/src/handlers/health/controller.ts`) additionally detect:

- stale controller heartbeat (>300s),
- jobs stuck in queue (>60m without dequeue),
- jobs stuck after dequeue (>10m without `startedAt`).

## Provider Machine Launch

For environment-backed jobs, the controller launches or resumes one provider
machine per job:

- `fresh` for ordinary launches without a reusable environment snapshot
- `environment_snapshot` for ordinary launches that can reuse an environment snapshot
- `task_snapshot` for exact task resumes

Once provider provisioning reaches a usable machine, the controller
primes any configured OIDC token files onto that machine before it launches the
detached worker runtime.

## Worker Execution Lifecycle

Worker runtime entry: `apps/worker/scripts/worker.ts`.

Main commands:

- `worker run <id>`
- `worker run-direct <id>`
- `worker resume <id>`
- `worker snapshot --cloud-job-id ... --environment-id ... --sandbox-id ...`

Environment-backed jobs still begin with a blocking setup phase, but that phase can be split for flagged deployments. Repository checkout or preparation, service initialization, Python install, and environment-skill installation still complete before the task runtime starts because the worker consumes those outputs immediately. When the deployment-level `ParallelTaskEnvironmentSetup` flag is enabled and the job is a normal environment-backed task, the slower repository-scoped environment commands run in the background while the task begins after `setupCompletedAt` is stamped. The worker still waits for that background tail before final teardown so the setup subprocess is not abandoned mid-run, and the task receives a workspace-readiness notice telling it not to assume the environment is fully settled.

Slack `/setup` onboarding remains on the original fully blocking path even when the flag is enabled. Those runs still use `payload.webPath === '/setup'` as the existing readiness boundary because the onboarding UI and follow-up flows still treat setup completion as the signal that the environment is actually ready for the next step.

Execution wrapper: `executeJob()` in `apps/worker/src/commands/utils/execute-job.ts`.

Runtime flow:

1. Fetch job context via SDK (`dequeue` or `resume`).
   - Fresh dequeue claims the job, calls `generatePrompt()`, and persists the
     returned `prompt` plus `harnessInstructions` onto `cloud_jobs`.
   - Resume bootstrap does not call `generatePrompt()` again. It reuses the
     source job's persisted `harnessInstructions`, resumes the saved harness
     session, and starts with an empty startup prompt.
2. Inject env vars and preview URLs.

- Source-control auth is injected in two layers: the worker writes the current provider token state under `~/.roomote/`, and the shared `BASH_ENV` file re-sources provider token env scripts for each bash command. Long-lived harness processes no longer keep fixed source-control token env vars such as `GH_TOKEN`, `GITLAB_TOKEN`, `GITEA_TOKEN`, or `ADO_TOKEN` in their inherited env. GitHub still uses a file-backed `GH_TOKEN` plus the `gh` wrapper, and GitLab still uses short-lived repo-scoped credentials in the file-backed credential helper. Gitea and Azure DevOps now keep the deployment PAT only in worker memory and route git HTTPS traffic through a worker-local proxy with exact `insteadOf` rewrites for the allowed provider base URL, so the selected repositories still clone and push without writing a task-readable copy of `GITEA_TOKEN` or `ADO_TOKEN`. The worker registers the file-backed git credential helper for GitHub and GitLab, with `gh auth setup-git` skipped when no GitHub token is available. GitHub tasks resolve GitHub App credentials through the deployment env resolver, so process env values take precedence and encrypted `environment_variables` rows created by setup are the runtime fallback. They then resolve GitHub App installation tokens from the selected repository set, falling back to the newest deployment installation only when the task is not repository-scoped; they fail token creation when the selected repositories span multiple GitHub App installations. GitLab tasks use a deployment-provided `GITLAB_TOKEN` from encrypted environment variables or process env to mint selected repository credentials for `gitlab.com`; GitLab `all_repositories` workspaces still require explicit repository scope because project-scoped tokens are minted per repository. Gitea tasks use `GITEA_BASE_URL` plus `GITEA_TOKEN` from encrypted environment variables or process env, clone from synced repository `cloneUrl` values, and resolve `all_repositories` workspaces from synced Gitea repository rows filtered by `sourceControlProvider = 'gitea'`. Azure DevOps tasks use `ADO_ORGANIZATION` plus `ADO_TOKEN` from encrypted environment variables or process env, clone from synced repository `cloneUrl` values, and resolve `all_repositories` workspaces from synced Azure DevOps rows filtered by `sourceControlProvider = 'ado'`.
- Job/auth token signing private keys are server/controller-only material. Worker
  launch env may carry `AUTH_TOKEN`, `TRPC_URL`, `ROOMOTE_APP_URL`, and
  verifier-only public keys such as `JOB_AUTH_PUBLIC_KEY`, but it must not
  forward `JOB_AUTH_PRIVATE_KEY` into sandbox workers or user-facing command
  environments. If that private key is ever exposed to a worker process or task
  transcript, rotate the job/auth keypair because existing ES256 tokens cannot
  distinguish normal issuance from possession of the private key.

Config-shape rule for task and environment fixtures:

- When creating or changing a task/environment config object, seed payload, or
  CI control fixture, search the unconditional consumers first, especially
  `applyEnvironmentEnvVars` and the preview-proxy resolver in
  `apps/preview-proxy/src/services/resolver.ts`.
- Minimal configs still need every sibling field those consumers assume exists.
- If an apparently optional field is being omitted intentionally, note that
  intent explicitly in the fixture or config source instead of relying on an
  accidental partial object shape.

3. Set status `preparing`.
4. Prepare workspace/repos/services (`setup`).
   - Worker setup validates and repairs shared agent CLIs before the harness starts. The base image bakes OpenCode, Sentry, and `node-pty` into `/sandbox`, but older environment snapshots can predate a baked tool. `installAgentClis()` repairs missing or wrong-version OpenCode/Sentry binaries and refreshes `$HOME/.local/bin` wrappers so snapshot-backed launches do not fail later with `spawn <cli> ENOENT`.
   - Repository synchronization now retries the initial `git fetch --all --tags --prune --force` step up to 5 times with exponential backoff starting at 2 seconds before failing workspace preparation, so transient GitHub fetch errors do not immediately abort startup. Repository setup emits sub-step timings for GitHub repository resolution, cloning, fetch, checkout/reset, and tool-version installation so slow workspace preparation can be attributed without enabling full command echo. Explicit workspaces (`repository_set`, `repository`, and `environment`) still fail setup when a required repository cannot be prepared. True `all_repositories` workspaces now degrade gracefully when at least one repository prepares successfully: the worker skips the inaccessible repositories, emits a startup warning plus a durable `worker_runtime` failure event with task/workspace/repository metadata, and continues with the prepared shared root. If no repositories prepare successfully, startup still fails with the affected repositories listed.
   - Shared CLI dependencies needed by managed services are expected to be prebaked into the canonical worker image. The `aws` managed service now verifies the baked-in AWS CLI instead of attempting a runtime package install, so a missing `aws` binary indicates worker-image drift that should be fixed in `apps/worker/Dockerfile`.
5. Run harness through `runTask()`.
6. Finalize with `sdk.cloudJobs.done()` and callbacks.

Secure env-var request flow for web tasks and Slack-started setup tasks:

1. As soon as the running harness knows which deployment variables are required from repository analysis or runtime evidence, it calls the built-in Roomote MCP tool `request_environment_variables` with those variable names instead of waiting for a later failure.
2. The MCP tool returns a structured success payload that is persisted as a normal Roomote runtime tool-result message and streamed live to the web dashboard.
3. `standardTask()` prompt assembly explicitly marks plain web-launched generalist runs as web dashboard tasks, while Slack-, GitHub-, and Linear-attached wrappers carry their own surface labels so setup-oriented skills do not misroute every attached conversation surface through the secure web-only env-var branch.
4. For Slack-started setup jobs (`webPath: '/setup'`), that recorded tool result also triggers a standardized Slack thread reply linking the user back to `/setup`, so the secure handoff can accompany the agent's own Slack explanation of the required keys instead of depending on the agent to compose the link correctly.
5. After that tool result is recorded, the platform asks the current sandbox to stop the task through the same resumable path used by the web task view stop button.
6. The task transitions into the HarnessManager `stopped` phase while keeping the sandbox alive, so the agent does not continue running against missing secrets and the task can resume in-place later.
7. While the task is live, the worker runtime serves the pending-request state from in-memory harness state (`getPendingEnvVarRequest()`), which is updated from the live persisted-envelope stream. The web client can backfill or reconstruct the same state from persisted Roomote runtime `ToolResult` envelopes for `request_environment_variables`. That lets the `opencode-server` harness surface the same secure request UI without transcript-specific parsing in the React layer.
8. The web dashboard fulfills the pending request by writing encrypted values into `environment_variables`.
9. If the task still has a live sandbox, the dashboard calls the sandbox command `commands.reloadDeploymentEnvVars`.
10. The worker fetches the latest resolved runtime env vars through the SDK, rewrites the shared shell env file, and replaces the reloadable runtime env layer in memory while preserving setup-added workspace env. That reload path intentionally does not re-inject fixed source-control token values into the harness command env; bash commands keep using `BASH_ENV`, which re-sources provider token files under `~/.roomote/`.
11. The dashboard then sends a canned follow-up prompt instructing the agent to retry without printing secret values; that follow-up prompt also resumes the stopped task and serves as the durable clear marker for the request state in task history.

`runTask()` (`apps/worker/src/run-task/run-task.ts`) updates status:

- `spawning` -> `connecting` -> `running`

And also tracks `taskPhase` via harness state changes (`idle`, `running`, etc.).

Worker observability reports runtime failures to the Roomote worker Sentry
project by default. In addition to uncaught worker exceptions, OpenCode harness
errors and Roomote runtime envelope persistence failures are reported with per-job and
per-envelope context. The cancel-recovery path also emits a warning-level
Sentry signal when a stuck turn has to be restarted.

While the sandbox is alive, the worker also persists `cloud_jobs.sleepAt`, the
authoritative auto-sleep deadline used by both the task UI countdown and
BullMQ's sleep scheduler. While a turn is actively running or waiting on
`request_user_input`, the worker refreshes that deadline every 45 seconds and
uses the larger of the task keepalive and a 60-second active-task lease so
zero-idle policies can still finish an in-flight turn without immediately
tripping BullMQ's due-sleep path. Roomote runtime assistant output also updates the
worker's `lastMessageAt` state even before the turn settles, so the eventual
idle anchor matches the transcript activity the user saw. Once the task becomes
idle, the deadline stops moving and remains anchored to the normal keepalive
window. In all cases the deadline is capped by the sandbox hard lifetime so the
UI never counts past the point where BullMQ will put the sandbox to sleep. The
default keepalive is 5 minutes for human-backed work in production-like
environments and local development, while automation and maintenance launches
default to a one-minute idle keepalive. Explicit task-type overrides, such as
PR review follow-up jobs, can still choose a zero idle keepalive once they
become prompt-ready.

Queued follow-ups stay within the same active run. When a turn completes but
the prompt queue still has buffered follow-ups, the worker keeps the job in
the active `running` state and defers the `idle` transition until the final
queued turn finishes and the queue drains.

If the worker cancels a turn but the direct app-server transport never settles
the in-flight request, the harness does not locally pretend that the turn
finished. After a short grace period it asks the reconnect wrapper to restart
the subprocess, reload the existing session id, and replay any buffered
follow-up prompts on the resumed session. That keeps late updates from the
abandoned transport from leaking into the retry turn while still recovering the
same task session. That grace-period rearm now keys off real runtime progress
and persisted-envelope emission instead of generic stdout activity, so stray
non-progress transport output is less likely to delay stuck-turn recovery.

Queued-message recovery now uses the last authoritative in-memory prompt-queue
snapshot from the disconnected harness and then reapplies any queue maintenance
commands accepted while the replacement harness is still booting. That keeps
delete, prioritize, and reorder actions from resurrecting stale queued prompts
when reconnect succeeds.

If reconnect attempts are exhausted after the harness disconnects, the worker
now treats that as a terminal runtime failure instead of leaving the cloud job
parked in an active/disconnected state. `HarnessManager` immediately enters
shutdown so `runTask()` can resolve the cloud job to a terminal failed status
with the disconnect error that was already surfaced to runtime state.

### Worker Import Boundary

`apps/worker` should behave like a runtime client of the rest of the monorepo.
It should not reach directly into Redis-backed or database-backed workspace
package surfaces.

Preferred worker imports:

- safe roots such as `@roomote/types`, `@roomote/sdk`, and
  `@roomote/cloud-agents`
- explicit worker-safe subpaths such as `@roomote/auth/client`,
  `@roomote/slack/client`, and `@roomote/linear/client`

Avoid in worker code:

- workspace `*/server` entrypoints
- mixed root barrels that re-export server-only helpers alongside safe runtime
  helpers

If worker logic needs something that only exists on a server-oriented surface,
prefer one of these fixes:

1. Route the operation through `@roomote/sdk`.
2. Add a worker-safe/client-safe export on the package.
3. Move a truly shared constant or type to a safe root export.

`apps/worker/eslint.config.mjs` enforces this with `no-restricted-imports`.

Harnesses:

- `runTask()` always sets `ROOMOTE_TASK_TERMINAL=true` after sanitizing
  incoming task env vars and passes `allowTerminal: true` to the sandbox server
  for normal task execution. The sandbox terminal is always enabled (the legacy
  `TaskTerminal` feature flag has been removed).
- `opencode-server` is the active OpenCode server runtime. The worker
  starts `opencode serve`, writes `~/.config/opencode/opencode.json` under the
  sandbox HOME from `ROOMOTE_MODEL`, `ROOMOTE_SMALL_MODEL`, and
  `ROOMOTE_VISION_MODEL`, maps Roomote MCP servers into OpenCode's local/remote
  config shape, layers Roomote
  runtime overrides into the generated OpenCode config, and translates OpenCode
  session/message events into the Roomote runtime task-history
  stream. It currently handles normal prompts, queued follow-ups, abort, and
  final assistant-message persistence. It also writes a local OpenCode plugin
  that maps `tool.execute.before` / `tool.execute.after` onto Roomote's Slack
  silence hook rules, and the harness runs the generated Slack stop hook before
  emitting task completion. OpenCode tool parts are persisted as durable
  `roomote_runtime.tool_call` starts plus terminal `roomote_runtime.tool_result` rows, and OpenCode
  `question` tool parts are exposed as Roomote runtime `request_user_input` prompts whose
  answers are replayed to OpenCode as hidden follow-up prompts. Question
  normalization mirrors OpenCode's question schema, where `custom` ("allow
  typing a custom answer") defaults to true: a question maps to `isOther: true`
  — so Slack and other answer surfaces accept free-form replies, not just the
  listed options — unless the input explicitly opts out via `custom: false`
  (or a literal `isOther`/`other: false`). `subtask` parts
  are persisted as Roomote runtime subagent-start tool calls. The harness arms
  a per-spawn subagent watchdog (keyed to the child session id from the task
  tool part metadata, `sessionId` or `jobId`) with two deadlines: a total run
  timeout (default 12 minutes, `ROOMOTE_SUBAGENT_TASK_TIMEOUT_MS`) and a
  sliding inactivity deadline (default 3 minutes,
  `ROOMOTE_SUBAGENT_TASK_INACTIVITY_TIMEOUT_MS`) refreshed by every
  child-session event (streamed text, tool state, message completion). The
  inactivity deadline is only enforced while it is a strong signal: the child
  session id must be known (otherwise there is no activity feed to judge by)
  and no child tool call may be in flight (a silently long-running tool is
  legitimate; OpenCode's shell tool bounds that state with its own timeout,
  whose kill emits a terminal tool event that restarts the idle clock —
  non-shell tool kinds such as MCP calls, webfetch, and nested task spawns
  are not self-bounding, so a hang inside one is caught only by the total
  timeout, a deliberate trade-off against wrongly killing slow work). A
  child that goes silent between tools past the inactivity window — or any
  spawn that exceeds the total timeout — has its child sessions aborted so the
  parent turn continues with the aborted task result instead of hanging; a
  terminal tool status normally disarms the watchdog. Background launches
  (`background: true` in the task tool input or background metadata) complete
  the parent tool part instantly while the child session keeps working, so a
  completed background part keeps the watchdog armed; the watchdog disarms
  when the background child session goes idle, and a child session's idle
  never finishes the parent turn. Parent turn completion clears pending
  foreground watchdogs but keeps background ones armed (background launches
  outlive the turn by design; dispose, cancel, and new-task teardown still
  clear everything), and watchdog expiry cleans the child-session key map
  along with the watchdog entry. When
  `ROOMOTE_VISION_MODEL` differs from the effective coding model for the
  OpenCode run, the generated OpenCode config adds a hidden `visual` subagent
  backed by that model and adds parent instructions to delegate visual
  extraction through the Task tool. Inline image payloads are materialized to
  task-local temp files and receive an additional parent-agent reminder with
  exact `@/tmp/...` file references to pass to `visual`, rather than relying on
  parent-session image attachment inheritance; URL and filesystem path strings
  are not fetched or copied for this handoff. The materialized files are retained
  for the active harness lifetime so transcript `@/tmp/...` references remain
  usable across follow-up turns and snapshot resumes, then cleaned up on harness
  disposal or terminal error paths. OpenCode steering uses Roomote's queued-prompt
  cancel/replay fallback, with
  replay interrupts treated as non-terminal task events. OpenCode's normal
  config precedence owns provider and model selection; task payload `model`
  overrides are passed as explicit prompt-level overrides only when launch code
  supplies one.

Persistence model:

- The `opencode-server` harness uses the same Roomote runtime persistence bus for user
  prompts, assistant chunks, final assistant messages, queue updates, and
  turn-completed/task-completed events. OpenCode `tool` parts are normalized
  into live `roomote_runtime.tool_call_update` messages, persisted `roomote_runtime.tool_call` starts,
  and one persisted terminal `roomote_runtime.tool_result` per session/message/tool call.
  Because OpenCode's server events may not stream stdout for a long-running
  `bash`/`shell` tool until the tool exits, the harness emits bounded live
  `roomote_runtime.tool_call_update` heartbeat output for raw `running` execute tools that
  have not reported output yet. Those progress updates are not terminal results and
  are not persisted as `task_messages`; the real terminal OpenCode result still
  owns durable command output.
  OpenCode `subtask` parts are persisted as `kind: "subagent"` starts, but the
  installed OpenCode server does not expose a terminal subtask-result part, so
  the adapter does not synthesize a fake subagent result. OpenCode `question`
  tool parts become Roomote runtime `request_user_input` envelopes; because the OpenCode
  server has no request-response RPC for those prompts, submitted
  answers are persisted as Roomote runtime response envelopes and delivered back to the
  active session as hidden follow-up prompts. The response envelope preserves
  `submitted` versus `cancelled` resolution, and the hidden answer replay
  carries the answering user's `userId` so queued-prompt preparation can
  refresh actor-scoped MCP state at the next turn boundary. For Slack-backed
  tasks, the harness evaluates the generated stop hook before completion; when
  a terminal Slack-visible closeout is missing, it sends the hook reminder back
  as a hidden queued prompt and withholds `TaskCompleted` until the closeout is
  satisfied or the guard reaches its retry cap.
- Worker startup log UIs rely on provider-side command output streaming when the compute provider supports it. The worker no longer mirrors harness logs into `cloud_jobs.log`.

### Harness Transport Boundary

The harness compatibility layer is a transport and envelope-persistence boundary. It owns:

- direct runtime session lifecycle, reconnects, and queued follow-up delivery
- prompt block construction and runtime prompt emission
- persisted Roomote runtime envelopes plus generic transport metadata such as `sessionId`, `clientMessageId`, and sender identity

The harness layer should not own workflow- or product-specific presentation behavior. In particular, avoid putting logic like these into direct harness transport code:

- synthesizing feature-specific assistant personas or alternate transcript speakers
- injecting extra transcript messages purely to satisfy one product surface
- hiding, mutating, or reclassifying messages based on a specific GitHub, Slack, or review workflow convention

When a feature needs custom follow-up behavior, keep the harness output protocol-agnostic and implement the feature outside the transport layer:

- send the real follow-up through the normal queued prompt path
- persist durable content in `task_messages.contentBlocks` and typed machine state in `payload`
- interpret feature-specific conventions in the workflow that created them or in downstream task-history consumers that intentionally opt into that behavior

This matches the `task_messages` schema split: `contentBlocks` is the canonical renderable body, `metadata` is small transport context, and `payload` is event-specific machine state. Product-level transcript rendering should build on those persisted envelopes after they leave the harness, not by teaching the harness about a particular Roomote persona or transcript presentation rule.

## Snapshot and Resume Model

There are two snapshot modes in current code:

1. Environment snapshot jobs (`CloudTaskType.SnapshotEnvironment`) created from environment settings UI, keyed by provider.
2. Runtime/manual snapshots created from running cloud jobs (including automatic sleep handling at `sleepAt`, which snapshots resumable jobs and shuts down non-resumable ones).

Enqueue + processing:

- Snapshot requests are enqueued via SDK `createSnapshot()` to BullMQ queue `snapshot-jobs`.
- Snapshot jobs are one-shot (`attempts=1`) because provider snapshots are destructive: after a failed attempt, the sandbox may already be snapshotting or stopped, so correctness comes from explicit failure handling rather than BullMQ retries.
- Runtime snapshot requests use their `snapshotIntentId` as the BullMQ custom job id. Active/pending jobs for the same intent are treated as duplicates, while retained terminal jobs are removed before re-adding so a later DB-driven recovery attempt is not blocked by BullMQ's duplicate custom-id semantics.
- Runtime task workers no longer initiate automatic sleep actions themselves. Instead, they persist the due `sleepAt` deadline and wait for BullMQ to claim the job's sleep transition once that deadline elapses.
- That worker-side wait now applies to every provider in `sleepCheckManagedComputeProviders` (`modal`, `e2b`, and `daytona` today). Managed runtimes are expected to stay alive long enough for BullMQ to claim `sleepRequestedAt`/`snapshotRequestedAt`, after which the provider snapshot or destroy path tears the runtime down.
- BullMQ's scheduled `sleepCheckJob()` processes due runtime jobs for sleep-check-managed providers once `cloud_jobs.sleepAt` is reached. Resumable task types on snapshot-capable providers (`modal`, `e2b`) are snapshotted; non-resumable task types — and every job on non-snapshot providers such as `daytona` — are shut down directly. The candidate queries are backed by partial indexes whose vendor predicates match that managed list (migration `0021_bumpy_the_santerians.sql` dropped the retired `sandbox` vendor from them).
- `sleepCheckJob()` also runs a provider-timeout backstop over active provider-backed jobs whose persisted `sleepAt` is still in the future (or missing): if the provider reports `timeoutRemainingMs <= SNAPSHOT_CHECK_THRESHOLD_MS`, BullMQ treats that job as immediately eligible for snapshot/shutdown so a stale `sleepAt` value cannot silently carry the task past the provider hard limit.
- Candidate precedence is now resolved per machine from the live provider status: `due_sleep` wins first, then the actual `hard_limit` backstop, and only then `stale_worker` recovery. A stale worker candidate no longer preempts a resumable live instance that is already inside the provider reap window.
- `sleepCheckJob()` writes durable per-job decision events into `cloud_job_events` for candidate dedupe, instance-status checks, deadline extensions, snapshot handoff claims, and failure paths so operators can reconstruct why a given job was or was not snapshotted. Snapshot handoffs include a `snapshotIntentId`, trigger path, and BullMQ queue job id so later `snapshot_request` and `snapshot_queue` events can be correlated back to the sleep-check owner.
- Once a worker has already transitioned a resumable task to `idle` and BullMQ has claimed the external sleep action, late worker-side finalization errors are treated as non-fatal noise rather than downgrading the task into a failed terminal state. In that phase, BullMQ snapshot processing is the source of truth for the eventual completion outcome.
- Stale-worker recovery now scans both `running` and `idle` jobs on snapshot-capable providers so resumable sessions that lose their worker heartbeat while waiting for follow-up can still be snapshotted or finalized with an explicit audit trail instead of going silent until manual cancellation.
- While the worker is still alive, it also sends periodic `recordComputeProviderUsage(... lifecycleAction='running')` updates on the worker-heartbeat cadence. Those writes provide a rolling estimate of the active task-owned compute segment before any BullMQ teardown action happens.
- Fresh launch paths snapshot the effective provider compute resources onto
  `cloud_jobs` so later teardown accounting does not have to guess which
  provider resource configuration was actually used.
- `complete_without_snapshot` is reserved for cases where snapshotting is already impossible for the selected idle job, such as the provider reporting that the instance is no longer `running`.
- BullMQ worker (`apps/bullmq/src/jobs/snapshot.ts`) records the queue attempt, pre-snapshot provider status, post-failure provider status when available, and any request-state clearing before writing the terminal snapshot outcome. It is the final authority that writes:
  - `cloud_jobs.snapshotId/snapshotCreatedAt`
  - terminal `status='completed'` for snapshot job
  - `environment_snapshots` rows for `SnapshotEnvironment` through the
    DB-layer `attachEnvironmentSnapshot()` state transition
- `SnapshotEnvironment` completion must not blindly upsert provider snapshot
  state. Manual snapshot jobs complete only an active pending row; scheduled
  refresh jobs carry the active provider row id plus source snapshot identity
  and attach only if that source is still active. Attachment and invalidation
  both serialize on the owning environment row before mutating provider rows,
  so stale in-flight snapshot completions cannot half-restore invalidated
  state. Legacy attachment sources (`legacy_sandbox_row`,
  `legacy_active_snapshot_row`) are still parsed for old payloads but complete
  as no-ops; they are never produced anymore.
- The same BullMQ teardown hooks now also persist `compute_provider_usage`
  rows. Snapshot-driven teardown records usage after the provider confirms the
  instance has stopped, and direct shutdown paths in `sleepCheckJob()` do the
  same after `destroyInstance()` returns. Those final writes upsert over the
  earlier worker-side `running` estimate for the same cloud-job/machine segment
  instead of creating a second row, and they are the only writes that refresh
  `tasks.computeDurationMs`.
- Snapshot enqueue and processing paths also emit durable `cloud_job_events` rows so there is an audit trail even when the BullMQ queue never reaches a terminal failed job.
- Cloud-job-linked mutating compute-provider calls now emit their own `cloud_job_events` rows before and after the provider call, so create/resume, file-write, command, snapshot, and destroy operations can be reconstructed even when the higher-level workflow fails mid-flight.
- Snapshot failures now persist structured provider error details in those `cloud_job_events` rows, including HTTP status/body details from the provider SDK plus the immediate post-failure instance-status lookup when Roomote can still read it.
- The snapshot queue's reconciliation recovery path is gated on the optional `findSnapshotBySourceInstance` client capability. For providers that implement it (none currently do), an in-progress-snapshot signal or a retried queue attempt triggers a bounded lookup for a completed snapshot from the same source instance, recording `snapshot_reconcile_started`, `snapshot_reconcile_found`, or `snapshot_reconcile_not_found` decision events before either completing the cloud job with the recovered snapshot id or falling back to the normal explicit failure path. Providers without the capability skip reconciliation entirely.
- Those `compute_provider` events now flow through one shared mutation contract: every event carries a consistent lifecycle shape (`provider`, `operation`, optional `instanceId`, operator-facing `message`) plus normalized lifecycle details such as `launchMode`, `sourceSnapshotId`, `ports`, and `attempt` when they apply.
- Provider-agnostic lifecycle milestones now emit durable `job_lifecycle` events at controller dequeue, worker bootstrap, and terminal status transitions so an executed job cannot finish with an empty audit trail even when it never enters snapshot-specific branches.
- Snapshot resume orchestration now emits durable `cloud_job_events` rows for resume requests, child-job creation, and resume-bootstrap failures so operators can reconstruct why a task did or did not wake successfully.

### Sandbox OIDC Refresh Loop

Sandbox OIDC rotation is owned outside the worker runtime.

- BullMQ's dedicated `sandbox-oidc-refresh-jobs` queue runs
  `RefreshSandboxOidc` every 60 seconds.
- The refresh worker claims due machine groups from `sandbox_oidc_targets`,
  rewrites the sandbox-local token files in place, and pushes the next
  `refreshAt` forward.
- OIDC tokens have a one-hour lifetime and are refreshed 20 minutes before
  expiry. Claimed rows are leased for two minutes, and the refresh loop
  continues after per-machine failures so one unavailable sandbox does not block
  the rest of the batch.
- If the owning cloud job no longer matches the provider machine, the refresh
  pass deletes the files and removes the stale rows.
- This keeps active task machines fresh without placing minting credentials or
  refresh logic inside the sandbox workload itself.

Resume:

- `SnapshotResume` jobs are created with `sourceSnapshotId` and `sourceCloudJobId`.
- `SnapshotResume` always inherits the source job's compute provider; snapshots are provider-bound and are never resumed across providers.
- Workflow-specific `harnessInstructions` are persisted on the source `cloud_jobs` row at initial dequeue and copied forward onto `SnapshotResume` jobs so resumed workers can recreate harness system prompts without rerunning prompt builders or repeating builder side effects.
- Resume bootstrap sets the startup `prompt` to an empty string. Any deferred
  follow-up for the resumed task is queued after reconnect instead of being
  treated as a fresh-task startup prompt.
- `dequeueResumeCloudJob()` resolves runtime task session from source job (`result.runtimeTaskId` or `tasks.harnessSessionId`).
- Worker `resume` command restores workspace context and resumes harness session
  into `waiting_for_prompt`, so the restored cloud job immediately uses the
  normal keepalive window instead of inheriting the provider hard timeout until
  later activity arrives.
- Snapshot restore does not preserve running processes. Worker setup reruns service startup against the restored filesystem state, so service-specific recovery still matters during resume.
- Worker service startup now tolerates duplicate-start races without assuming that any listener on the target port is the right service. `ServiceManager` still calls each service's `start()` hook, but if that start attempt errors and the service proves healthy immediately afterward, the worker continues instead of failing the resume.
- PostgreSQL resume startup now verifies liveness with `pg_ctl status` and the socket-lock PID before deleting `postmaster.pid`, the Unix socket, or the `.lock` file under `/var/run/postgresql` or `/tmp`. Startup failures still append the newest internal PostgreSQL log tail to the surfaced worker error.
- Redis resume startup now uses a managed PID file under `/data/services/redis` and deletes stale copies before launch. ClickHouse resume startup removes stale `/var/lib/clickhouse/status` files before relaunching the server. MySQL and MariaDB already clean the socket and PID artifacts they rely on before startup.
- Web sandbox session command can follow active successor jobs for multi-hop resume chains.

## Completion and Side Effects

Finalization path: `finishCloudJob()` in `packages/sdk/src/server/lib/cloud-jobs/finish-cloud-job.ts`.

Responsibilities:

- Releases queue lock via `releaseCloudTask()`.
- Writes final status and timestamps.
- Clears `taskPhase` once a job reaches a terminal completed/failed/canceled state.
- Does **not** own compute-provider usage recording. Compute usage is recorded
  earlier in BullMQ teardown paths when the instance actually stops, which can
  happen before or after `finishCloudJob()` depending on snapshot and sleep
  orchestration.
- Does not send cloud job completion email; completion feedback is handled through task-native channels such as Slack, Linear, and GitHub side effects.
- Cleans up GitHub PR reaction state and any legacy check run state persisted on older jobs.
- For non-idle terminal states, removes any tracked sandbox OIDC token files
  owned by that cloud job and deletes the corresponding `sandbox_oidc_targets`
  rows.
- Sends failure notifications back to Linear when relevant, and sends a Slack failure handoff only for setup onboarding jobs that should return the user to `/setup`.

Terminal statuses accepted by SDK `done`:

- `completed`
- `failed`
- `canceled`
- `idle`

## Data Model (Important Tables)

`cloud_jobs` (`packages/db/src/schema.ts`):

- Identity: `id`, `type`, `userId`, `taskId`, `harness`
- Initial intent: `requestedWorkKind`, `requestedWorkKindSource`, `requestedWorkKindConfidence`
- Lifecycle: `status`, `taskPhase`, `createdAt`, `dequeuedAt`, `provisionStartedAt`, `provisionReadyAt`, `startedAt`, `setupCompletedAt`, `harnessStartedAt`, `runtimeTaskStartedAt`, `firstAssistantOutputAt`, `completedAt`, `canceledAt`
- Launch mode (captured once per job): `launchMode` (`fresh` \| `environment_snapshot` \| `task_snapshot`); provisioning latency is only comparable within the same launch mode
- Runtime routing: `vendor`, `machineId`, `sandboxCmdId`, `machineDomains`, `proxyPorts`, `sandboxServerUrl`
- Worker runtime identity: `workerReleaseTag`, `workerVersion`, `workerCommit` capture the actual worker artifact metadata reported by the running worker during bootstrap
- Snapshot/sleep fields: `snapshotId`, `snapshotRequestedAt`, `snapshotCreatedAt`, `snapshotFailedAt`, `sleepAt`, `sleepRequestedAt`, `sourceSnapshotId`, `sourceCloudJobId`
- Worker liveness: `workerHeartbeatAt` records the last successful worker-process heartbeat for stale-worker recovery when the sandbox is still alive but the worker has stopped making progress
- Integrations: Slack/Linear/GitHub metadata fields

`cloud_job_events`:

- Append-only audit history for cloud job lifecycle decisions and provider operations
- Stores `source`, `eventType`, operator-facing `message`, and structured `details`
- Current sources include:
  - `job_lifecycle`
  - `sleep_check`
  - `compute_provider`
  - `snapshot_request`
  - `snapshot_queue`
  - `snapshot_resume`
- `job_lifecycle` is the provider-agnostic baseline trail. It records controller dequeue, worker bootstrap, and terminal transitions (`completed`, `failed`, `idle`, `canceled`) so executed jobs always have a durable audit spine.
- `job_lifecycle` now also carries pre-worker setup bootstrap phases such as source-control token creation, prompt generation, runtime env resolution, and launch-flag or routing resolution. Those events use `eventType='phase'` with `details={phase,startedAtMs,endedAtMs,durationMs,outcome,...}` so startup investigations can split the broad `startedAt -> setupCompletedAt` bucket without adding a schema column for every sub-step.
- `compute_provider` details are intentionally normalized across providers so cross-provider queries can compare the same lifecycle keys instead of provider-specific payloads
- Intended for durable debugging when a job never makes it into BullMQ's failed list or when the scheduler intentionally skips a branch

Recommended next additions:

- Cancellation lifecycle events that distinguish user-initiated cancellation, orphan cleanup, and scheduler-driven termination.
- Stale-worker recovery events that show heartbeat age, provider status, and whether BullMQ recovered by snapshot, destroy, or direct failure.
- External sleep handoff events that capture wait start, claim timeout, and completion per provider so auto-snapshot gaps are visible without reconstructing logs.

`environments`:

- Repository/service/port config in JSON `config`
- Legacy sandbox snapshot columns (`snapshotId`, `snapshotStatus`, ...) still exist in the schema but are no longer read or written; `environment_snapshots` rows are the only source

`environment_snapshots`:

- Source-of-truth provider snapshot records keyed by `(environment_id, provider)`
- Tracks `snapshotId`, `snapshotStatus`, `snapshotCreatedAt`, and `snapshotExpiresAt` per provider
- Drives provider-specific environment snapshot UI and environment-backed launch selection

`sandbox_oidc_targets`:

- Provider-machine keyed ownership records for sandbox-local OIDC token files
- Carries deployment scope, environment scope, target audience, token path, and the
  current cloud-job owner
- Drives BullMQ refresh scheduling and finish-time cleanup

`task_messages`:

- Durable protocol-agnostic message envelopes for task history

## Timing Diagnostics

Deployment latency analytics rely on a fixed set of ordered milestone timestamps on `cloud_jobs`, segmented by `launchMode`.

Milestone timeline (each stamped at most once per job via `stampCloudJobMilestone` in `packages/sdk/src/server/lib/cloud-jobs/stamp-milestone.ts`, which uses `WHERE <field> IS NULL` to preserve the first transition):

| Milestone                | Written by                                                                         | Meaning                                                           |
| ------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `createdAt`              | insert path                                                                        | Job enqueued                                                      |
| `dequeuedAt`             | `apps/controller/src/BaseController.ts`                                            | Controller claimed from BullMQ                                    |
| `provisionStartedAt`     | `apps/controller/src/compute-providers/spawn-{docker,modal,daytona,e2b}-worker.ts` | Compute provider create/resume call begins                        |
| `provisionReadyAt`       | same                                                                               | Infrastructure usable (sandbox/machine ready)                     |
| `startedAt`              | `packages/sdk/src/server/lib/cloud-jobs/dequeue-cloud-job.ts`                      | Worker claimed the dequeued job                                   |
| `setupCompletedAt`       | `apps/worker/src/commands/utils/execute-job.ts`                                    | Workspace configured, harness can spawn                           |
| `harnessStartedAt`       | `apps/worker/src/run-task/create-harness.ts`                                       | OpenCode server process alive                                     |
| `runtimeTaskStartedAt`   | `apps/worker/src/run-task/run-task.ts`                                             | Harness accepted the task and produced a session id               |
| `firstAssistantOutputAt` | `apps/worker/src/run-task/subscribe-harness-callbacks.ts`                          | First live Roomote runtime event with `role='assistant'` observed |
| `completedAt`            | finalize path                                                                      | Terminal status written                                           |

Fine-grained setup-step durations flow through the existing `cloud_job_events` table in two layers:

- `source='job_lifecycle'` now captures pre-worker-setup bootstrap phases such as `createSourceControlToken`, `generatePrompt`, `resolveRuntimeEnvVars`, and `resolveLaunchFlagsAndRouting`.
- `source='worker_runtime'` captures outer worker phases such as `resolveWorkspaceConfig` and `setupWorkspace`, plus the nested `timedStep()` setup labels.

All of these phase events use `eventType='phase'`, `message=<label>`, and `details={phase,startedAtMs,endedAtMs,durationMs,outcome,...}`. `timedStep()` in `apps/worker/src/commands/setup/logging.ts` emits the nested setup-step events automatically when the caller passes a `recordPhase` callback (execute-job wires that to `sdk.cloudJobs.recordEvent`).

`firstAssistantOutputAt` is intentionally not a token-usage metric. It answers "has the harness started producing assistant output yet?" using the live Roomote runtime stream rather than waiting for persisted envelopes.

Queries that need proof of end-to-end harness activity should filter `WHERE firstAssistantOutputAt IS NOT NULL` and segment by `launchMode` because fresh launches and snapshot resumes have very different provisioning profiles. If the question is specifically "did the harness accept the task yet?", `runtimeTaskStartedAt` is the better cut. The `cloud_jobs_first_assistant_output_at_idx` index backs common time-bounded aggregations.

## Auth and Authorization

Token types (`packages/auth/src/*.ts`):

- Job token (`r.t='cj'`): scoped to one cloud job (`sub=cloudJobId`) + user claim.
- Auth token (`r.t='auth'`): user session token for non-job actions.

Middleware (`apps/api/src/middleware/tokenAuthMiddleware.ts`):

- Attempts job token validation first.
- Falls back to auth token validation.
- tRPC procedures use `jobScoped` and `nonJobProcedure` guards in SDK router.

## Key Files Reference

| File                                                                 | Why it matters                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/cloud-agents/src/server/cloud-job-queue.ts`                | Job creation, queue/lock behavior, and compute-provider selection                   |
| `apps/controller/src/BaseController.ts`                              | Main dequeue loop, heartbeat, spawn, error handling                                 |
| `apps/controller/src/orphaned-cloud-jobs.ts`                         | Orphan detection and lock release behavior                                          |
| `apps/controller/src/compute-providers/spawn-modal-worker.ts`        | Fresh Modal worker spawn path (Daytona/E2B/Docker siblings live alongside)          |
| `apps/worker/scripts/worker.ts`                                      | Worker runtime commands and process entrypoint                                      |
| `apps/worker/src/commands/utils/execute-job.ts`                      | Shared execution wrapper for run/resume                                             |
| `apps/worker/src/run-task/run-task.ts`                               | Harness runtime, status updates, polling, and external sleep-action handoff         |
| `apps/worker/src/run-task/create-harness.ts`                         | Harness selection and Roomote runtime event setup                                   |
| `packages/sdk/src/server/routers/cloud-jobs.ts`                      | Worker/API RPC contract for cloud job operations                                    |
| `packages/sdk/src/server/lib/cloud-jobs/dequeue-cloud-job.ts`        | Worker dequeue transaction + prompt/token prep                                      |
| `packages/sdk/src/server/lib/cloud-jobs/dequeue-resume-cloud-job.ts` | Resume dequeue and source session resolution                                        |
| `packages/sdk/src/server/lib/cloud-jobs/finish-cloud-job.ts`         | Finalization and side effects                                                       |
| `packages/sdk/src/server/lib/cloud-jobs/enqueue-snapshot.ts`         | Snapshot BullMQ enqueue logic                                                       |
| `apps/bullmq/src/jobs/snapshot.ts`                                   | Snapshot execution and final DB writes                                              |
| `apps/web/src/trpc/commands/snapshots/index.ts`                      | UI-triggered snapshot and resume commands                                           |
| `apps/web/src/trpc/commands/sandbox-session/index.ts`                | Session resolution across snapshot-resume chains                                    |
| `packages/db/src/schema.ts`                                          | Authoritative schema for cloud_jobs/environments/sandbox_oidc_targets/task_messages |
| `packages/types/src/cloud-jobs.ts`                                   | Task types, launch classes, status sets, and launch-mode helpers                    |

## Extension Guardrails

These review guardrails are easy to miss when adding new task execution, Slack,
CI, or reporting paths. Treat them as required checks before opening a PR.

### Async State Re-validation After Awaits

- Any function that reads queue, task, cloud-job, or snapshot state, performs
  an async operation, and then mutates based on that earlier read must re-read
  the live state after the `await` and re-validate its assumptions before
  continuing.
- Treat pre-`await` state as a hint, not an authority. Another controller,
  worker, BullMQ job, or user action may have reordered, replaced, canceled,
  claimed, or refreshed that state while the async step was in flight.
- Queue-handling and snapshot paths are especially susceptible to concurrent
  modification and TOCTOU bugs. Common failure modes include acting on a stale
  queue head after async preparation work, or clearing/replacing snapshot state
  after another path has already created, claimed, or superseded the live row.
- When the post-`await` re-read no longer matches the earlier assumptions,
  prefer an idempotent no-op, restart from the new live head, or return an
  explicit conflict/retry path instead of mutating through stale state.

### Locking Contract

- Before introducing a new write path to a resource that is already protected by
  a named lock, grep for that lock name and acquire it in the new path.
- Treat a code review that finds an unguarded write to a lock-protected
  resource as a process failure. Fix it before merge rather than accepting it
  as a follow-up.

### Outbound Links and URLs

- Never use `metadata.apiBaseUrl`, `TRPC_URL`, or any `localhost` /
  `127.0.0.1` origin as the base for user-visible links in Slack, email,
  GitHub comments, or other external outputs.
- Prefer the surface's documented public app origin when composing outbound
  task links. In the normal cloud-job path that is `ROOMOTE_APP_URL`, and
  helpers such as `getTaskUrl()` already build on that contract.
- Before wiring a URL field into an outbound payload, confirm the target
  resolves from outside the sandbox and not just from the runtime container,
  and do not assume similarly named API and web metadata fields are
  interchangeable across workflows.

### Slack Thread Reply State

- Slack thread reply footer state is one concrete example of this contract. Any
  code path that reads or writes that state must take the per-thread lock
  through `withSlackThreadReplyFooterLock()` before touching tracked footer
  timestamps, divider placement, or More/Less toggle blocks.
- When adding a new Slack reply helper or mutation path, grep for
  `withSlackThreadReplyFooterLock` and verify the new path is covered rather
  than assuming existing callers already serialized the state you depend on.
- If a new path can send text-only, block-only, or image-only replies, validate
  divider and footer behavior for all three shapes instead of only the text
  path.

### Database Query Conventions

- When writing a new `tasks` or `cloud_jobs` query with a time window, make the
  `WHERE` time-bound column and `ORDER BY` column match unless the divergence is
  intentional and documented in the query.
- For user-facing task listings or analytics, apply `isVisibleTask(tasks.id)`
  unless the query is explicitly an admin or internal-only view.
- If you only have the latest cloud job type available, filter hidden/internal
  task types with `isHiddenCloudTaskType(...)` before surfacing results to
  users.
- Grep for `isVisibleTask` in existing task queries and mirror the nearby
  pattern before adding a new one-off filter.

### CI Path-Filter Completeness

- When writing a workflow path selector, worker-release trigger, or reusable
  build fingerprint, trace the full import graph of the artifact under test and
  include transitive workspaces, not just the package you edited directly.
- Use `pnpm --filter <package> why <dependency>` to verify transitive workspace
  legs before finalizing the filter set.
- If an archive, bundle, or cached worker release is reused conditionally, make
  sure the reuse key accounts for every workspace that can change the produced
  artifact; existence-only shortcuts can silently preserve stale outputs.

## Operational Notes

Useful checks:

- API health: `GET /health/api`
- Controller health: `GET /health/controller`
- BullMQ dashboard: `http://localhost:13002/admin/queues`

Common debugging anchors:

- Queue lock issues: `releaseCloudTask`, orphan checks, scope generation
- "stuck in dequeued": controller logs + `/health/controller` + `dequeuedAt`/`startedAt`
- Snapshot confusion: compare `snapshotRequestedAt`, `snapshotCreatedAt`, `snapshotFailedAt`, `workerHeartbeatAt`, `sleepAt`, and the ordered `cloud_job_events` trail before falling back to BullMQ logs
- If a task already reached `idle` and BullMQ claimed the sleep action, treat late worker-side finalize errors as transport noise first. Check whether the snapshot queue later wrote the real terminal state before interpreting a raw `job_lifecycle failed` event as user-visible task failure.
- Suspected crashed worker with live sandbox: compare `workerHeartbeatAt` against current time, then check whether the sandbox is still `running` and whether BullMQ `sleep-check` recovered it via snapshot or failure
