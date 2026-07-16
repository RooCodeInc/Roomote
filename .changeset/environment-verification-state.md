---
'@roomote/web': minor
---

Environments now track a persisted verification state that is separate from "a definition exists". A new environment is Configured until a follow-up verification task confirms it works, then it becomes Verified; runtime-affecting edits reset it to Configured while name/description-only edits keep it verified. Onboarding can finish while verification runs, the Environments settings page shows the verification status with a Retry verification action and a link to the related task, and agents record the outcome through the new `manage_environments` `record_verification` action.
