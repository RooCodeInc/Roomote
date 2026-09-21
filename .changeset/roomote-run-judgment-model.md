---
'@roomote/web': minor
---

Routing and triage judgments can now run against a judgment model the deployment operates itself. Set `R_JUDGMENT_UPSTREAM_URL` (and optionally `R_JUDGMENT_UPSTREAM_API_KEY`) to an endpoint that answers the typed decisions request, and it is used by default whenever no TypeSafe key is configured and no other judgment model was chosen; it also appears in Settings > Models as "Roomote judgment model". `R_JUDGMENT_SHADOW=on` additionally scores every Jev judgment with that endpoint and logs per-question agreement without changing the answer callers act on.
