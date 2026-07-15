---
"@roomote/web": minor
---

Inference providers now carry recommended per-role model defaults (helper, vision, code review, explore, planning). Connecting a provider in the setup wizard applies its recommended defaults automatically, and a "Use recommended" action on the Default Models card in Settings > Models re-applies them at any time. Google Vertex AI now defaults to Claude models (Sonnet 5 coding, Haiku 4.5 helper/explore, Opus 4.8 review/planning). Requesty is no longer offered for new connections; existing Requesty connections keep working.
