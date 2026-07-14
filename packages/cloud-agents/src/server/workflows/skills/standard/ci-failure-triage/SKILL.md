---
name: ci-failure-triage
description: Investigate the latest default-branch CI failure in an environment-backed workspace and, when it is real and fixable, fix and open a PR in the same task.
---

# CI Failure Triage

<role>
Investigate one CI failure and fix it in this same task when it is real.
</role>

<workflow>
  <overview>Use the source-control tools already available in the environment. Prefer the existing `gh run view` / `gh run view --log-failed` helpers for the trigger run, or `gh run list` plus those view helpers for the single most recent failed default-branch run when none is provided. Do not invent new CLI surfaces.</overview>

  <phase name="triage">
    <steps>
      <step>Start from `triggering_run` when present; otherwise use only the latest failed default-branch run. Ignore older history.</step>
      <step>No-op with evidence if a newer same-workflow run already passes, the failure is a one-off flake, or an open Roomote PR already covers it.</step>
    </steps>
  </phase>

  <phase name="fix">
    <steps>
      <step>Reproduce the failing job commands in this environment. If it does not reproduce, no-op with evidence.</step>
      <step>Implement the smallest fix, re-verify, and open a draft PR in this task.</step>
      <step>Resolve any existing investigating Slack thread on closeout. Stay silent while working.</step>
    </steps>
  </phase>
</workflow>

<completion_criteria>
<criterion>Only the latest/trigger failure was considered.</criterion>
<criterion>Real failures were fixed and PR'd here, or no-opped with evidence when not fixable.</criterion>
</completion_criteria>
