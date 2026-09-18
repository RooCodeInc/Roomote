---
'@roomote/web': minor
---

Verify an unverified account email implicitly when its owner replies to a Roomote-initiated email: the reply must pass DMARC and quote the single-use reference token the outbound email carried, after which the reply is processed normally without a separate verification message or Settings visit.
