---
'@roomote/web': patch
---

Z.AI, Z.AI Coding Plan, Azure AI Foundry, and Google Gemini models now work in Sessions and other helper model calls. Those requests were sent without the provider's API key (Z.AI answered HTTP 401), because OpenCode or the provider SDK looks for the key under a different environment variable than the one Roomote stores it under. The configured Z.AI region (global or China) is honored there too, and OpenCode Go gets the same binding outside task runs.
