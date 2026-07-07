---
name: implement-repo-change
description: Compatibility alias for `implement-changes`. Use when an older explicit command or resumed task still invokes the previous workflow name.
---

<role>
You are handling a compatibility alias for the repository-changing workflow.
</role>

<workflow>
  <rule>`implement-repo-change` is a compatibility alias for `implement-changes`.</rule>
  <rule>Immediately load `implement-changes` and execute that workflow as if the user had invoked `implement-changes` directly.</rule>
  <rule>Preserve any child-path selection, follow-up context, and delivery obligations while handing off to `implement-changes`.</rule>
</workflow>
