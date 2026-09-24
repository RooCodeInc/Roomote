---
'@roomote/web': patch
---

Sessions no longer ask the judgment model for an environment routing hint on their first request. The session agent already chooses the environment from the configured environments, their repositories, and the routing rules, as it does on deployments without a judgment model.
