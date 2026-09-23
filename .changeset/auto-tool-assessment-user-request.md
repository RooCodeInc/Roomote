---
'@roomote/web': patch
---

Auto mode's assessment of an integration tool call now sees what the user last asked for. For a task call, that is the visible text of the task's latest prompt, without the `<request>` envelope or Roomote's injected blocks. For a Session call, it is the caller's latest prompt in that Session. This covers both shadow assessments and task approval requests.
