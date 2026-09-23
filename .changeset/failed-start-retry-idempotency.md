---
'@roomote/cloud-agents': patch
'@roomote/controller': patch
---

Retrying a task that failed to start no longer fails with a raw "Failed query" error when the task was launched from a Session. The retry run now drops the original launch's idempotency key, as it already did for Discord source events. When a run with integration keys is refused at startup, the error now says why (the control plane failed, the keys were revoked or expired, the Session changed, or the compute provider can't receive keys) instead of always reading "Credential egress admission is no longer eligible".
