---
"@roomote/web": patch
---

Fast Sessions now see the names and descriptions of instance skills and inline environment skills in every turn, so Roomote recognizes a matching playbook from the request and loads it without being asked. Previously skills were only discoverable after the model chose to call `list_skills`, so custom skills from Settings > Skills went unused unless a user typed `$skill-name`. Marketplace and repository skills stay on demand; the prompt names each environment's marketplace sources so the model knows when to look them up.
