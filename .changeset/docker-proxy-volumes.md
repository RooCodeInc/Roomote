---
'@roomote/web': patch
---

Allow the production Docker socket proxy to create and remove managed task workspace volumes so Compose-based deployments can provision workers without 403 volume API failures.
