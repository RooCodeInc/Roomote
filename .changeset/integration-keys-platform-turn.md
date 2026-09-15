---
"@roomote/types": patch
"@roomote/db": patch
"@roomote/sdk": patch
"@roomote/api": patch
"@roomote/cloud-agents": patch
"@roomote/web": patch
---

Integration keys: the agent can now call an approved integration directly with any method you approved for it (a POST search, for example) instead of launching a coding task for a single write; revoked and expired integrations no longer appear in any listing; the Session transcript labels the key tools in plain words ("Requested a key for Kagi", "Called POST /api/v1/search (200)"); the post-save turn is quoted on Slack and Teams without its hidden block; Fast no longer claims the tools are turned off when a delegated task settles; after a key is saved it resumes the original request instead of asking again; the header prefix is accepted with or without its trailing space; and when the broker refuses a call for a nameable reason (method not approved, the service echoed the key, path too long) the agent is told what to change instead of getting a generic refusal.
