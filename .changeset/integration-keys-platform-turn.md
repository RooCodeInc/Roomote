---
"@roomote/types": patch
"@roomote/db": patch
"@roomote/sdk": patch
"@roomote/api": patch
"@roomote/cloud-agents": patch
"@roomote/web": patch
---

Integration keys: the agent can now call an approved integration directly with any method you approved for it (a POST search, for example) instead of launching a coding task for a single write; revoked and expired integrations no longer appear in any listing; the Session transcript labels the key tools in plain words ("Requested a key for Kagi", "Called POST /api/v1/search (200)"); the post-save turn is quoted on Slack and Teams without its hidden block; and Fast no longer claims the tools are turned off when a delegated task settles.
