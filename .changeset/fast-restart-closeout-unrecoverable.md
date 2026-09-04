---
'@roomote/web': patch
---

A Fast turn whose durable admission write failed before it ran no longer ends in silence when a restart cuts it off. Every other turn already resumes on the next process; this one had no row to resume from, so the turn disappeared and the Session stayed marked responding. The turn is now admitted late at the moment of interruption and handed straight to the queue, which resumes it the same way. Only if that late admission also fails does the turn post "Roomote restarted while working on this request. Please send it again." Queue-delivered follow-ups stay quiet because the queue re-runs them itself, and platform events keep their existing handling.
