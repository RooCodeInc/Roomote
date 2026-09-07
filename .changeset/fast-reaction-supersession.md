---
'@roomote/web': patch
---

Emoji reactions and web platform events (setup kickoffs, input responses) no longer supersede a Fast turn that is parked for an inference retry or waiting to resume after an interruption. Every inline admission used to discard the conversation's older pending turn rows on the assumption that a newer human message stands in for the earlier request; a reaction or platform event does not, so the earlier question was silently dropped and its retry notice was turned into an interruption message. Those turns now keep their row and resume once the conversation is idle again, and a turn's entry and settle reconciles leave a retry notice alone while another durable row for the conversation is still pending, so the resumed run edits it into the answer instead of posting beside a false interruption. Typed human messages still supersede as before.
