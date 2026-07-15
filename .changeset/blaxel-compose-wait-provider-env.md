---
'@roomote/web': patch
---

Blaxel Docker projects no longer pass the unsupported Compose `--wait` flag: the provider check now reads the worker's process environment, where the compute provider is actually set.
