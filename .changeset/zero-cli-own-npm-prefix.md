---
'@roomote/worker': patch
---

Enabling the Zero integration no longer breaks later tasks by pruning sandbox runtime packages. The Zero CLI install uses its own npm prefix instead of reifying into `/sandbox/node_modules`, so shared tools such as `opencode` stay available when Zero is turned on.
