---
"@roomote/web": patch
---

The web process now hands off in-flight Fast Session turns when it receives SIGTERM, the same way the API and bullmq services do. Turns get a bounded window to finish, and stragglers are aborted with their durable claim released and the conversation lock deleted, so a successor process resumes them instead of the next reply stalling for the 10-minute lock and 15-minute claim leases after a web redeploy.
