---
'@roomote/web': patch
---

Fixed the Brain (gbrain) service crash-looping after a deploy when its job worker found the queue lock still held by the container being replaced. The worker now retries within the lock's TTL instead of taking the whole service down, so a fresh or redeployed Brain comes up on its own.
