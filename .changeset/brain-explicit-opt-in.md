---
"@roomote/web": patch
---

Require an explicit Brain provider key (`R_BRAIN_OPENROUTER_API_KEY` or `R_BRAIN_OPENAI_API_KEY`) to activate the Brain, so template-generated plumbing and general task provider keys never turn it on for deployments that did not opt in, and keep Slack follow-up delivery working against a rolled-back API by routing canonically when the reply-target procedures are unavailable.
