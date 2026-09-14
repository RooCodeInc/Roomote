---
"@roomote/api": patch
"@roomote/cloud-agents": patch
"@roomote/db": patch
---

Log bounded, nonsecret reason codes when Session-secret tools and HTTP integration requests fail closed, so operators can diagnose a denial from server logs. Client-facing messages are unchanged and no path, header, body, credential or upstream error text is logged.
