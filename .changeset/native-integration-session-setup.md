---
'@roomote/cloud-agents': minor
'@roomote/sdk': minor
'@roomote/types': minor
'@roomote/web': minor
'@roomote/api': minor
'@roomote/env': minor
'@roomote/worker': patch
---

Fast Sessions now discover every built-in integration before considering custom MCP or API-key fallbacks and can start the integration's supported OAuth, secure Settings, or keyless setup path. OAuth callbacks remain bound to the requester and Session, then resume the conversation after success, cancellation, or failure. Notion additionally supports an operator-configured public-connection OAuth client while retaining its internal integration secret flow.
