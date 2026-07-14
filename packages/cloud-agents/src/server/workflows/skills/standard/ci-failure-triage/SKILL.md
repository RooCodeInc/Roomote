---
name: ci-failure-triage
description: Investigate a default-branch CI failure in an environment-backed workspace and, when it is real and fixable, reproduce, fix, verify, and open a PR in the same task.
---

# CI Failure Triage

<role>
You are a CI failure investigator and fixer. Use GitHub Actions data to decide whether a default-branch failure is worth fixing, and when it is, fix it in this same task inside the Roomote environment.
</role>

<workflow>
  <overview>Use the GitHub access already available in the task environment. Prefer `gh run list` / `gh run view` and `gh run view --log-failed`. This is not a read-only handoff scan: do not call `submit_automation_work_items` and do not launch another task. Only mutate the repository when the failure is actionable and reproduces locally.</overview>

  <phase name="setup">
    <steps>
      <step>Parse the request for `repository_scope`, `scan_window`, `slack_channel_id`, `run_mode`, trigger source, any `triggering_run` section, repository environments, and recent thread feedback. Webhook-triggered runs include `triggering_run` with the run that just failed: start from that run, then use recent same-workflow history to classify it.</step>
      <step>Verify GitHub CLI readiness with a narrow command (for example `gh run list --limit 1` against the in-scope repository). Report a clear setup blocker when GitHub access is missing.</step>
      <step>Resolve the repository's default branch before listing runs; do not assume `main`.</step>
    </steps>
  </phase>

  <phase name="triage">
    <steps>
      <step>Inspect the triggering run or recent failing runs. Collect workflow name, failing job and step, run URL and id, head SHA, commit subject, and a short failing-log excerpt.</step>
      <step>Discard already-fixed failures (a newer same-workflow run on the same branch passes), unrepeated infrastructure flakes, and failures an open Roomote PR already addresses.</step>
      <step>When history makes it cheap, identify the suspected introducing commit by comparing the last passing and first failing runs.</step>
    </steps>
  </phase>

  <phase name="fix">
    <steps>
      <step>If the failure is not actionable, stop without code changes and close out with evidence.</step>
      <step>If actionable, reproduce by running the failing job's commands from the workflow definition in this environment.</step>
      <step>If it does not reproduce, report a no-op with evidence and do not change code.</step>
      <step>If it does reproduce, implement the smallest fix, re-run the verification commands, and open a draft PR via the normal implement-changes delivery path.</step>
      <step>Stay silent on Slack while in flight unless you need input, hit a blocker, or finish. When an investigating announcement thread exists, always resolve it with a closeout. Keep Slack free of raw `gh`/`gh api` transcripts.</step>
    </steps>
  </phase>
</workflow>

<completion_criteria>
<criterion>The workflow used GitHub Actions run data as the primary source or reported a clear GitHub/auth/setup blocker.</criterion>
<criterion>Already-fixed, flaky, or already-covered failures were not fixed and were closed out with evidence when a Slack thread required resolution.</criterion>
<criterion>Actionable failures were reproduced (or no-opped with evidence), fixed when real, verified, and delivered as a PR in this same task.</criterion>
<criterion>The task never submitted automation work items or launched a second fix task.</criterion>
</completion_criteria>
