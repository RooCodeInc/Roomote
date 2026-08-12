---
'@roomote/web': patch
---

Revoke the entire remote MCP OAuth refresh-token family when an already-rotated refresh token is replayed, per the OAuth 2.0 Security BCP. Previously the replay was rejected but the rest of the token family stayed valid, so a stolen-token signal never disabled the remaining tokens.
