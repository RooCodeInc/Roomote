---
'@roomote/web': patch
---

Fix an Azure Container Apps Sandboxes sleep/wake loop where waking a suspended task repeatedly died on "waking up" and sandboxes never stayed suspended. Workers revived from a suspended sandbox now terminate themselves once the server reports their run as finalized (instead of idling as zombies holding the sandbox-server port), resume launches reap leftover workers before booting the new one, retained standby sandboxes found Running are re-suspended automatically, runs whose sandboxes were deleted are finalized instead of retried forever, and sandbox ports use Manual activation so inbound traffic no longer wakes sandboxes out-of-band.
