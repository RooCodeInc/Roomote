---
'@roomote/web': patch
---

Keep self-hosted Docker task runs alive past SleepCheck by giving bullmq Docker socket-proxy access and refusing to treat daemon disconnects as dead workers.
