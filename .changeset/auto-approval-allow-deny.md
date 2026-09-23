---
"@roomote/web": patch
---

Auto mode for integration tool approvals now runs routine calls automatically and asks before anything risky when the session owner is present. If the owner is away, the call is blocked with a tool error and recorded as an automatic rejection; unavailable checks follow the same present-to-ask, absent-to-block behavior. Chat-originated sessions are treated as present because their approval card is linked from the conversation.
