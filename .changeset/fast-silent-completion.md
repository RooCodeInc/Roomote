---
'@roomote/web': patch
---

Fast turns that end with nothing to say no longer post "I could not complete that request within the available turn." When the model ends its turn with no reply and no tool call in a situation where ignoring would have been allowed, such as a link pasted right after an aside between people, the turn now settles silently exactly as an explicit ignore does. When a request directed at Roomote goes unanswered, the closeout says so plainly and asks for a rephrase instead of describing a turn budget that does not exist.
