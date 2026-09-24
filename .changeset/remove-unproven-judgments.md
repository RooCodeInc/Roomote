---
'@roomote/web': patch
---

The judgment model is no longer used for six decisions. Each now works the way it does on a deployment without a judgment model:

- Fast sessions no longer add a per-turn skill hint. The agent picks skills from the listed skills itself, and skills beyond the list stay reachable through `list_skills`.
- Memory `query` results are returned in the order Memory search ranks them.
- `find_integration_tools` returns keyword matches only.
- Telegram topic icons come from the model that writes the task title.
- Discord forum tags are chosen by the helper model.
- PR review activity is always triaged by the helper model, with no judgment-model step before it.
