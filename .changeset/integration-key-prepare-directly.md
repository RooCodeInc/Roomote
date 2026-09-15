---
"@roomote/cloud-agents": patch
---

Fast no longer probes whether a linked SaaS resource is publicly reachable, or delegates that probe to a coding task, before preparing an integration key: a link into a key-based service goes straight to `list_integration_keys` and `prepare_integration_key` in the same turn, and Fast never tells the human to enable the Integration keys setting while the tools are available to it.
