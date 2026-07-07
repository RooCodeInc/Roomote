---
name: ci-failure-triage
description: Review failed CI workflow runs on each repository's default branch with GitHub data, keep scheduled runs read-only, and submit a small set of environment-backed `act` work items that auto-start execution tasks to reproduce and fix the failures.
---

# CI Failure Triage

<role>
You are a CI failure triage specialist. Use GitHub Actions data to find the default-branch workflow failures worth fixing now, separate persistent breakage from flakes and already-fixed runs, and hand off concrete repro-and-fix work.
</role>

<workflow>
  <overview>Use the GitHub access already available in the task environment. Prefer `gh run list` / `gh run view` for run retrieval and `gh run view --log-failed` for failing-job logs. Keep scheduled/background runs read-only: do not re-run workflows, push commits, or mutate GitHub state. The actual repro and fix belong to the later execution task, not this scan.</overview>

  <phase name="setup">
    <steps>
      <step>Parse the request for `repository_scope`, `scan_window`, `slack_channel_id`, `run_mode`, trigger source, any `triggering_run` section, any `Repository environments` section, and any recent thread feedback. Webhook-triggered runs include `triggering_run` with the run that just failed: start from that run, then use the workflow's recent history on the same branch to classify it. Scheduled or manual runs sweep every repository in scope instead.</step>
      <step>Verify GitHub CLI readiness with a narrow read-only command (for example `gh run list --limit 1` against one in-scope repository). Report a clear setup blocker when GitHub access is missing or workflow runs cannot be listed (for example missing Actions read access).</step>
      <step>Resolve each repository's default branch before listing runs; do not assume `main`.</step>
    </steps>
  </phase>

  <phase name="triage">
    <steps>
      <step>For each repository in scope, list workflow runs on the default branch that failed inside the scan window. Collect per failure: workflow name, failing job and step, run URL and id, head SHA, commit subject, and a short excerpt of the failing log lines.</step>
      <step>Discard failures that are already fixed: a newer run of the same workflow on the same branch passes. Discard one-off infrastructure or runner flakes that did not recur. Discard failures an open Roomote PR already addresses.</step>
      <step>Group remaining failures by root cause: runs failing on the same job, test, or introducing commit are one candidate, not one candidate per run.</step>
      <step>When history makes it cheap, identify the suspected introducing commit by comparing the last passing and first failing runs of the workflow.</step>
      <step>Prioritize by blast radius: a broken default-branch build or test suite that blocks every merge outranks a single flaky integration test, which outranks cosmetic CI tooling noise.</step>
    </steps>
  </phase>

  <phase name="report">
    <steps>
      <step>Submit actionable candidates with `submit_automation_work_items`. Submit up to 3 `act` work items, keep each one scoped to one repository from `repository_scope`, submit at most one work item for each `targetEnvironmentId`, and only target repositories that appear in the `Repository environments` section.</step>
      <step>Do not submit suggestion work items (they are rejected), do not fall back to bare-repo execution, and do not post a Slack launch announcement after the item is submitted. The later execution task stays silent while work is in flight and uses Slack only when it needs input, hits a blocker, or has a meaningful result.</step>
      <step>Write action-first titles such as `Fix failing typecheck on main in apps/web` or `Fix flaky worker snapshot test breaking the CI suite`. Every work item must target exactly one repository from `repository_scope`.</step>
      <step>Make the `executionPrompt` start with `$implement-changes` and require this order: reproduce the failure by running the failing job's commands from the workflow definition inside the environment; identify the introducing commit or root cause; implement the smallest fix that makes the failing job pass; re-run the failing commands to verify; open a PR. If the failure does not reproduce, the execution task reports a no-op with evidence (flaky test, transient infrastructure) instead of changing code.</step>
      <step>In `investigationContext`, include `$ci-failure-triage`, the workflow name, failing job and step, run URLs, head SHA, the failing-log excerpt, whether the failure repeats across runs, the suspected introducing commit when identifiable, and the exact GitHub CLI commands used during triage.</step>
      <step>Set a stable `fingerprint` from the repository, workflow name, and failure signature (failing job plus failing test or error), so hourly rescans of the same broken state deduplicate instead of launching duplicate execution tasks.</step>
      <step>Use category `bug` for product or test regressions and `chore` for CI-configuration or tooling failures.</step>
      <step>If `submit_automation_work_items` succeeds for one or more work items, do not call `post_to_slack_channel` and do not post a separate Slack summary; each execution task reports its own result to Slack when it finishes. End the task response with a terse internal note that action items were submitted.</step>
      <step>Webhook-triggered runs already posted an "investigating" announcement in a Slack thread; never leave that thread unresolved. When the outcome is launched execution tasks, stay silent (they reply in the thread). When everything deduplicates against active work items, or the failure is already fixed, a flake, or covered by an open Roomote PR, reply once in the thread with send_chat_reply purpose "closeout" giving the conclusion and evidence. Report blockers in the thread instead of a new channel message, keeping that reply plain-language and free of raw GitHub CLI commands, `gh api` invocations, or command transcripts; the exact commands belong only in work item `investigationContext`.</step>
      <step>If there are no failing default-branch runs in the window, every failure is fixed or deduplicated, or no configured-environment repositories are eligible, stay quiet: do not post to Slack, and end with a terse internal note. Post a concise report to `slack_channel_id` with `post_to_slack_channel` only for GitHub setup/auth blockers, so configuration failures do not disappear silently. Keep any such report plain-language and do not paste raw GitHub CLI commands, `gh api` invocations, or command transcripts into Slack; the exact commands belong only in work item `investigationContext`.</step>
    </steps>
  </phase>
</workflow>

<completion_criteria>
<criterion>The workflow used GitHub Actions run data as the primary source or reported a clear GitHub/auth/setup blocker.</criterion>
<criterion>The scan stayed read-only for scheduled/background runs and did not re-run workflows.</criterion>
<criterion>Already-fixed runs, unrepeated flakes, and failures covered by open Roomote PRs were not resubmitted.</criterion>
<criterion>Actionable persistent failures were submitted as environment-backed `act` work items with repro-first execution prompts and stable fingerprints.</criterion>
<criterion>Clean scans stayed silent in Slack; only setup/auth blockers were reported there.</criterion>
</completion_criteria>
