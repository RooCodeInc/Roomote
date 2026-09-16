---
"@roomote/types": patch
"@roomote/db": patch
"@roomote/sdk": patch
"@roomote/api": patch
"@roomote/cloud-agents": patch
"@roomote/web": patch
---

Integration keys: the agent can now call an approved integration directly with any method you approved for it (a POST search, for example), including when a delegated task settles for the same active Session owner; new approvals stay human-turn-only, and automatic turns name missing or mismatched actors instead of claiming the feature is disabled. New integrations default to everyone in the deployment, can be kept private or changed later in Settings, and show who shared them while keeping the key server-side; existing integrations remain private during migration. Revoked and expired integrations no longer appear in any listing; the Session transcript labels key tools in plain words; post-save turns are quoted without their hidden block; saving resumes the original request; header prefixes accept an omitted trailing space; and safe broker refusal reasons tell the agent what to change.
