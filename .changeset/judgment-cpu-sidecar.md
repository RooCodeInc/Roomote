---
'@roomote/web': patch
---

Self-hosted deployments can run a CPU decision model beside the stack, so the Memory check, reply addressing, and Roomote's other typed decisions work without a Jev key or a GPU. The judgment sidecar serves `roomote/roomote-judgment-gliner`, a GLiNER 2.5 model fine-tuned on Roomote's decisions, behind the same decision contract Roomote's `roomote` judgment backend calls, capped at 4 GB and 4 CPUs by default. It is opt-in like Memory: the `judgment` compose profile in the self-host and production Compose files, and an idle service in the Railway, Render, and Coolify templates that stays unused until `R_JUDGMENT_UPSTREAM_URL` points at it. The image is published as `ghcr.io/roocodeinc/roomote-judgment`. `docker-compose.self-host.yml` now passes `R_JUDGMENT_MODEL`, `R_JUDGMENT_UPSTREAM_URL`, and `R_JUDGMENT_UPSTREAM_API_KEY` to the app services.
