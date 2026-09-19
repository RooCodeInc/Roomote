---
'@roomote/web': patch
---

A task run whose worker never started is now failed instead of staying in a booting status indefinitely. Its sandbox is destroyed, the Session gets the normal task-settled notice, and `/health/controller` stops reporting it as stuck after dequeue.
