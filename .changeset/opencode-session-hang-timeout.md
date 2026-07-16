---
'@roomote/web': patch
---

Tasks no longer hang forever when OpenCode session creation never returns; the run fails closed with diagnostics instead of waiting indefinitely.
