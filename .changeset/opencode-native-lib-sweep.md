---
'@roomote/cloud-agents': patch
---

Background services no longer fill their container disk with native libraries left behind by each OpenCode helper server, which could get them evicted by the hosting platform.
