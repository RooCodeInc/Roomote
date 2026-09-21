---
'@roomote/web': patch
---

Deployments can evaluate a judgment model they run themselves against Jev. With `R_JUDGMENT_UPSTREAM_URL` set (and optionally `R_JUDGMENT_UPSTREAM_API_KEY`) and `R_JUDGMENT_SHADOW=on`, every Jev judgment is also scored by that endpoint and per-question agreement is logged, without changing the answer Roomote acts on. The self-run model cannot be selected as the judgment model yet.
