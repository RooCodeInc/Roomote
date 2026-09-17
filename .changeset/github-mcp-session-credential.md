---
'@roomote/types': patch
'@roomote/cloud-agents': patch
'@roomote/api': patch
---

Fix Fast Session GitHub calls failing with `invalid session`: the MCP client now announces the tool it is about to call on every request of its handshake, so the GitHub proxy opens the session under the same credential the call will use (the linked account for `create_gist`, the target repository's installation for reads and writes).
