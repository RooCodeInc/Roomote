---
title: Compute Providers
status: active
last_reviewed: 2026-07-06
owner: engineering
summary: Technical documentation of compute provider abstractions covering Docker, Modal, Daytona, E2B, fresh launch flows, worker release distribution, and worker bootstrap behavior.
---

# Compute Providers

Roomote's compute providers package abstracts worker execution behind provider
clients and shared launch helpers. The current built-in providers are
**Docker**, **Modal**, **Daytona**, and **E2B**. Modal and E2B support hosted
snapshot-capable worker execution.
Daytona is a hosted runtime for immediate tasks with API-key-only
authentication; it does not support snapshots or snapshot resume yet, but its
machine lifecycle is managed by the scheduled sleep-check pipeline (always
destroy, never snapshot). Docker is the default local and single-host
self-host runtime for immediate tasks and intentionally does not support
snapshots or hosted command-log streaming yet.

The former **Vercel Sandbox** provider (`vendor = 'sandbox'`) has been removed;
see [Vercel Sandbox (Removed)](#roomote-removed) for what remains of its
shared infrastructure and the operational consequences for historical jobs.

For the end-to-end implementation checklist, see
[Adding a Compute Provider](./adding-compute-provider.md).

## Error Handling Contract

Readiness checks, health probes, and wrapper scripts that call
`computeClient.runCommand()` or an equivalent provider command runner must
inspect the structured command result instead of assuming that a resolved call
means success.

- When `exitCode !== 0`, callers must throw or return a typed failure that
  preserves the structured child-process data needed by the next layer to make
  decisions: at minimum `exitCode`, `stdout`, and `stderr`.
- Wrapping a non-zero child result in a plain `Error(message)` is not
  sufficient when the caller needs to distinguish blocked state, readiness
  failure, child-process failure, and transport/runtime failure.
- Output truncation is allowed for size control, but the truncated fields still
  need to stay attached to the structured failure result.

This applies equally to direct provider probes, health-relay helpers, and shell
wrappers around proof or setup subprocesses.

## Overview

The compute providers system is organized around three core concepts:

1. **Factory Pattern**: `createComputeProviderClient()` returns provider-specific clients implementing the `ComputeProviderClient` interface
2. **Environment Machine Helpers**: provider-neutral helpers normalize machine metadata, auth-bypass fields, and preview-surface bookkeeping
3. **Environment Builders**: Provider-specific functions construct environment variables for workers

At runtime, the controller dispatches per job using `cloud_jobs.vendor`.
When a caller omits the provider, `enqueueCloudTask()` falls back to the
deployment default resolved by
`resolveDefaultComputeProvider()` (`packages/db/src/lib/compute-runtime-config.ts`),
and snapshot resumes inherit the source job's persisted vendor. The deployment
default resolves as: the persisted setup-flow choice in
`deployment_settings.runtime_compute_config.defaultProvider` first, then the
`DEFAULT_COMPUTE_PROVIDER` env value, then `docker`. The persisted choice wins
over the env value because compose and PM2 stacks always inject an env default,
so the admin's explicit `/setup` choice is the stronger signal. Roomote's
shared env schema defaults the env value to `docker`, and
`resolveComputeProviderTarget()` also falls back to `docker` for missing or
unsupported vendor values, so local development and
single-host self-host deployments run immediate tasks in job-scoped Docker
worker containers by default. Hosted Modal, Daytona, and E2B execution remain
available through explicit provider configuration. Authenticated users can
explicitly choose any supported provider in web surfaces that expose a picker
or provider-specific snapshot actions; omitted-provider launches inherit the
default.

Worker env builders forward only configured public URLs. They no longer
synthesize Roomote/Newmote web, API, or preview-proxy domains for preview or
production. Local development gets defaults from `@roomote/env`; shared
self-hosted deployments must provide `ROOMOTE_APP_URL`, `TRPC_URL`, and, when
preview URLs are needed, `PREVIEW_PROXY_BASE_URL`.

## Provider Types

### Docker

**Location**: `apps/controller/src/compute-providers/spawn-docker-worker.ts`

Docker execution target using the worker Docker image from
`apps/worker/Dockerfile`. `pnpm dev` ensures the configured
`DOCKER_WORKER_IMAGE` exists, defaulting to `roomote-worker:local`. On
published app images, an unset `DOCKER_WORKER_IMAGE` is derived in
`@roomote/env` as `<ROOMOTE_WORKER_IMAGE_REPO or
ghcr.io/roocodeinc/roomote-worker>:${RELEASE_VERSION}` from the baked release
version (`deriveWorkerImageFromReleaseVersion` in
`packages/types/src/setup-compute-config.ts`); explicit env values win, and
`self-host*` or missing release versions fall through to the local default.
`DOCKER_WORKER_PLATFORM` defaults to the host architecture (`linux/arm64` on
arm hosts, `linux/amd64` otherwise) so Apple Silicon dev machines and arm
servers run the native worker-image variant; the published worker images are
multi-arch. On arm64, the worker image bakes Playwright's Chromium instead of
Chrome for Testing (which has no Linux arm64 builds) behind the same
`AGENT_BROWSER_EXECUTABLE_PATH`. Hosted providers (Modal/E2B/Daytona) run
amd64 and resolve that variant from the manifest, so `MODAL_BASE_IMAGE_REF`
needs no arch handling. Self-host Compose uses
`docker-compose.compute-docker.yml` to build
that image, mount the Docker socket into the controller, set
`DOCKER_WORKER_NETWORK=roomote_worker` (a dedicated network isolated from
Postgres/Redis/MinIO), and point
`DOCKER_WORKER_RELEASE_PATH` at the controller image's packaged worker release
archive.

**Capabilities**:

- Starts one Docker container per immediate task
- Reuses the shared `/sandbox` worker filesystem layout
- Copies `.docker/sandbox/*` plus the selected worker release archive into the
  container and runs `install-worker.sh`
- Publishes named ports back to `127.0.0.1` in local direct mode
- Joins worker containers to `DOCKER_WORKER_NETWORK` in self-host mode and
  exposes `SANDBOX_SERVER` through preview proxy while keeping internal
  `machineDomains` on Docker DNS names
- Does not support snapshots, snapshot resume, or provider command-log
  streaming
- Outside development, starts the container with `--rm` so it is destroyed when
  the worker exits, discarding the cloned repo and the worker's token files
  instead of leaving stopped `roomote-worker-*` containers behind. Development
  keeps stopped containers for post-mortem debugging
  (`shouldAutoRemoveDockerWorkerContainer`). The sleep-check teardown pipeline
  cannot reap Docker containers because it runs without the host Docker socket,
  so completion cleanup relies on this self-removal.

Docker worker containers are supported for trusted single-host deployments
where the controller can access the host Docker socket. They are not a
multi-host scheduler. Snapshot jobs continue to require Modal or E2B.

### Modal

**Locations**:

- `packages/compute-providers/src/adapters/modal.ts`
- `packages/compute-providers/src/modal/create-modal-machine.ts`

Modal uses the Modal sandbox runtime for fresh workers and provider-bound
snapshots.

**Capabilities**:

- Create/destroy instances
- Command execution
- File writes
- Snapshots and snapshot resume

**Configuration** (`ModalConfig`):

```typescript
{
  tokenId: string;              // MODAL_TOKEN_ID
  tokenSecret: string;          // MODAL_TOKEN_SECRET
  endpoint?: string;            // MODAL_ENDPOINT
  environment?: string;         // MODAL_ENVIRONMENT
  appName?: string;             // MODAL_APP_NAME
  baseImageRef: string;         // MODAL_BASE_IMAGE_REF
  registryUsername?: string;    // MODAL_REGISTRY_USERNAME
  registryPassword?: string;    // MODAL_REGISTRY_PASSWORD
  ecrOidcRoleArn?: string;      // MODAL_ECR_OIDC_ROLE_ARN
  ecrRegion?: string;           // MODAL_ECR_REGION
  timeoutMs?: number;
}
```

Roomote currently provisions Modal workers with a small default request from
the neutral compute-provider resource resolver in
`packages/types/src/compute-provider-usage.ts` (currently `0.125` CPU cores and
`128` MiB) while applying hard caps derived from the shared worker-runtime
sizing constants in
`packages/types/src/compute-providers/worker-runtime.ts` (currently `8` CPU
cores) plus a Modal-only hard memory override in
`packages/compute-providers/src/factory.ts` (currently `32,768` MiB, doubled
from the shared `16,384` MiB default). That keeps Modal requests low
for scheduling while giving Modal-backed sandboxes extra headroom
for workloads that now OOM at the original cap. The request defaults are
applied through `resolveConfiguredComputeProviderResources()`, and the Modal
client factory adds the provider-specific limit values so fresh launches and
environment-snapshot resumes use one shared source of truth for the cap.

**Base image and worker bootstrap split**:

- `baseImageRef` selects the OS/tooling layer for fresh instances.
- Fresh Modal boots and environment-snapshot resumes both upload the selected worker release tarball plus the shared bootstrap scripts under `.docker/sandbox/`, including `install-worker.sh` and `install-browser-agent.sh`.
- Hosted providers upload only the explicit bootstrap allowlist from `.docker/sandbox`; unrelated files in that directory are ignored.
- The worker release tarball is written to Modal sandboxes in bounded chunks because Modal rejects single filesystem write payloads above 16 MiB.
- Environment-snapshot resumes refresh the shipped worker/runtime in place; task snapshot resumes preserve exact runtime state by skipping shipped-runtime bootstrap entirely.
- Modal uses the shared hosted-sandbox worker filesystem layout: the `roomote` user, `/sandbox` for uploaded bootstrap files and worker state, `/sandbox/repos` for workspaces, and `/sandbox/.vscode` for VS Code user data.
- Roomote sets Modal sandbox tags immediately after each fresh create or snapshot resume. Current tags are `app_environment` (the controller runtime environment: `development`, `preview`, or `production`) and `organization_name` when the sandbox can be associated with a Roomote org. This keeps Modal-side usage exports groupable by deployment environment and customer org without changing the worker bootstrap contract.
- `MODAL_BASE_IMAGE_REF` is required for Modal execution but no longer needs to be set explicitly on most deployments. Resolution order is: runtime env, encrypted deployment env var, then a derived default — `resolveComputeProviderEnvValues` (packages/db) and the compute-provider factory fall back to `resolveDerivedModalBaseImageRef(env)`, i.e. the registry-qualified `DOCKER_WORKER_IMAGE` or the worker image derived from the baked `RELEASE_VERSION` (the published GHCR worker image doubles as the Modal base image). In local development only, when neither of those values is usable and the local Docker worker image is the bare `roomote-worker:local` tag, Modal falls back to `ghcr.io/roocodeinc/roomote-worker:latest` so developers can select Modal locally without publishing a custom worker image first. The one-command installer and the V1 deployer additionally keep the ref managed in the env file: they set it to the release-matched `DOCKER_WORKER_IMAGE` whenever it is blank or still equals the previously deployed worker image, and preserve any other non-empty value as an operator override. The setup wizard still persists the ref derived from an explicit `DOCKER_WORKER_IMAGE` as a deployment env var for installs that predate the derived default.
- Outside local development, `MODAL_BASE_IMAGE_REF` should point to an immutable image tag, typically `:commit-<git-sha>` or a versioned release tag, rather than a mutable tag such as `:latest`. The installer/deployer-managed default satisfies this because GHCR publishing refuses mutable `latest` tags. The development-only `ghcr.io/roocodeinc/roomote-worker:latest` fallback is intentionally a convenience for local Modal testing, not a production default.
- The published `roomote-worker` image is public, so Modal pulls the base
  image anonymously and no registry credentials are needed. Forks hosting the
  worker image in a private non-ECR registry such as GHCR set both
  `MODAL_REGISTRY_USERNAME` and `MODAL_REGISTRY_PASSWORD`; Roomote passes
  them to Modal as `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` in a Modal
  secret for `Image.fromRegistry(...)`. These values are mutually exclusive
  with the ECR OIDC settings, and when set they are used — a stale credential
  pair fails pulls that would succeed anonymously.
- The baked Modal image is the primary source of truth for system packages and durable browser/tooling setup. The checked-in worker Dockerfile now uses Ubuntu 24.04 and bakes the generic worker prerequisites directly into the image: browser font packages including `fonts-noto-color-emoji`, VS Code, GitHub CLI, AWS CLI, Chromium via `agent-browser`, `ffmpeg`/`ffprobe`, passwordless `roomote`, the `/vercel/...` workspace layout, shared mise/pnpm paths under `/opt/mise` and `$HOME/.local/bin`, mise-managed pinned Node.js, pnpm, Rust, `ripgrep`, and `uv`, baked `python3` plus a `python` alias in `/usr/local/bin`, default Python packages such as `openai`, shared `/sandbox/node_modules` installs for `node-pty` and agent CLIs, preinstalled `opencode` wrappers that target `/sandbox`, local runtime helpers such as `inotify-tools`, and the heaviest built-in helper services Roomote environments commonly need (MySQL client/server core, PostgreSQL 15/16/17, and `redis-server`). Runtime service setup still prefers those prebaked binaries, but older sandbox snapshots can self-heal a small subset of missing managed-service tools at setup time, including PostgreSQL, Redis, and AWS CLI. The Dockerfile must keep `python3` listed explicitly in `apt-get install` because `node-gyp` (used by native modules like `node-pty`) requires it.
- **Modal root-user tradeoff**: Modal ignores the Dockerfile `USER` directive and runs all `sandbox.exec()` commands as root. The adapter's `wrapCommandForDefaultUser()` injects `HOME=/home/roomote`, `USER=roomote`, `LOGNAME=roomote`, and a `PATH` that includes mise shims and `~/.local/bin`. This lets user-scoped tooling (mise, pnpm, agent-browser, etc.) resolve correctly while avoiding the Linux `no_new_privs` restriction that prevents nested `sudo` when the outer process already used `sudo -u` to switch users. **Known risks**: (1) the real UID is 0, so all files created in `/home/roomote` are root-owned — if any code path later runs as `roomote` and expects to write there, it will fail with permission errors; (2) tools that inspect the real user via `id` or `whoami` (not `$USER`) will see `root`, which can change behaviour; (3) Modal's `env` option on `sandbox.exec()` **replaces** the entire process environment rather than merging, so any env var not explicitly passed is absent. If this tradeoff becomes untenable, the alternative is to make the Dockerfile's default user root and run `roomote` setup purely through env vars / filesystem layout, or to find a Modal-supported mechanism for running exec'd commands as a non-root user without triggering `no_new_privs`.
- The shared `install-worker.sh` bootstrap is intentionally narrow: it refreshes the worker release archive under `/sandbox`, reinstalls the minimal `worker` launcher wrapper, and validates the `node-pty` package from the same `/sandbox/worker/dist/worker.js` resolution path the terminal websocket uses. When the baked image is stale or missing that native module, the bootstrap repairs `/sandbox/node_modules` in place before the worker starts. Durable browser automation bootstrap still lives in the shared `.docker/sandbox/install-browser-agent.sh` script, which the worker Dockerfile executes at image-build time and `apps/worker/src/commands/setup.ts` can rerun on older Linux images to repair or upgrade `agent-browser`. The worker Dockerfile still owns durable system packages, default Python packages installed with `uv`, and the stable `opencode` wrapper, while `setup.ts` owns runtime HOME/setup concerns such as local `node-pty` fallback install paths and temporarily repairing missing `python`, default Python packages, plus `ffmpeg` / `ffprobe` on older Linux images or compatible Linux local environments until the prebaked image rollout has fully landed. In sandbox runtimes, the `setup.ts` fallbacks co-install `node-pty` and the pinned OpenCode CLI in the shared `/sandbox/node_modules` root so npm does not prune one repair while applying another. Modal no longer performs a separate provider-specific system-package install after instance creation.
- Modal lifecycle operations are abort-aware. If a local timeout fires after a sandbox may already exist, Roomote stops waiting and performs best-effort cleanup of the remote machine instead of leaking it silently.

**ECR / OIDC**:

- Modal can pull the base image from ECR via OIDC when both `MODAL_ECR_OIDC_ROLE_ARN` and `MODAL_ECR_REGION` are configured.
- The image reference still comes from `MODAL_BASE_IMAGE_REF`; OIDC only changes how Modal authenticates the pull.

### Daytona

**Location**: `packages/compute-providers/src/adapters/daytona.ts`

Hosted execution target using the `@daytonaio/sdk` client. Daytona was added
for its minimal customer onboarding: authentication is a single
`DAYTONA_API_KEY`, and the worker base image is a Daytona snapshot registered
once from the public Roomote worker image (any publicly accessible registry
image works), so customers never build or upload images themselves. The
setup wizard and the Settings → Compute page can register that snapshot
automatically from the configured worker image
(`registerDaytonaWorkerSnapshot` in
`packages/compute-providers/src/daytona/register-daytona-snapshot.ts`); see
the setup-flow section below.

**Capabilities**:

- Create/destroy instances
- Command execution (session-based detached commands with real command IDs)
- Command-log streaming and lookup (`streamCommandOutput()` /
  `getCommandOutput()` via Daytona session command logs)
- File uploads
- Preview URLs per port via `sandbox.getPreviewLink(port)` (sandboxes are
  created with `public: true`)
- Does **not** support snapshots or snapshot resume; `SnapshotEnvironment` and
  `SnapshotResume` jobs are rejected with `NonRetryableSpawnError` at spawn
  time, and sleep-check always destroys Daytona machines instead of
  snapshotting them

**Configuration** (`DaytonaConfig`):

```typescript
{
  apiKey: string;        // DAYTONA_API_KEY
  apiUrl?: string;       // DAYTONA_API_URL (defaults to Daytona cloud)
  target?: string;       // DAYTONA_TARGET (region)
  snapshotName: string;  // DAYTONA_SNAPSHOT_NAME — worker base image snapshot
  timeoutMs?: number;    // job lifetime cap, mapped to autoStopInterval
}
```

Runtime notes:

- Detached commands run inside a Daytona process session with
  `runAsync: true`. The persisted `sandboxCmdId` is a composite
  `<sessionId>::<cmdId>` so later log reads can find the session again.
- Session commands do not accept per-command env or cwd, so the adapter
  inlines both into the shell command (`cd ... && env KEY=value ... cmd`).
- Like Modal, commands inject `HOME`/`USER`/`LOGNAME`/`PATH` for the
  `roomote` worker-image user so mise/pnpm tooling resolves regardless
  of the exec user.
- `timeoutMs` maps to Daytona's `autoStopInterval` (minutes) as a leak
  backstop; authoritative teardown is the sleep-check destroy path.
- Fresh boots reuse the shared bootstrap contract: upload
  `.docker/sandbox/*` allowlist files plus the worker tarball, then run
  `install-worker.sh` (`packages/compute-providers/src/daytona/create-daytona-machine.ts`).

### E2B

**Location**: `packages/compute-providers/src/adapters/e2b.ts`

Hosted execution target using the `e2b` SDK. Like Daytona, E2B was added for
its minimal customer onboarding: authentication is a single `E2B_API_KEY`, and
the worker base image is an E2B template built once from the Roomote worker
image (`E2B_TEMPLATE_ID`), so customers never manage per-task images. The
template is built from the published worker image by `buildE2bWorkerTemplate`
([`packages/compute-providers/src/e2b/build-e2b-template.ts`](../../packages/compute-providers/src/e2b/build-e2b-template.ts)),
shared with the setup flow.

**Capabilities**:

- Create/destroy instances
- Command execution (detached commands run as envd background processes)
- Command-log streaming and lookup (`streamCommandOutput()` /
  `getCommandOutput()` via per-command log files, see below)
- File uploads
- Preview URLs per port via `sandbox.getHost(port)` (E2B port hosts are
  `https://<port>-<sandboxId>.<domain>`)
- **Snapshots and snapshot resume**: `createSnapshot()` maps to E2B's sandbox
  snapshot API (`Sandbox.createSnapshot`), which builds a persistent snapshot
  template from the sandbox filesystem. E2B pauses the sandbox during the
  snapshot and leaves it paused, so the adapter kills the source sandbox
  afterward to match the shared snapshot-destroys-sandbox contract.
  `resumeFromSnapshot()` boots a new sandbox with the snapshot ID as the
  template (`Sandbox.create(snapshotId)`).

**Configuration** (`E2bConfig`):

```typescript
{
  apiKey: string;      // E2B_API_KEY
  domain?: string;     // E2B_DOMAIN (self-hosted clusters; defaults to E2B cloud)
  templateId: string;  // E2B_TEMPLATE_ID — worker base image template
  timeoutMs?: number;  // job lifetime cap, mapped to the sandbox timeout
}
```

Runtime notes:

- E2B has no provider-side persisted command logs, so detached commands wrap
  the real command in a shell that redirects stdout/stderr to per-command log
  files under `/tmp/roomote-commands/` and writes the exit code to a marker
  file on completion. The persisted `sandboxCmdId` is a composite
  `<pid>::<logId>`; log lookups read the files, and streaming tails them until
  the exit marker appears.
- E2B executes commands through `bash -l -c`, so login profiles can reset
  env-provided values; like Daytona, the adapter inlines
  `env HOME=... USER=... LOGNAME=... PATH=... <cmd>` into the command so the
  `roomote` worker-image user environment wins regardless of the exec
  user. The injected env also includes `MISE_DATA_DIR=/opt/mise` and
  `MISE_CACHE_DIR=/opt/mise/cache` because envd exec does not propagate the
  image's Docker `ENV` values, and mise shims cannot resolve installed tools
  without them.
- **E2B root-user tradeoff**: E2B forces its own `user` account (uid 1002) as
  the template default user, and that account cannot traverse the
  roomote-owned `0700` home where the mise binary lives. The adapter
  therefore passes `user: 'root'` on every command and file operation (the
  same tradeoff the Modal adapter documents for `sandbox.exec()`), keeping
  the injected `roomote` env so user-scoped tooling resolves.
- **`/sandbox` is stripped from base templates**: E2B's registry-image →
  template conversion removes the image's `/sandbox` directory (verified
  empirically — sibling paths from the same Dockerfile layer survive), so
  fresh E2B boots recreate `/sandbox` during bootstrap and
  `install-worker.sh` self-heals the missing `/sandbox/node_modules` on
  first boot. Sandbox **snapshots** created at runtime do preserve
  `/sandbox`, so environment- and task-snapshot launches keep the workspace
  and amortize the first-boot repair cost.
- `timeoutMs` maps to the E2B sandbox timeout as a leak backstop;
  authoritative teardown is the sleep-check pipeline.
- E2B rejects sandbox timeouts above the plan's lifetime cap (1 hour on
  Hobby, 24 hours on Pro) with a `400` at create time, so the controller
  clamps the provider-side timeout to `E2B_MAX_SANDBOX_TIMEOUT_MS`
  (default `3600000`, the Hobby ceiling) before spawning. Jobs whose
  Roomote timeout exceeds the ceiling still work: sleep-check's
  provider-timeout backstop reads the real remaining deadline from the
  provider and snapshots or winds the job down before E2B's hard limit.
  Raise the env value only when the E2B plan allows longer-lived sandboxes.
- Fresh boots and environment-snapshot resumes reuse the shared bootstrap
  contract: upload `.docker/sandbox/*` allowlist files plus the worker
  tarball, then run `install-worker.sh`; task snapshot resumes skip bootstrap
  entirely (`packages/compute-providers/src/e2b/create-e2b-machine.ts`).
- Sandbox `metadata` carries the shared `app_environment` /
  `organization_name` tags plus the worker release tag.
- E2B snapshots are persistent snapshot templates with no provider-side
  expiry, and the shared `ComputeProviderClient` interface has no snapshot
  deletion operation, so superseded E2B snapshots accumulate until an
  operator cleans them up in the E2B dashboard.

### Vercel Sandbox (Removed)

The Vercel Sandbox provider (`vendor = 'sandbox'`, the `@vercel/sandbox` SDK
adapter) has been **removed** from the codebase, along with its adapter
(`packages/compute-providers/src/adapters/roomote.ts`), the controller
spawn path (`spawn-sandbox-worker.ts`), `createSandbox()`, the sandbox worker
env builder, the `VERCEL_SANDBOX_ACCESS_TOKEN` /
`VERCEL_SANDBOX_BASE_IMAGE_SNAPSHOT_ID` env vars, the
`publish-roomote-image` skill, and its setup-catalog entry.

Operationally, existing deployments with historical `vendor = 'sandbox'`
cloud jobs can no longer stream logs from or tear down those machines — the
credentials and provider client are gone. Such rows are inert history; any
remote Vercel sandboxes left behind must be cleaned up in the Vercel
dashboard.

Several pieces of historically Vercel-shaped infrastructure are **kept**
because every hosted provider now shares them:

- the `/sandbox` worker filesystem layout (`SANDBOX_FILES_DIR`) and the
  `roomote` in-image user
- the shared sizing/timeout constants, now in
  `packages/types/src/compute-providers/worker-runtime.ts` (renamed from
  `roomote.ts`)
- the worker-release fetch/selection helpers under
  `packages/compute-providers/src/sandbox/`
- the `.docker/sandbox/*` bootstrap scripts, including `install-worker.sh`
- the worker runtime label `'sandbox'` in `WorkerRuntimeEnvironment`, now
  defined as "the shared hosted-sandbox filesystem layout" rather than a
  provider

### Fly.io (Legacy)

Fly.io support has been **removed** from the codebase. Historical context: it previously used persistent machines with volume mounts at `/data`.

## Compute Usage Accounting

For persisted telemetry fields, hidden provider-reported cost handling, and
provider-by-provider measurement notes, see
[Compute Provider Usage Accounting](./compute-provider-usage-accounting.md).

Roomote persists provider-specific compute usage rows in
`compute_provider_usage`. The accounting path now has two layers:

1. The worker writes periodic `running` updates on the same cadence as
   `workerHeartbeatAt`, giving Roomote a rolling approximation of the current
   job-owned compute segment even if teardown orchestration never reaches
   BullMQ.
2. BullMQ teardown paths (`snapshot.ts` and `sleep-check.ts`) write the final
   `snapshot` or `destroy` update after the provider confirms the instance has
   actually stopped.

Both paths upsert the same logical usage row per cloud-job/machine segment. The
final teardown update replaces the provisional `running` estimate instead of
adding a second billable row, and late `running` heartbeats are ignored once a
final teardown action has been recorded.

Provision and dispatch paths now also snapshot the effective provider resource
configuration onto `cloud_jobs` so later usage accounting reads the resources
that actually backed the job instead of re-reading ambient env in the worker or
BullMQ process.

Provider-specific measurement details:

- **Modal**: periodic worker updates now sample cgroup CPU and memory counters from inside the sandbox and persist those raw observations in `compute_provider_usage_samples`. The aggregate `compute_provider_usage` row summarizes the job-attributed segment for local observability; provider-reported costs are stored only when supplied by the provider/caller.

## Fresh Worker Spawning

Fresh worker spawning creates a new machine for each job unless that job is
resuming from an existing task snapshot. Each provider has its own controller
spawn helper under `apps/controller/src/compute-providers/`
(`spawn-docker-worker.ts`, `spawn-modal-worker.ts`, `spawn-daytona-worker.ts`,
`spawn-e2b-worker.ts`), and the hosted spawn helpers follow the same
high-level sequence:

1. Load environment config, named ports, and provider-specific environment
   snapshot state from DB
2. Resolve the launch mode:
   - `task_snapshot` when `cloudJob.type === SnapshotResume`
   - `fresh` when `cloudJob.type === SnapshotEnvironment`
   - `environment_snapshot` for other non-resume jobs when a ready environment
     snapshot exists (snapshot-capable providers only)
   - `fresh` otherwise
3. Create or resume the provider machine through the provider's create helper
   (`packages/compute-providers/src/{modal,daytona,e2b}/create-*-machine.ts`)
4. For fresh boots and environment-snapshot resumes, upload the
   `.docker/sandbox/*` allowlist files plus the selected worker release
   tarball and run `install-worker.sh` so the shipped worker/runtime is
   refreshed in place; task snapshot resumes skip bootstrap entirely
5. Update the `cloud_jobs` row with routing info and machine metadata
6. Execute the provider-specific worker command in detached mode and store
   `sandboxCmdId` for log retrieval

**Worker Commands by Job Type**:

- `SnapshotEnvironment`: `worker snapshot --cloud-job-id X --environment-id Y --sandbox-id Z`
- `SnapshotResume`: `worker resume ${cloudJobId}`
- All others: `worker run ${cloudJobId}`

All commands run with `detached: true` and must return a `commandId`.

Environment-snapshot launches are treated like cached base images: Roomote
keeps the snapshotted workspace and dependency state for speed, but still
refreshes the shipped worker/runtime before work begins. Task snapshot
launches preserve exact runtime state for task continuation.

For environment-backed workspaces, machine creation relies on the named preview ports declared in the environment config plus the system-managed `SANDBOX_SERVER` surface. Fresh worker releases bundle only the worker runtime; there is no separate desktop runtime, reserved browser-only port, or vendored viewer payload during bootstrap.

Modal intentionally does **not** rely on provider-side live startup-log
streaming, and Roomote no longer mirrors worker harness logs into
`cloud_jobs.log`. Startup surfaces therefore show phase/status progress for
Modal jobs without a live startup-log stream.

## Worker Release Distribution

Spawn helpers fetch the worker release archive from a local file in
development, or from GitHub via `getWorkerRelease()` when the controller is in
release mode. The fetch, cache, and selection helpers live under
`packages/compute-providers/src/sandbox/` (`worker-release-cache.ts`,
`worker-release-selection.ts`, and friends — the directory name refers to the
shared hosted-sandbox layout, not a provider).

Worker release selection has two channels:

- Stable releases use the `worker-v*` tag namespace and are the default for production.
- Preview releases use the `worker-preview-v*` tag namespace and are ignored by the stable selector.

When `DOCKER_WORKER_RELEASE_PATH` points hosted providers (Modal, E2B, Daytona)
at a local archive, `loadLocalWorkerReleaseWithVersion()` in
`packages/compute-providers/src/sandbox/utils.ts` resolves the worker version:
versioned filenames (`worker-v<version>.tar.gz`,
`worker-preview-v<version>.tar.gz`) resolve from the filename alone, and
version-less names such as the `worker-current.tar.gz` alias baked into the app
image fall back to the `VERSION` file that `build-worker-release.sh` packages
inside the archive. This lets Compose/PaaS deployments keep the static
`worker-current.tar.gz` default without bumping the env var in lockstep with
the pinned image tag.

When the controller is in release mode, `WORKER_RELEASE_CHANNEL` selects the channel and optional `WORKER_RELEASE_VERSION` pins an exact version within that channel. This is what lets local `pnpm dev --use-release --worker-release-channel preview --worker-release-version ...` exercise the real GitHub download path without making production eligible for preview artifacts.

Controller-side GitHub release reads now authenticate with a short-lived GitHub App installation token for `Roomote/Roomote` instead of a dedicated long-lived PAT. The token is minted from the existing Roomote GitHub App credentials, narrowed to `contents: read`, cached in memory until shortly before expiry, and then used for latest-version resolution, release lookup, and release asset downloads.

Production worker releases now ship only the Roomote worker archive. Fresh and
environment-snapshot launches upload `worker.tar.gz`, run
`install-worker.sh`, and rely on that archive plus the prebaked worker image
tooling rather than any separate harness payload or GitHub fallback.

## Machine Lifecycle Management

Roomote now treats machine lifecycle as strictly
job-scoped:

1. The controller selects the provider from `cloud_jobs.vendor`.
2. It chooses `fresh`, `environment_snapshot`, or `task_snapshot` launch mode.
3. It creates or resumes exactly one machine for the target job.
4. BullMQ snapshot or teardown paths later stop that machine and record final
   usage.

## Configuration and Selection Logic

### Provider Selection

**Controller** (`apps/controller/src/index.ts`):

- `RoomoteController` is the shared runtime entrypoint.
- The generic factory and provider-specific spawn helpers remain so a future
  provider can be added without changing higher-level controller flow.

Job execution flow:

1. Dequeue job from Redis queue
2. Spawn or resume the provider machine: `spawnWorker(job, token)`

### Setup-Flow Configuration and Credential Resolution

The admin `/setup` wizard includes a compute step pair after source control,
following the same choice-then-config pattern as source control:
`StepComputeProvider.tsx` (a provider button list where recommended hosted
providers carry a `Recommended` badge, and every provider is offered) and
`StepComputeConfig.tsx` (per-provider credential fields, a shared worker-image
field for hosted providers, and an advanced-infrastructure overrides area). The
choice persists via `setupNew.saveComputeProviderChoice` and the credentials
via `setupNew.saveComputeConfig`, which writes
`deployment_settings.runtime_compute_config` and encrypts submitted credentials,
infrastructure values, and the shared worker image into deployment environment
variables. The per-provider setup catalog (labels, snapshot support,
`recommended` flag, credential and infrastructure fields with `category` and
`advanced` metadata) lives in `packages/types/src/setup-compute-config.ts`.

Runtime credential resolution is process-env-first with a database fallback:

- `resolveComputeProviderEnvValues(provider)` in
  `packages/db/src/lib/compute-runtime-config.ts` resolves the catalog env
  vars for one provider, preferring `process.env` and falling back to the
  encrypted deployment env vars saved during setup.
- The controller's `spawnFreshWorker()` uses those resolved values for fresh
  launches.
- Callers without explicit config (BullMQ `snapshot.ts` / `sleep-check.ts`
  teardown paths and the API command-log handlers) pass the resolved values to
  `createComputeProviderClient()` through the factory's `envFallback` option,
  which is consulted after explicit `config` fields but before `process.env`.
  This keeps teardown and log reads working when credentials exist only in the
  database.
- Compute configuration can be supplied through env vars **or** the UI. Env
  vars stay supported and are the higher-precedence runtime override; the UI
  adds DB-backed configuration on top of that. Setup-catalog fields carry a
  `category` (`'credential'` | `'infrastructure'`) instead of the old
  `envOnly` flag, plus an `advanced` flag for provider-specific
  infrastructure. Use the `isComputeCredentialField()` /
  `isComputeInfrastructureField()` helpers rather than checking `category`
  inline.
  - **Credential fields** (Modal token pair, Daytona API key, E2B API key)
    are the primary inputs.
  - **Infrastructure fields** (`MODAL_BASE_IMAGE_REF`, `E2B_TEMPLATE_ID`,
    `E2B_DOMAIN`, `DAYTONA_SNAPSHOT_NAME`, `DAYTONA_API_URL`,
    `DAYTONA_TARGET`) are UI-editable advanced overrides. They are usually
    derived or provisioned automatically from the shared worker image, so
    they are surfaced behind an "advanced infrastructure" area rather than as
    primary inputs.
  - The **shared worker image** (`DOCKER_WORKER_IMAGE`) is configured once for
    the whole deployment. Hosted providers derive or provision their worker
    base image from it. `buildSetupComputeStatus()` returns a `workerImage`
    status (`runtimeSatisfied`, `savedSatisfied`, `hostedImageRef`,
    `hostedReady`) computed with the runtime precedence: process env wins,
    then a saved deployment env var (`resolveSavedWorkerImage()` in
    `packages/db/src/lib/compute-runtime-config.ts`), then the ref derived
    from the baked `RELEASE_VERSION`. Only a registry-qualified ref is
    hosted-ready; a bare local tag such as `roomote-worker:local` is not
    itself pullable by hosted providers. In local development, Modal still
    reports hosted-ready through its separate
    `ghcr.io/roocodeinc/roomote-worker:latest` base-image fallback.
- The provider picker no longer hides hosted providers when infrastructure is
  missing: every provider is offered. The compute config step shows the shared
  worker-image field for hosted providers when no registry-qualified worker
  image is available yet, and Docker stays credentials-free and needs no
  hosted worker image.
- Runtime env values lock their field in the UI and are never overwritten by a
  save. Otherwise the setup wizard and the Settings → Compute save commands
  persist submitted credentials, submitted infrastructure values, and the
  shared worker image as encrypted deployment env vars.
- For Modal, `MODAL_BASE_IMAGE_REF` is derived from the effective worker image
  by default (via `resolveDerivedModalBaseImageRef()`) and persisted when the
  operator did not enter it, is not env-provided, and is not already saved. The
  derived value that is persisted can come from an explicit `DOCKER_WORKER_IMAGE`,
  a saved shared worker image, or the ref derived from the baked
  `RELEASE_VERSION`; in local development, it can also come from the
  `ghcr.io/roocodeinc/roomote-worker:latest` fallback. Because a saved
  `MODAL_BASE_IMAGE_REF` then wins over a newly derivable one, a later upgrade
  that changes the release-derived worker image can leave Modal pinned to the
  previously saved ref until it is cleared or overridden through the advanced
  field. When `MODAL_BASE_IMAGE_REF` is not saved,
  `resolveComputeProviderEnvValues` derives it at runtime from the effective
  worker image (process env `DOCKER_WORKER_IMAGE`, then the saved shared worker
  image, then the `RELEASE_VERSION`-derived ref, then the development fallback),
  so a shared worker image saved after Modal credentials still resolves at
  spawn time regardless of save order.
- For E2B and Daytona, `E2B_TEMPLATE_ID` / `DAYTONA_SNAPSHOT_NAME` report
  `setupProvisionable` when a registry-qualified worker image exists. Saving
  credentials without a manual artifact starts a detached provisioning run in
  the operator's provider account (the E2B worker-template build or the
  Daytona snapshot registration, via `runComputeProvisioning` in
  `apps/web/src/trpc/commands/compute/compute-provisioning.ts`). Progress
  persists on `setupNewState.e2bTemplateBuild` /
  `setupNewState.daytonaSnapshotBuild`, the wizard polls the setup status
  until the artifact ref lands as an encrypted deployment env var, and a
  `building` entry older than ten minutes reads as failed so the operator can
  retry after a web-process restart. If the operator instead enters the
  artifact value manually in the advanced field, it is persisted directly and
  no provisioning runs. `setupProvisionable` counts toward
  `infrastructureSatisfied` but not `configSatisfied`, so setup cannot complete
  before the artifact actually exists. Daytona snapshot registration has no
  per-call registry credentials, so the worker image must be public or its
  registry configured in the Daytona organization.
- Registry auth (Modal ECR OIDC or registry username/password pairs),
  endpoints, and timeouts stay env-only and are not surfaced by the UI.

### Settings → Compute Page

Admins can also manage compute providers after setup at `/settings/compute`
(admin-only, mirroring the Settings → Communications pattern). The page is
`ComputeSettingsPage` → `ComputeProviders` / `ComputeProviderSection` in
`apps/web/src/components/settings/`, backed by the `compute` tRPC router
(`apps/web/src/trpc/commands/compute/index.ts`):

- `compute.status` returns `buildSetupComputeStatus()` over the runtime env,
  persisted deployment env var names, the persisted
  `deployment_settings.runtime_compute_config`, and the saved shared worker
  image, plus the deployment-wide `provisioning` map of per-provider worker
  base-image runs (stale in-flight runs presented as failed).
- The page has a shared "Hosted compute worker image" section above the
  provider sections (`ComputeWorkerImageSection`), backed by
  `compute.saveWorkerImage` / `compute.clearWorkerImage`. Each provider section
  (`ComputeProviderSection`) shows credential fields normally plus an "Advanced
  infrastructure" expandable area for that provider's infrastructure values.
- `compute.saveConfig` encrypts submitted account credentials, submitted
  provider-specific infrastructure values, and a submitted shared worker image
  into deployment env vars (with the same Modal base-image-ref derivation as
  the wizard), but unlike the wizard it does **not** switch the deployment
  default onto the provider and does not require missing infrastructure before
  saving credentials. Runtime env values are locked and never overwritten. For
  provisionable providers (E2B, Daytona) it behaves like the wizard: when no
  manual artifact value is entered, a registry-qualified worker image exists,
  and the required credentials are available, the save records the run as
  pending and starts the detached provisioning; entering the artifact manually
  persists it and skips provisioning. The logic is shared with the wizard via
  `apps/web/src/trpc/commands/compute/compute-provisioning.ts`.
- `compute.setDefaultProvider` persists
  `deployment_settings.runtime_compute_config.defaultProvider`, allowing hosted
  providers once their required credentials and infrastructure are satisfied by
  the runtime env, saved DB env vars, derived defaults, or completed
  provisioning (i.e. `configSatisfied`).
- `compute.clearConfig` deletes this provider's saved credential **and**
  provider-specific infrastructure deployment env vars (for Modal that includes
  `MODAL_BASE_IMAGE_REF`); it does not touch the shared `DOCKER_WORKER_IMAGE`,
  which is cleared from its own shared section via `compute.clearWorkerImage`.
  Clearing does not change the persisted default; the page warns when the
  effective default provider is missing configuration.

The shared persisted-config helpers (`getPersistedRuntimeComputeConfig` /
`savePersistedRuntimeComputeConfig`) live in the compute commands module and
are reused by the setup-new commands. Compute-managed env var names
(`COMPUTE_PROVIDER_ENV_VAR_NAMES` in
`packages/types/src/setup-compute-config.ts`) — credentials, provider-specific
infrastructure fields, and the shared `DOCKER_WORKER_IMAGE` — are reserved:
they are hidden from the generic environment-variables editor and cannot be
created there, since they are managed through the compute UI (or the deployment
env).

### Snapshot Handling

**Environment Snapshots**:

- Created via `SnapshotEnvironment` jobs
- Stored as provider-keyed rows in `environment_snapshots` (`provider`,
  `snapshotId`, `snapshotExpiresAt` — Roomote expiry bookkeeping is 7 days).
  The legacy `environments.snapshotId`/`snapshotStatus`/... columns (the
  pre-`environment_snapshots` Vercel-era mirror) are no longer read or
  written; `environment_snapshots` rows are the only source of truth. The
  `legacy_sandbox_row` attachment source is retained in the zod schema only
  to parse old rows — it is never produced and no longer re-attachable.
- Used for:
  - environment-backed task launches (boot from snapshot, then refresh worker/runtime)
  - `SnapshotResume` jobs (restore exact workspace state)
- Snapshot creation **destroys** the source machine
- The daily `refreshSnapshotsJob` scheduler recreates ready environment snapshots at least once per day, skips environments that already have a refresh in flight, and only swaps in the replacement snapshot after creation succeeds

## Key Files Reference

### Core Abstractions

- `packages/compute-providers/src/types.ts` - Interface definitions
- `packages/compute-providers/src/factory.ts` - Provider factory
- `packages/compute-providers/src/errors.ts` - Error utilities
- `packages/types/src/setup-compute-config.ts` - Setup catalog + setup status builder
- `packages/types/src/compute-providers/compute-provider.ts` - Provider ids, capability lists, worker runtime paths
- `packages/types/src/compute-providers/worker-runtime.ts` - Shared sizing/timeout constants and `SANDBOX_FILES_DIR`
- `packages/db/src/lib/compute-runtime-config.ts` - Persisted default provider + credential resolution
- `packages/compute-providers/src/environment-machine.ts` - Provider-neutral machine metadata helpers

### Provider Implementations

- `packages/compute-providers/src/adapters/docker.ts` - Docker client
- `packages/compute-providers/src/adapters/modal.ts` - Modal client
- `packages/compute-providers/src/adapters/daytona.ts` - Daytona client
- `packages/compute-providers/src/adapters/e2b.ts` - E2B client

### Worker Spawning

- `apps/controller/src/compute-providers/spawn-docker-worker.ts` - Fresh Docker spawn
- `apps/controller/src/compute-providers/spawn-modal-worker.ts` - Fresh Modal spawn
- `apps/controller/src/compute-providers/spawn-daytona-worker.ts` - Fresh Daytona spawn
- `apps/controller/src/compute-providers/spawn-e2b-worker.ts` - Fresh E2B spawn
- `packages/compute-providers/src/modal/create-modal-machine.ts` - Modal machine creation logic
- `packages/compute-providers/src/daytona/create-daytona-machine.ts` - Daytona machine creation logic
- `packages/compute-providers/src/e2b/create-e2b-machine.ts` - E2B machine creation logic

### Environment Builders

- `packages/compute-providers/src/worker-env/` - Per-provider worker env builders (`modal.ts`, `daytona.ts`, `e2b.ts`, `docker.ts`, shared `base.ts`)

### Utilities

- `packages/compute-providers/src/sandbox/utils.ts` - Worker version checking
- `packages/compute-providers/src/sandbox/worker-release-cache.ts` - GitHub release fetcher
- `packages/compute-providers/src/sandbox/worker-release-selection.ts` - Release channel/version selection
- `packages/compute-providers/src/sandbox/bootstrap-files.ts` - `.docker/sandbox` bootstrap allowlist
