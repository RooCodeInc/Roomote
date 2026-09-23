---
'@roomote/web': patch
---

Auto mode's assessment of a task's integration tool call now sees what the user last asked the task for. Shadow assessments of task calls look up the task's latest prompt, and task approval requests use the prompt's visible text without Roomote's injected wrapper blocks, falling back to the task's latest recorded prompt when the worker has none.
