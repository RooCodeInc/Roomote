---
'@roomote/web': patch
---

Updated the bundled OpenCode runtime to 1.18.30. Native Amazon Bedrock models that return redacted reasoning (such as xAI Grok) now work in sessions and tasks instead of failing on every response, and Bedrock reasoning replay is more reliable. GPT-6 sessions keep identifying as Roomote under OpenCode's new GPT-6 system prompt.
