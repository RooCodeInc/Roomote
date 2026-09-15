---
"@roomote/web": patch
---

Deployment admins can now turn Voice off and back on from Settings > Integrations even when the Voice key is provided by the `R_VOICE_OPENAI_API_KEY` environment variable. The environment key decides which OpenAI account pays for Voice; the deployment decides whether Voice is on. A key saved in Settings is kept while Voice is off. The card no longer names the environment variable.
