---
'@roomote/api': patch
'@roomote/bullmq': patch
'@roomote/cloud-agents': patch
'@roomote/db': patch
'@roomote/sdk': patch
---

Persist accepted pull request review events before association lookup, serialize
event/association races with one PR-scoped database lock, and make leased
Postgres deliveries the only notification ownership state. BullMQ now only
wakes due deliveries, while N-1 Redis-owned jobs are converted through a
read-only compatibility path.
