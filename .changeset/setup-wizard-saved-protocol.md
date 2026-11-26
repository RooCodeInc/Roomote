---
'@roomote/web': patch
---

First-run setup now keeps the saved API protocol when you pick an existing OpenAI-compatible connection, and its tool-call check uses the protocol you select. Previously the step could reset a Responses API connection to Chat Completions or block Continue after switching protocols.
