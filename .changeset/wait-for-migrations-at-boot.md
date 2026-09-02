---
'@roomote/web': patch
---

Fixed the bullmq and controller services crashing during upgrades when they started before the database migration finished. On platforms that roll every service at once, a boot that reads a column the pending migration adds could exhaust the restart budget within seconds and stay down until someone redeployed it; both services now wait for the migration to land and then start normally.
