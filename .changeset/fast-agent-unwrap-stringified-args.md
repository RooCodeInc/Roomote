---
"@roomote/web": patch
---

Fast sessions now honor explicit time bounds on chat history reads when the model wraps the tool arguments in a stringified `args` field instead of passing them at the top level. Previously the wrapper was dropped and the default 24-hour window applied.
