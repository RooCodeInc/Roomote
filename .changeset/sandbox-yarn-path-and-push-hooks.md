---
'@roomote/worker': patch
'@roomote/cloud-agents': patch
---

Put yarn on the sandbox PATH during worker setup so repositories whose hooks shell out to yarn no longer fail with `yarn: not found`. Delivery skills now skip local pre-push hooks, which re-run full suites against tooling the sandbox does not have, and in exchange require the agent to review the outgoing diff for secrets before every push and to distinguish hook failures from authentication failures when a push is rejected.
