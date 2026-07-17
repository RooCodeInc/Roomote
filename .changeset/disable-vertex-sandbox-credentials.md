---
"@roomote/web": patch
---

Temporarily disable Google Vertex AI and remove legacy direct Mistral execution. Model-provider credentials now enter task sandboxes only through the selected runtime provider allowlist, while unrelated task environment variables remain available.
