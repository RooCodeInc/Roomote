---
'@roomote/web': patch
---

Bounds the plugin install OpenCode runs on its own when the image-baked seed does not apply, such as local development or an OpenCode version bump shipped without a rebuilt seed. Each config directory OpenCode installs into now carries npm settings that prefer the local cache, give up on a stalled registry request after 15 seconds, and retry once, so a missing seed costs seconds instead of the five-minute stall that dead-ended the first Fast turn after a deploy.
