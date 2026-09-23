---
'@roomote/web': patch
---

When an inference provider reports that the account is out of credits or quota (for example a ChatGPT subscription usage limit, OpenAI `insufficient_quota`, an Anthropic credit balance or spend limit, or an OpenRouter credit limit), sessions and tasks now stop immediately and say "You seem to have run out of credits for {provider}. Choose another provider/model or reset your subscription to continue." instead of showing a temporary-error notice and retrying. Plain rate limits and unrecognized provider errors keep retrying as before. Saving a provider key whose account has no credits left no longer fails: the key is saved with a warning so the account can be topped up in parallel. Only rejected credentials block the save.
