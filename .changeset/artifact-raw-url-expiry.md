---
'@roomote/web': patch
---

Signed public artifact raw URLs (allowlisted images and videos used for visual proofs and PR embeds) expire 30 days after they are signed, and cache headers stay within the remaining TTL, so a leaked screenshot link cannot be fetched indefinitely.
