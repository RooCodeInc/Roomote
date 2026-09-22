---
"@roomote/web": patch
---

Auto mode for integration tool approvals now enforces allow/deny: a call the decision model does not approve is blocked with a tool error returned to the agent instead of pausing on an approval card, and any evaluation failure or missing decision model fails closed to the same denial.
