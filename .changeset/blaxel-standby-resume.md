---
'@roomote/web': minor
---

Blaxel tasks support native standby resume: idle sandboxes stay retained for seven days with the worker stopped, and follow-up work reconnects to the same instance with refreshed TTLs and preview URLs instead of always spinning a fresh environment. Resume uses the worker-resume path and recreates conflicted preview endpoints so retained sandboxes come back cleanly after standby.
