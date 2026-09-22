---
'@roomote/web': patch
---

When the judgment model finds an unmentioned Slack or Discord thread reply to be for Roomote, the turn is now treated as directed at Roomote: the "Roomote is working" status appears while it works and the turn answers instead of being eligible to stay silent. Before, replies in multi-person threads where Roomote was not the last speaker showed no activity even after the model had decided they were for Roomote.
