---
"@roomote/web": patch
"@roomote/cloud-agents": patch
"@roomote/types": patch
---

After you save an integration key through a Session's form, the Session transcript now shows a short "I added the integration, go ahead." turn instead of the technical instruction. The instruction still reaches the agent inside an `<integration_saved>` block that the transcript hides, and Fast is told how to read it.
