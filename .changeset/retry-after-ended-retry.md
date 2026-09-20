---
'@roomote/web': patch
---

Retrying a failed sandbox start now starts a new attempt when an earlier retry of that run was canceled or failed. Previously the ended retry was returned as the result and nothing new was started.
