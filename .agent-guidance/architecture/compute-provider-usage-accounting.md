---
title: Compute Provider Usage Accounting
status: active
last_reviewed: 2026-07-03
owner: engineering
summary: How Roomote records compute-provider telemetry for Docker, Modal, Daytona, and E2B without turning it into billing or quota enforcement.
---

# Compute Provider Usage Accounting

Roomote records compute-provider usage as local observability for self-hosted
operators. The data helps debug task runtime, provider lifecycle, resource
pressure, and teardown behavior. It is not a pricing, quota, invoice, or
commercial-control system.

For the broader runtime and adapter overview, see
[Compute Providers](./compute-providers.md). For the end-to-end job lifecycle,
see [Cloud Job Execution Architecture](./cloud-job-execution.md).

## Goals

- Persist a durable compute usage row even if the worker dies before teardown.
- Keep task-level `computeDurationMs` available for history and debugging.
- Preserve resource telemetry such as configured CPU/memory, wall-clock
  duration, active CPU duration, network measurements, memory samples, lifecycle
  action, timestamps, and measurement source.
- Avoid blocking task execution, follow-up, teardown, or resume on usage
  reporting success.

## Non-Goals

- Estimating local prices or provider invoices.
- Enforcing plan limits, spend thresholds, or quotas.
- Showing compute costs in the product UI or public task APIs.
- Using compute telemetry to stop or reject tasks.

## Persistence Path

Roomote records compute usage in two stages for the same logical
cloud-job/machine segment:

```text
worker heartbeat
  -> sdk.cloudJobs.recordComputeProviderUsage(lifecycleAction='running')
  -> provisional compute_provider_usage row
  -> compute_provider_usage_samples inserts when worker-visible cgroup samples exist

BullMQ teardown
  -> recordComputeProviderUsage(lifecycleAction='snapshot' | 'destroy')
  -> final upsert over the same row
  -> tasks.computeDurationMs rollup refresh
```

Key implementation points:

- Worker-side provisional updates are sent from
  `apps/worker/src/run-task/polling/compute-provider-usage.ts`.
- BullMQ final updates are sent from
  `apps/bullmq/src/compute-provider-usage.ts` and the teardown jobs that call
  it.
- Server-side normalization, upsert, and task duration rollups live in
  `packages/sdk/src/server/lib/cloud-jobs/record-compute-provider-usage.ts`.
- Sample persistence and aggregation live in
  `packages/sdk/src/server/lib/cloud-jobs/compute-provider-usage-samples.ts`.
- Neutral compute usage enums and default resource resolution live in
  `packages/types/src/compute-provider-usage.ts`.

## Stored Telemetry

Each `compute_provider_usage` row stores provider, cloud job, task, machine
identifier, launch mode, lifecycle action, measurement source, configured
resources, wall-clock duration, optional provider measurements, timestamps, and
diagnostic `details`.

For cgroup-sampled providers, Roomote also stores raw worker-heartbeat
observations in `compute_provider_usage_samples`. Those rows hold the sampled
timestamp plus the current cgroup counters the worker could see:

- cumulative CPU nanoseconds
- current memory bytes
- peak memory bytes

Important rules:

- There is one logical row per `provider + cloudJobId + machineId`.
- Late `running` heartbeats do not overwrite a later final `snapshot` or
  `destroy` update.
- Later updates preserve previously observed non-null provider metrics such as
  final CPU/network counters instead of nulling them back out.
- Task duration rollups are refreshed only on final lifecycle actions.
  Provisional `running` writes update `compute_provider_usage` for resilience,
  but they do not churn task aggregates on every worker heartbeat.

## Provider Notes

Docker-backed jobs are local or single-host self-host executions. Roomote
records them for lifecycle visibility with the `roomote_observation`
measurement source.

Modal jobs store the provision-time requested resources from `cloud_jobs` and
use `modal_requested_resources` when no cgroup samples exist. When worker
cgroup samples exist, the final row uses `modal_cgroup_samples` and stores
sample counts, last-sampled timestamps, and peak memory details for debugging.

The `vercel_sdk_metrics` measurement source belongs to the removed Vercel
Sandbox provider. It remains in the measurement-source enum only so historical
rows still parse; no new rows are written with it.

## Operator Notes

Compute usage persistence is best-effort. Failed usage writes should be logged
for investigation but must not reject prompts, cancel workers, block teardown,
or prevent follow-up/resume flows. Historical resource telemetry may be useful
for debugging local deployments, and hidden provider-reported cost may be useful
for operators, but neither must be interpreted as a commercial or quota ledger.
