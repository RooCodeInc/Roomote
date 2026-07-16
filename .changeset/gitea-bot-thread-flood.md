---
'@roomote/web': patch
---

Stop Gitea pull requests from flooding with bot review threads when the bot username does not start with `roomote`, by correctly recognizing bot comments without re-entering mention intake.
