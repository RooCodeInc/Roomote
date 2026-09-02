---
'@roomote/cloud-agents': patch
'@roomote/web': patch
---

Stream Fast replies to the web session transcript while the model writes them. Fast replies are now the model's plain assistant text; `send_chat_reply` delivers the text written since the last reply and its `message` argument is optional.
