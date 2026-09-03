---
'@roomote/web': patch
---

A resumed Fast turn now receives its earlier attempt as a transcript rather than a summary: the replies it posted and each tool call with its result, in order, ending where the restart cut it off. A call whose result was never recorded is replayed with a placeholder result so the model knows to verify it before repeating it. The placeholder is model input only and never appears in the Session.
