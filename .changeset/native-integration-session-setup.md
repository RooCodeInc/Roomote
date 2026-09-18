---
'@roomote/cloud-agents': minor
'@roomote/sdk': minor
'@roomote/types': minor
'@roomote/web': minor
'@roomote/api': minor
'@roomote/env': minor
'@roomote/worker': patch
---

Fast Sessions now expose the complete built-in integration catalog and connection status through read-only discovery, then use a separate canonical-ID `connect_integration` action to start the provider's supported OAuth, secure Settings, already-connected, or keyless path. Native, remote MCP, and API-key instructions now share one decision flow that respects explicit choices and never bypasses permission or authorization outcomes. OAuth callbacks remain bound to the requester and Session, then resume the conversation after success, cancellation, or failure. Notion additionally supports an operator-configured public-connection OAuth client while retaining its internal integration secret flow.
