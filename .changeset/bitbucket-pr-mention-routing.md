---
'@roomote/web': patch
---

Bitbucket pull request @mentions now look up active review tasks only within the Bitbucket source-control provider and prefer stable account id/uuid for bot self-detection (with username preferred over nickname), so comment routing is less likely to hit the wrong provider’s task or loop on bot self-replies when nickname and username differ.
