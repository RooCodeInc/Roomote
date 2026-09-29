---
'@roomote/worker': patch
---

Communication follow-ups that need to be requeued after a delivery failure now use the run-scoped SDK instead of requiring Redis access inside the worker sandbox.
