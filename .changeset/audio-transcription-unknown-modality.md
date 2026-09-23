---
'@roomote/cloud-agents': patch
---

Inbound audio attachments (Telegram voice messages, Slack/Teams/Discord audio) no longer report that no configured model supports audio input when the provider catalog simply lacks modality metadata for the configured models. Models with unknown capability metadata — newly released models missing from the catalog and models served through custom OpenAI-compatible providers — are now tried instead of being skipped outright; models the catalog explicitly marks as not supporting audio input or not producing text output are still excluded.
