---
'@roomote/web': patch
---

Self-hosted deployments can run a CPU decision model beside the stack with the `judgment` compose profile, so the Memory check, reply addressing, and Roomote's other typed decisions work without a Jev key or a GPU. The sidecar serves `roomote/roomote-judgment-gliner`, a GLiNER 2.5 model fine-tuned on Roomote's decisions, behind the same decision contract Roomote's `roomote` judgment backend calls, capped at 4 GB and 4 CPUs by default. `docker-compose.self-host.yml` now passes `R_JUDGMENT_MODEL`, `R_JUDGMENT_UPSTREAM_URL`, and `R_JUDGMENT_UPSTREAM_API_KEY` to the app services.
