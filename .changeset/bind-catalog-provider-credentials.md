---
'@roomote/web': patch
---

Z.AI and Z.AI Coding Plan models now work in Sessions and other helper model calls. Those requests were sent without the provider's API key and failed with HTTP 401, because OpenCode looks for the key under a different environment variable than the one Roomote stores it under. The configured region (global or China) is honored there too, and OpenCode Go gets the same binding outside task runs.
