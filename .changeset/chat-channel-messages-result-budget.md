---
"@roomote/web": patch
---

Chat channel history results are now bounded to the newest messages that fit a fixed size, with a note telling the agent how to page further back, instead of being cut mid-JSON by the agent's output limit.
