---
'@roomote/web': patch
---

Session events that cannot be delivered no longer retry indefinitely. An event whose model call fails for a configuration reason (rejected credentials, no credits, an unavailable model) is settled at once and the Session is told once; other failures retry with backoff and are abandoned after a bounded number of attempts. `/health/bullmq` no longer reports the worker unhealthy for events it attempted and could not deliver.
