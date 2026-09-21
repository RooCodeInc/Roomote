---
'@roomote/web': patch
---

Fast sessions no longer wait on a Git fetch of every repository and marketplace skill source before each turn. The skill listing in the Fast prompt now comes from a short-lived cache that refreshes in the background, so a reply starts as quickly as it did before repository skills were added to the prompt.
