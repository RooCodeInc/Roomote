---
'@roomote/web': patch
---

Sessions and tasks now stop immediately, and name the model, when a provider streams a response the bundled OpenCode SDK cannot parse (for example native Amazon Bedrock models that return redacted reasoning). Previously the same deterministic failure was retried up to eight times before giving up with a generic provider error.
