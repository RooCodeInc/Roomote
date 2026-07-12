---
'@roomote/worker': patch
---

Materialize pasted Google Vertex service-account credentials before OpenCode starts so Vertex models work across worker paths without exposing credential JSON in provider errors.
