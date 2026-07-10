# Controller Guidance

This guidance applies to `apps/controller` and its descendants.

`apps/controller` is Roomote's worker-dispatch control plane. It owns dequeue,
fresh worker launches, orphan recovery, and worker handoff. It is not the
place for prompt policy or product-surface behavior.

## Dos

- Think in terms of lifecycle consistency across Redis queue state,
  `task_runs` rows, and provider machine state.
- Preserve bounded retries, timeout envelopes, and orphan-recovery behavior
  when changing dispatch loops or spawn paths.
- Keep provider-neutral orchestration in `BaseController` and put
  provider-specific behavior behind compute-provider helpers or adapters.
- Update status transitions, timestamps, lifecycle events, and cleanup paths
  together when dispatch behavior changes.
- Keep auth-bypass and worker-env propagation aligned across
  sandbox and Modal paths.

## Don'ts

- Do not put prompt logic, routing decisions, or product policy in the
  controller.
- Do not change fresh-spawn and orphan-recovery paths independently when they
  are supposed to preserve the same lifecycle contract.
- Do not bypass shared queue or machine-update helpers unless the
  abstraction truly cannot express the change.
- Do not assume Redis, database state, and provider runtime state are perfectly
  synchronized; expect drift and partial failure.
