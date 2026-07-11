---
'@roomote/db': patch
---

The Teams bot works again for deployments that only set Microsoft app env vars (`R_MICROSOFT_CLIENT_ID` / `R_MICROSOFT_CLIENT_SECRET` and tenant) without a dedicated `R_TEAMS_BOT_*` pair. The runtime credential path restores that single-Entra-app fallback; dedicated bot credentials still take precedence when set.
