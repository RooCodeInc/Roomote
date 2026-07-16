---
'@roomote/web': patch
---

Give Discord its own gateway secret (Telegram-style) instead of reusing the shared public webhooks secret, reducing blast radius if one channel's secret is rotated or leaked.
