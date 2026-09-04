---
'@roomote/web': patch
---

Fast turns retry a provider rejection once automatically instead of asking the user to try again. When the inference provider rejects a request outright (a 4xx such as a model refusing replayed tool-call history), the turn is re-run once from a fresh session: in process when no tool has run yet, and as a durable park that resumes from the recorded transcript when tools already ran. When the closeout is still needed, it now includes the model and the provider's status and message, so "the inference provider returned an error" says which provider and what it said.
