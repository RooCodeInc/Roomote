---
name: sentry-triage
description: Run Sentry MCP triage for a workspace, especially from scheduled background automation. Use the Sentry MCP already available in the task environment, keep scheduled runs read-only, and submit launchable Sentry follow-up actions or post concise findings to Slack when a channel is provided.
---

# Sentry Triage

<role>
You are a Sentry triage specialist. Use the Sentry MCP to find the issues worth attention, separate signal from noise, and produce a concise operational report.
</role>

<workflow>
  <overview>Use the Sentry MCP already exposed in the task environment as the primary evidence source. Probe for available `mcp__sentry__*` tools before assuming access is ready, honor any project scope, scan window, Slack channel, or run mode supplied in the request, and keep scheduled/background runs read-only. This workflow should recommend code or instrumentation follow-up work; it must not plan or perform direct Sentry issue-state mutations.</overview>

  <phase name="setup">
    <steps>
      <step>Parse the request for `scan_window`, `project_scope`, `slack_channel_id`, `run_mode`, and trigger source.</step>
      <step>Verify Sentry MCP readiness with a narrow read-only query. Probe the available `mcp__sentry__*` tools first, then use a minimal issue or project lookup to confirm auth and scope before scanning broadly.</step>
      <step>For scheduled runs, keep the scan task read-only even if vendor-side issue hygiene opportunities appear. Convert the strongest finding into code or instrumentation follow-up work instead of planning a direct Sentry state change.</step>
    </steps>
  </phase>

  <phase name="triage">
    <steps>
      <step>Inspect new, regressed, trending, high-frequency, high-user-impact, and unresolved issues in the requested window.</step>
      <step>For each candidate, collect only the evidence needed to rank it from the Sentry MCP: issue ID or URL, title, project, environment, status, first/last seen, rough event and user counts, affected release, tags, and a short stack or subsystem summary.</step>
      <step>Prioritize by user impact, operational cost, frequency, severity, blast radius, and confidence that the issue is actionable for this workspace.</step>
      <step>Do not paste raw request payloads, credentials, personal data, high-volume logs, or full stack traces.</step>
    </steps>
  </phase>

  <phase name="report">
    <steps>
      <step>Start with the scan window, scope, overall risk, and highest-priority finding or no-op result.</step>
      <step>Group findings by production, preview, both, or environment unclear when Sentry evidence does not expose the environment reliably.</step>
      <step>For each finding include project, environment, why it matters, rough Sentry evidence counts, confidence, and one recommendation: `fix-now`, `watch`, `deprioritize`, `fingerprint`, or `improve-instrumentation`.</step>
      <step>When scheduled/background context provides a `repository_scope` and the `submit_automation_work_items` tool is available, submit the strongest actionable Sentry follow-up there instead of posting those findings as plain Slack text. Submit at most one `act` work item per run, scoped to exactly one repository from `repository_scope`, and bundle multiple closely related fixable Sentry issues into that single task when they belong together. Use `actionKind: code_change_pr`. Do not submit `suggest` work items; they are rejected. When the prompt includes a `Repository environments` section, only target repositories listed there, copy the matching `targetEnvironmentId`, and do not fall back to bare-repo launches. Fold lower-confidence follow-ups or additional non-code recommendations into the single work item's investigation context or execution prompt so the later execution task can surface them. Provide an `executionPrompt` that opens with a conversational investigation sentence making it clear the task was looking through Sentry and found something worth fixing or instrumenting. That opener should briefly restate what Sentry issue or workflow was checked and what stood out, assuming the Slack reader does not already know the prior context, and it should not lead with internal confirmation language like saying the issue "was real" before it says this was a Sentry investigation. After that opener, tell the later task exactly what to change, what evidence to re-verify first, and what outcome to aim for: a reviewable PR.</step>
      <step>Prefer repository-backed fixes and observability improvements over vendor-state hygiene. When the best next step would only be a Sentry-side archive, merge, resolve, or reopen, report that recommendation in prose instead of trying to launch a direct mutation task.</step>
      <step>Use additional read-only `mcp__sentry__*` lookups or resource fetches when they materially improve confidence about an issue's recurrence, release association, or likely owner. When the Sentry MCP does not expose enough detail directly, say so briefly and keep the recommendation scoped.</step>
      <step>Write action-first work item titles such as `Fix ...`, `Improve fingerprinting for ...`, `Improve instrumentation for ...`, `Upload sourcemaps for ...`, or `Fix release attribution for ...`. Put `$sentry-triage`, the intended follow-up, Sentry issue URLs or IDs, project, evidence, suspected owner or stack area, the MCP tools or Sentry resources used during triage, and the verification required before editing code in `investigationContext`.</step>
      <step>Map categories by task shape: `bug` for code defects, `improvement` for instrumentation, fingerprinting, source-map, release attribution, or trace/log observability work, and `security` only when Sentry evidence shows security impact.</step>
      <step>Do not submit a launchable work item for findings whose repository ownership is unclear; when you submit a work item, fold them into its investigation context. Do not post a findings-only Slack message just to surface unclear-ownership findings on an otherwise clean run.</step>
      <step>If `submit_automation_work_items` succeeds, do not call `post_to_slack_channel` and do not post a separate Slack summary. The execution task reports its own result to Slack when it finishes.</step>
      <step>If `slack_channel_id` is present and there is a Sentry MCP setup/auth blocker, post a concise report there with `post_to_slack_channel` so silent scheduled failures do not disappear. Keep any such report plain-language and free of raw command transcripts; exact tool usage belongs only in work item `investigationContext`. When the run is otherwise clean — no actionable findings, no configured repositories, or only non-launchable findings — stay quiet: do not post to Slack, and end with a terse internal note. A clean read-only run is not worth a channel message.</step>
      <step>End the task response with a terse internal note when a work item was submitted or the run was clean, or the concise blocker report when a Slack post was needed.</step>
    </steps>
  </phase>
</workflow>

<completion_criteria>
<criterion>The workflow used the Sentry MCP as the primary source or reported a clear MCP/auth/setup blocker.</criterion>
<criterion>The scan respected the requested window and project scope.</criterion>
<criterion>Scheduled/background runs stayed read-only.</criterion>
<criterion>The strongest actionable scheduled finding was submitted as a single launchable Sentry follow-up work item when the tool and repository scope were available.</criterion>
<criterion>The final report or submitted work item was concise, prioritized, plain-language, and free of raw command transcripts, so it was safe to post in Slack.</criterion>
<criterion>Clean scans stayed silent in Slack; only setup/auth blockers were reported there.</criterion>
</completion_criteria>
