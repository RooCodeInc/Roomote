---
'@roomote/types': patch
'@roomote/web': patch
---

Fix the Azure DevOps delegated setup flow sending users back to the credentials form after a successful Microsoft sign-in. Delegated mode only reports `configSatisfied` once `ADO_LINKED_ACCOUNT_ID` is saved, but that id is acquired on the later connect step, so gating the config step on it meant every return from the OAuth round trip resolved back to the config step. The sign-in had actually succeeded, but nothing was persisted and no repositories synced, so the flow looked like it had not registered and users ran it again. Step gating now uses a new `configStepSatisfied` flag covering only what the config step itself collects, and the connect step completes the linked-account save and repository sync on the first pass. Settings also now says when a linked Azure DevOps account is not in use yet because the configuration has not been saved.
