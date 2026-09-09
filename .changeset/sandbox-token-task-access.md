---
'@roomote/web': patch
---

Require access to the underlying task before issuing a sandbox run token, preventing members from minting tokens for another owner's restricted automation tasks. Ordinary task collaboration and owner/admin access are preserved; already-issued tokens are not revoked.
