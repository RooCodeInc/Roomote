---
"@roomote/sdk": patch
"@roomote/bullmq": patch
"@roomote/db": patch
---

Queue delegated-task updates durably for their Fast parent so busy conversations process child progress and completion in order instead of rejecting or killing the parent event after 30 seconds.
