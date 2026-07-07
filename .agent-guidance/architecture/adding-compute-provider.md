---
title: Adding a Compute Provider
status: active
last_reviewed: 2026-07-03
owner: engineering
summary: End-to-end guide for adding a new sandbox-compatible compute provider, including controller wiring, snapshots, and pnpm dev integration.
---

# Adding a Compute Provider

Roomote already ships four built-in compute providers: **Docker** for local
development, plus hosted **Modal**, **Daytona**, and
**E2B**. The controller/runtime stack supports mixed-provider dispatch in the
main product path. This guide documents the full set of changes needed to add
another compute provider without forking the worker runtime contract
unnecessarily.

Daytona is the most recent example of a non-snapshot hosted provider and is a
good template for a minimal addition: adapter + factory branch, a fresh-only
machine helper (`packages/compute-providers/src/daytona/`), a spawn function
that rejects snapshot job types with `NonRetryableSpawnError`, membership in
`sleepCheckManagedComputeProviders` (but not
`snapshotCapableComputeProviders`) so sleep-check destroys its machines, and
the exhaustive-Record updates listed below.

Modal and E2B are the two snapshot-capable hosted providers to copy from. E2B
is the most recent example of a full snapshot-capable hosted provider and
is a smaller template than Modal for that shape: adapter with
`createSnapshot`/`resumeFromSnapshot`, a machine helper with
`fresh`/`environment_snapshot`/`task_snapshot` launch modes
(`packages/compute-providers/src/e2b/`), and membership in
`snapshotCapableComputeProviders`. E2B additionally shows the pattern for
providers without persisted command logs: detached commands redirect output
to per-command log files inside the sandbox so command-log lookups and
streaming still work after process exit.

For the current architecture, see
[Compute Providers](./compute-providers.md) and
[Cloud Job Execution Architecture](./cloud-job-execution.md).

## Start With the Runtime Contract

This guide assumes the new provider can satisfy the same worker runtime
contract Roomote uses for hosted providers today:

- ephemeral Linux instances with routable ports
- detached `worker ...` commands that return a command ID
- streamed command output for job logs
- file upload/write support for the worker release archive and sandbox
  bootstrap files
- snapshot and resume support if you want hosted-provider feature parity

If the provider cannot support that contract, stop and design a new worker
runtime contract first. The worker process still assumes the sandbox filesystem
layout defined in
[`packages/types/src/compute-providers/compute-provider.ts`](../../packages/types/src/compute-providers/compute-provider.ts)
and bootstrapped by
[`.docker/sandbox/install-worker.sh`](../../.docker/sandbox/install-worker.sh).

## Current Touchpoints

| Layer                  | Primary files                                                                                                                                                                                                                                                                                                                                                                                                                                | What changes when you add a provider                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Shared provider IDs    | [`packages/types/src/compute-providers/compute-provider.ts`](../../packages/types/src/compute-providers/compute-provider.ts), [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts)                                                                                                                                                                                                                                                 | Add the provider name and audit typed `vendor` / `computeProvider` usages           |
| Compute client factory | [`packages/compute-providers/src/types.ts`](../../packages/compute-providers/src/types.ts), [`packages/compute-providers/src/factory.ts`](../../packages/compute-providers/src/factory.ts), [`packages/compute-providers/src/adapters/`](../../packages/compute-providers/src/adapters)                                                                                                                                                      | Add config, client implementation, and factory branch                               |
| Fresh spawn path       | [`apps/controller/src/RoomoteController.ts`](../../apps/controller/src/RoomoteController.ts), [`apps/controller/src/compute-providers/spawn-modal-worker.ts`](../../apps/controller/src/compute-providers/spawn-modal-worker.ts), [`packages/compute-providers/src/modal/create-modal-machine.ts`](../../packages/compute-providers/src/modal/create-modal-machine.ts)                                                                       | Add provider-specific spawning or extend the mixed-controller dispatch              |
| Worker env             | [`packages/compute-providers/src/worker-env/`](../../packages/compute-providers/src/worker-env)                                                                                                                                                                                                                                                                                                                                              | Add a provider-specific env builder on top of the shared `base.ts` helper           |
| Snapshot and logs      | [`apps/bullmq/src/jobs/snapshot.ts`](../../apps/bullmq/src/jobs/snapshot.ts), [`apps/bullmq/src/scheduled-jobs/sleep-check.ts`](../../apps/bullmq/src/scheduled-jobs/sleep-check.ts), [`apps/web/src/app/api/cloud-jobs/[id]/logs/route.ts`](../../apps/web/src/app/api/cloud-jobs/%5Bid%5D/logs/route.ts), [`apps/worker/src/run-task/wait-for-external-sleep-action.ts`](../../apps/worker/src/run-task/wait-for-external-sleep-action.ts) | Route snapshot/log logic through the new provider and gate unsupported capabilities |
| Local dev              | [`apps/dev/src/index.ts`](../../apps/dev/src/index.ts), [`apps/dev/src/types.ts`](../../apps/dev/src/types.ts), [`apps/dev/src/services/pm2.ts`](../../apps/dev/src/services/pm2.ts), [`ecosystem.config.js`](../../ecosystem.config.js)                                                                                                                                                                                                     | Reintroduce explicit provider selection in `pnpm dev` and PM2 env                   |

## Recommended Sequence

### 1. Add the Provider Name to Shared Types

Start by extending the provider union in
[`packages/types/src/compute-providers/compute-provider.ts`](../../packages/types/src/compute-providers/compute-provider.ts).
That one type flows into:

- `cloudJobs.vendor` in
  [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts)
- snapshot/log defaults such as `cloudJob.vendor ?? 'docker'` and the
  `resolveComputeProviderTarget()` fallback (also `docker`)

The DB columns are stored as `text`, so you usually do **not** need a schema
migration just to add a new provider string. You do need to update TypeScript
unions, factories, tests, and any code that hard-codes a provider string.

### 2. Implement the Provider Client and Factory Branch

Add a new adapter in
[`packages/compute-providers/src/adapters/`](../../packages/compute-providers/src/adapters)
that implements `ComputeProviderClient`.

Then update:

- [`packages/compute-providers/src/types.ts`](../../packages/compute-providers/src/types.ts)
  to add the provider-specific config type and extend
  `ComputeProviderFactoryOptions`
- [`packages/compute-providers/src/adapters/index.ts`](../../packages/compute-providers/src/adapters/index.ts)
  to export the new client
- [`packages/compute-providers/src/factory.ts`](../../packages/compute-providers/src/factory.ts)
  to instantiate the correct client

Use
[`packages/compute-providers/src/__tests__/adapters.contract.test.ts`](../../packages/compute-providers/src/__tests__/adapters.contract.test.ts)
as the minimum contract test. A new provider should prove the same operations
Roomote depends on today:

- `createInstance`
- `destroyInstance`
- `runCommand`
- `streamCommandOutput`
- `createSnapshot`
- `resumeFromSnapshot`
- `listInstances`
- `getInstanceStatus`

If the provider lacks one of those operations, expose that honestly through
`capabilities` and update downstream callers before you ship it.

### 3. Decide Whether to Reuse or Generalize the Sandbox Runtime Helpers

Today the fresh-boot and resume path is per-provider machine helpers on top of
a shared hosted-sandbox runtime contract:

- [`packages/compute-providers/src/modal/create-modal-machine.ts`](../../packages/compute-providers/src/modal/create-modal-machine.ts) / [`packages/compute-providers/src/e2b/create-e2b-machine.ts`](../../packages/compute-providers/src/e2b/create-e2b-machine.ts)
- [`apps/controller/src/compute-providers/spawn-modal-worker.ts`](../../apps/controller/src/compute-providers/spawn-modal-worker.ts) and siblings
- [`packages/compute-providers/src/worker-env/`](../../packages/compute-providers/src/worker-env) builders over the shared `base.ts`

If the new backend is genuinely compatible with that shared hosted-sandbox
runtime contract, prefer keeping the contract and extracting any
provider-specific parts behind a neutral interface. In practice, that means:

- keep using the worker release archive in `./releases`
- keep using the same `/sandbox` bootstrap layout
- keep using [`.docker/sandbox/install-worker.sh`](../../.docker/sandbox/install-worker.sh)
  for worker-archive extraction and the minimal `worker` launcher path unless
  the runtime contract truly changes

Do **not** introduce provider-specific filesystem layouts or volume semantics
just to get a new provider working.

### 4. Wire the Controller End to End

Roomote is intentionally simplified right now:

- [`apps/controller/src/index.ts`](../../apps/controller/src/index.ts)
  instantiates `RoomoteController`
- [`apps/controller/src/RoomoteController.ts`](../../apps/controller/src/RoomoteController.ts)
  owns mixed-provider launch wiring

Adding a second provider now means extending the shared dispatch rules. The
cleanest path is:

1. Keep the mixed controller branching on `cloudJobs.vendor`.
2. Make sure every launch path persists the provider via `cloudJobs.vendor`.
3. Only use explicit controller env vars for local/dev bootstrapping concerns,
   not as the primary runtime selector for queued jobs.

The current fresh-spawn path persists machine routing via
[`apps/controller/src/utils.ts`](../../apps/controller/src/utils.ts), so the
new provider needs to keep that contract intact for the UI, preview proxy, and
snapshot jobs.

### 5. Update Snapshot, Resume, and Log Streaming Surfaces

The provider abstraction reaches farther than the controller. Audit these
surfaces before calling the work done:

- [`apps/bullmq/src/jobs/snapshot.ts`](../../apps/bullmq/src/jobs/snapshot.ts)
  uses `cloudJob.vendor` to choose a provider client for snapshot creation. Its snapshot-reconcile recovery path is gated on the optional `findSnapshotBySourceInstance` client capability; providers that can list snapshots by source instance may implement it to recover in-progress snapshots after a retry, and providers that cannot simply omit it (no current provider implements it)
- [`apps/bullmq/src/scheduled-jobs/sleep-check.ts`](../../apps/bullmq/src/scheduled-jobs/sleep-check.ts)
  processes providers in `sleepCheckManagedComputeProviders`; it snapshots resumable jobs on snapshot-capable providers and destroys everything else (including all jobs on non-snapshot providers such as `daytona`). The candidate queries are backed by partial indexes in `packages/db/src/schema.ts` whose predicates hardcode the managed vendor list, so adding (or removing) a provider there needs a matching index migration — most recently `0021_bumpy_the_santerians.sql`, which dropped the retired `sandbox` vendor from the three sleep-check partial-index predicates
- [`apps/web/src/app/api/cloud-jobs/[id]/logs/route.ts`](../../apps/web/src/app/api/cloud-jobs/%5Bid%5D/logs/route.ts)
  streams command output through the provider client
- [`apps/worker/src/run-task/wait-for-external-sleep-action.ts`](../../apps/worker/src/run-task/wait-for-external-sleep-action.ts)
  keeps sandbox jobs alive long enough for BullMQ to claim the due sleep action

If the new provider supports snapshots and log streaming, extend these flows.
If it does not, gate the behavior explicitly through provider capabilities
instead of letting generic code fail later.

### 6. Integrate With `pnpm dev`

`pnpm dev` has no per-provider CLI selection today; it follows the
`DEFAULT_COMPUTE_PROVIDER` env value (Docker by default, which also triggers
the local worker image build). That is a deliberate simplification,
not an accident. If the new provider also needs first-class local development
support, reintroduce selection on purpose in:

- [`apps/dev/src/types.ts`](../../apps/dev/src/types.ts)
- [`apps/dev/src/index.ts`](../../apps/dev/src/index.ts)
- [`apps/dev/src/services/pm2.ts`](../../apps/dev/src/services/pm2.ts)
- [`ecosystem.config.js`](../../ecosystem.config.js)

Recommended shape:

1. Add a `--compute-provider <name>` option to `pnpm dev`.
2. Pass that through PM2 as `DEV_COMPUTE_PROVIDER` or `COMPUTE_PROVIDER`.
3. Make the controller read that env var and choose the matching controller.
4. Keep the default artifact directory as `./releases`.
5. Keep the existing worker release build/watch model whenever the new provider
   still consumes the same sandbox-compatible runtime contract.

The current worker build path in
[`apps/dev/src/services/worker-release.ts`](../../apps/dev/src/services/worker-release.ts)
should remain shared unless the new provider genuinely requires different
artifacts.

The current PM2 env model in
[`apps/dev/src/services/pm2.ts`](../../apps/dev/src/services/pm2.ts) and
[`ecosystem.config.js`](../../ecosystem.config.js) also assumes the sandboxed
worker still calls back into local services through ngrok. If the new provider
still behaves like a remote sandbox, keep that callback model instead of
special-casing local-only behavior.

### 7. Keep the Launch Model Job-Scoped

Roomote now launches one provider machine per job. When adding a provider:

- route fresh launches through the mixed controller
- decide whether the provider supports environment snapshots, task snapshots, or both
- reuse the shared auth-bypass and preview-surface bookkeeping instead of
  introducing provider-local warm-pool state

### 8. Validate the Change Like a New Runtime, Not a Refactor

Minimum validation:

```bash
pnpm --filter @roomote/types check-types
pnpm --filter @roomote/compute-providers check-types
pnpm --filter @roomote/controller check-types
pnpm --filter @roomote/dev check-types

pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/controller exec vitest run src/__tests__/BaseController.test.ts src/__tests__/RoomoteController.test.ts
pnpm --filter @roomote/compute-providers exec vitest run src/__tests__/adapters.contract.test.ts
pnpm --filter @roomote/dev exec vitest run src/services/__tests__/worker-release.test.ts src/services/__tests__/worker-release-watcher.test.ts
```

Before merging, run:

```bash
pnpm test
```

For a provider that is wired into local development, also do a real
`pnpm dev` smoke test and verify:

- the controller chooses the new provider
- PM2 starts the expected watchers and service set
- the worker boots, connects back, and streams logs
- snapshot flows behave as expected for that provider

## Documentation Checklist

When you add the provider, update the docs in the same change:

- [Compute Providers](./compute-providers.md) for the architecture and
  supported capabilities
- [Cloud Job Execution Architecture](./cloud-job-execution.md) for the runtime
  dispatch path
- [Dev CLI](../operations/dev-cli.md) if `pnpm dev` behavior or flags change
- [Environment Management](../features/environment-management.md) if snapshots,
  environment launch behavior, or preview routing behavior changes
- [Deployment & Release](../operations/deployment.md) if new release artifacts
  or secrets are introduced

## Recommended Principle

Add the provider by extending the **sandbox-compatible** contract, not by
reintroducing special-case local runtime behavior. The closer the new backend
looks to today's Modal and E2B flows, the less code Roomote needs to fork in
the controller, worker bootstrap, and `pnpm dev`.
