---
'@roomote/sdk': patch
'@roomote/api': patch
---

Fix `/health/bullmq` reporting every deployment unhealthy: the overdue queued-event count bound a Date inside a raw SQL fragment, which Postgres rejected, so the check failed on every probe since 1.9.3.
