---
'@roomote/web': patch
---

Silently drop inbound email that fails DMARC so spoofed sender addresses cannot receive refusal replies or consume refusal limits.
