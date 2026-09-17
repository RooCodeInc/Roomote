---
'@roomote/web': minor
---

Add an optional judgment model for fast routing and triage decisions. Admins can connect TypeSafe in Settings > Models and choose Jev via TypeSafe or Jev via Vercel AI Gateway under Judgment model (or set `R_JUDGMENT_MODEL`). When it is on, Roomote uses it for channel launch criteria, request classification, unmentioned thread replies, Fast environment and skill hints, integration tool search, Memory result ordering, PR review noise, email auto-replies, and Discord forum tags, and keeps its existing behavior whenever the judgment model is unsure or unavailable.
