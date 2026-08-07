---
'@roomote/web': patch
---

Verify a model provider API key with the provider before saving it. Connecting a hosted provider used to persist whatever was typed without ever authenticating it: the save path only made a network call for the four providers that discover their models from an endpoint, so a typo, a revoked key, or a key pasted into the wrong provider saved cleanly and reported the provider connected. The first symptom was a task failing at run time, which reads as a Roomote fault rather than a rejected credential.

Saving `anthropic`, `openai`, `google`, `xai`, `moonshotai`, `openrouter`, or `togetherai` from the setup wizard or Models settings now makes one bounded authenticated request to that provider first, and the save fails with the provider's own rejection quoted against the key field. Nothing is written when the key is rejected, so a failed save no longer leaves a bad credential behind. Only a rejection from the provider blocks the save: a timeout, a rate limit, or a provider outage is reported as unverified and lets the save through.

Providers that resolve an operator-supplied endpoint (LiteLLM, Ollama, vLLM, OpenAI-compatible), the OAuth providers, and Bedrock/Azure are unchanged.
