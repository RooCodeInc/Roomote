---
'@roomote/web': patch
---

Fixed Fast turns failing immediately on OpenAI models with "the inference provider returned an error". The `request_user_input` tool declared its arguments as a bare union, which produced a tool schema OpenAI rejected as invalid on every request.
