---
'@roomote/worker': patch
'@roomote/sdk': patch
---

Report the default branch the worker resolves from `origin/HEAD` back to the control plane so stale stored repository metadata self-heals instead of persisting until a manual installation resync.
