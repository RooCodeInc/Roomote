---
'@roomote/api': patch
'@roomote/cloud-agents': patch
'@roomote/worker': patch
---

Give Fast Sessions the GitHub access a coding task has. A signed-in member can now use any GitHub tool, under one cached installation token that reaches only the connected repositories. Searches pass through with GitHub's own query syntax, `org:` and `repo:` qualifiers pick the right installation, and reads no longer have to name a repository. Calls no longer fail with `invalid session`, including `create_gist`: the GitHub proxy stopped carrying MCP sessions, which GitHub does not need. `create_gist` is offered only to members with a linked GitHub account. Coding tasks stay read-only on this tool path and keep writing through their own checkout.
