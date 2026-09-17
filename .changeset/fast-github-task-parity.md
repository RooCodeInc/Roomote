---
'@roomote/api': patch
'@roomote/cloud-agents': patch
'@roomote/worker': patch
---

Give Fast Sessions the same repository access a coding task has. A signed-in member can use GitHub repository tools under one cached installation token that reaches only the connected repositories. Searches pass through with GitHub's own query syntax, `org:` and `repo:` qualifiers pick the right installation, and reads no longer have to name a repository. Calls routed across installations no longer fail with `invalid session` because the GitHub proxy does not carry MCP sessions upstream. Coding tasks stay read-only on this tool path and keep writing through their own checkout.
