---
'@roomote/web': patch
---

Fix Azure OpenAI and Azure AI Foundry task requests being rejected by the inference gateway because their API paths were missing the version prefix.
