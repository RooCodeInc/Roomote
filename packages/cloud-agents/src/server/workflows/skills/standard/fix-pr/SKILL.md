---
name: fix-pr
description: Pull-request feedback fixer workflow. Use when you need to implement fixes requested on an existing pull request from review threads, fix-id links, top-level PR comments, or broad "fix all unresolved issues" requests.
---

<role>
You are a pull-request fixer. Resolve requested PR feedback in code, keep the review threads aligned with reality, and avoid turning the run into a fresh review or unrelated cleanup pass.
</role>

<shared_core_loading>
<rule>If the `implement-changes` skill is not currently loaded into your context, load that skill before deeper execution.</rule>
<rule>When loading `implement-changes` from this child skill, inherit only the `core-contract` section and the parent `fix-github-pr-feedback` child-path contract.</rule>
<rule>Do not execute `implement-changes`'s default workflow from this child skill unless the caller explicitly instructed the parent default path to run first.</rule>
<rule>This skill remains the canonical owner of PR-feedback fixer mechanics even when the parent skill is loaded for shared context.</rule>
</shared_core_loading>

<workflow>
  <overview>Resolve the target pull request and triggering request from live provider state, clear PR merge conflicts first when needed, classify the fixer mode, acknowledge the work in the correct comment surface, implement only the requested fixes on the existing PR branch, validate and push them, run the `capture-visual-proof` step for repository-file-changing fixes before PR metadata refresh, refresh the existing PR metadata from the final shipped diff, resolve only genuinely fixed review threads, and leave one canonical fixer comment that matches the true shipped result.</overview>
  <critical_completion_gate>A PR-fixer run is incomplete if it stops after code changes, after a successful push, or after a required proof step. The run completes only after pull-request closeout is attempted as well: refresh PR metadata, patch the canonical fixer comment, and resolve every review thread that is genuinely fixed while reporting any closeout gap honestly.</critical_completion_gate>

<initial_determination>
<detection_patterns>
<pattern type="review_comment_reply">
<indicator>The request includes a review-comment identifier, review-comment URL, reply-thread context, or another line-specific review-thread anchor.</indicator>
</pattern>
<pattern type="fix_id_request">
<indicator>The request includes a `fixId` from an earlier Roomote review comment.</indicator>
</pattern>
<pattern type="fix_all_request">
<indicator>The request explicitly asks to fix all unresolved issues, all Roomote review issues, or equivalent broad PR feedback.</indicator>
</pattern>
<pattern type="top_level_comment">
<indicator>The request targets a pull request but does not provide a line-specific review-thread anchor or explicit `fixId`.</indicator>
</pattern>
</detection_patterns>
</initial_determination>

  <phase name="analysis">
    <description>Resolve the pull request, fetch the live provider state, and determine exactly which issues are in scope before editing code.</description>
    <steps>
      <step number="1">
        <title>Resolve pull-request scope and initialize tracking</title>
        <description>Identify the repository, pull request, and optional task-context hints before touching the repository or review-thread state.</description>
        <actions>
          <action>Create a todo list covering PR identification, trigger discovery, live provider fetches, acknowledgment, checkout, repository exploration, implementation, validation, push, visual proof step when repository files changed, PR metadata refresh, thread resolution, final comment update, and consistency checks.</action>
          <action>Determine the repository full name (owner/repo for GitHub/GitLab/Gitea, organization/project/repository for Azure DevOps) and `[PR_NUMBER]` from the request, supplied PR/MR URLs, task context, or the checkout's `git remote get-url origin` when already inside the repository.</action>
          <action>If either repository or pull request number is still missing after those checks, ask for the missing identifier and stop.</action>
          <action>Record optional task-context values if they are supplied: `task_link_follow`, `task_link_see`, `revert_commit_base_url`, `triggering_comment`, `top_level_review_comment_id`, `top_level_review_comment`, `pull_request_details`, `changed_files`, `linked_issue`, `pull_request_diff`, `existing_review_comments`, `issue_comments`, `REVIEW_COMMENT_ID`, and `FIX_ID`. Treat each as optional and never fabricate one.</action>
          <action>Treat prompt-supplied task-context values as first-class inputs. Use them directly when they already provide the needed snapshot or identifier, and fetch only the missing provider state or revalidate mutable state before side effects when freshness matters.</action>
        </actions>
        <validation>You know exactly which pull request you are fixing, and the todo list reflects the full fixer workflow.</validation>
      </step>

      <step number="2">
        <title>Fetch live pull-request and repository context</title>
        <description>Read the real pull request, diff, live review-comment context, top-level discussion, and enough PR operational state to know whether the fixer must clear merge conflicts before the main fixer flow can proceed. Treat any recovered summary comment as an issue-inventory shortcut, not as a substitute for the live review discussion.</description>
        <actions>
          <action>If prompt-supplied PR snapshots exist, start from them and skip redundant fetches. Use the Roomote MCP `manage_source_control` read actions only to fill missing context or to revalidate mutable provider state before posting comments, refreshing PR metadata, or resolving threads; do not use provider-specific CLIs such as `gh` for pull-request state.</action>
          <action>When `pull_request_details` or current head metadata is missing, or when it must be revalidated before a side effect, call `mcp__roomote__manage_source_control` with `action: "get_pull_request"`, `repositoryFullName`, and `prNumber`. The result carries the title, body, state, draft flag, source and target branches, head and base SHAs, author, mergeability, and cross-repository (fork) information.</action>
          <action>Check the PR state from the fetched details. If the pull request is already merged, open a follow-up PR against the base branch with the requested fixes instead of pushing to the existing PR branch. If the pull request is closed without being merged, stop and report that the PR is closed.</action>
          <action>When `pull_request_diff` is missing, or when the current diff must be revalidated before a side effect, compute it locally: `git fetch origin '<sourceBranch>' '<targetBranch>'`, then `git diff <baseSha>...<headSha>` using the SHAs from `get_pull_request`. Use this local git diff for every provider instead of a provider CLI.</action>
          <action>When `existing_review_comments` or `issue_comments` are missing, or when current review-thread state must be revalidated before a side effect, call `mcp__roomote__manage_source_control` with `action: "list_pull_request_comments"`. The result returns review threads (each with a `threadId`, `resolved` state when the provider exposes it, and inline path/line anchors) plus top-level `issueComments`; heed any capability warnings it reports.</action>
          <action>If `linked_issue` context is missing, use the linked-work-item context supplied by the current workflow instructions when present; do not fetch issues through provider CLIs.</action>
          <action>Ensure the PR branch is checked out locally before repository edits: `git fetch origin '<sourceBranch>' && git checkout '<sourceBranch>'`. For cross-repository (fork) PRs whose source branch cannot be fetched with task credentials, report that blocker instead of improvising credentials. If merge conflicts had to be resolved first, refresh the checkout to the updated PR head after the delegated conflict resolver returns.</action>
          <action>Do not treat the summary comment alone as sufficient execution context for a broad request. Before editing code, inspect the live review comments and surrounding code for every issue you plan to fix so thread-specific nuance and anchors are not lost.</action>
          <action>Use the fetched mergeability state to decide whether the fixer must clear merge conflicts before normal execution can proceed. If the PR is merge-conflicted on a GitHub repository, do not invent a second merge-resolution workflow here; delegate immediately to the canonical `resolve-github-pr-merge-conflicts` skill, then re-fetch the PR details, diff, and comments and resume the fixer workflow only from the refreshed mergeable PR state. On non-GitHub providers, report the conflict as a blocker on the canonical fixer comment instead of delegating.</action>
          <action>Read the relevant changed files in full, then read any related types, tests, schemas, callers, or utilities needed to verify the requested fixes safely.</action>
        </actions>
        <validation>The live PR state, discussion, diff, and repository context have been read deeply enough to classify the request and implement the right fix set, and any conflicted PR has been returned to a mergeable state before the main fixer flow continues.</validation>
      </step>

      <step number="3">
        <title>Recover the triggering issue inventory and classify the fixer mode</title>
        <description>Determine whether the fixer is responding to one thread, one `fixId`, a broad top-level comment, or an explicit fix-all request.</description>
        <actions>
          <action>If `REVIEW_COMMENT_ID`, a review-comment URL, or reply-thread context is supplied, fetch or recover that exact review comment and classify the run as `review_comment_reply`.</action>
          <action>If `FIX_ID` is supplied, search the fetched Roomote review comments and top-level comments for the matching hidden marker and classify the run as `fix_id_request`.</action>
          <action>Otherwise classify the run as `fix_all_request` when the request explicitly asks to fix all unresolved Roomote review issues, or as `top_level_comment` when it targets PR fixes broadly without line-specific thread anchors.</action>
          <action>For broad requests, reuse the latest Roomote review summary whose first line starts with `<!-- roomote-review-summary` as the canonical issue inventory when available; only fall back to enumerating unresolved Roomote review comments when that summary cannot be recovered safely. Build that inventory only from unresolved checkbox items (`- [ ]`). Ignore checked items (`- [x]`) and struck-through dismissed bullets like `- ~~...~~ — dismissed: ...` because they are history, not open fix targets. Use the surviving candidate inventory to decide which issues are in scope, then confirm each candidate against the live review comments, thread replies, current code, and the user's requested scope instead of treating the summary as the entire review context.</action>
          <action>For any finding recovered from a summary or linked review-result handoff, treat it as candidate review feedback rather than an automatically authoritative instruction until that revalidation is complete.</action>
          <action>For narrow requests, treat the triggering review comment, the surrounding diff hunk, and the live code as the issue inventory; do not expand the scope into a new full-review pass.</action>
          <action>If the trigger or issue inventory remains ambiguous after live fetches, ask one focused clarifying question through the canonical fixer comment and stop instead of guessing.</action>
        </actions>
        <validation>You know the exact fixer mode and have a concrete issue inventory that matches the live PR state.</validation>
      </step>

      <step number="4">
        <title>Establish one canonical fixer acknowledgment comment</title>
        <description>Attach the fixer run to one pull-request comment surface and update that same surface in place through the rest of the run.</description>
        <actions>
          <action>For `review_comment_reply` or `fix_id_request`, keep the acknowledgment in the matching review thread by calling `mcp__roomote__manage_source_control` with `action: "reply_to_pull_request_comment"` and that thread's `threadId`, so later updates stay attached to the line-specific discussion. Do not edit the original or any prior review comment in that thread.</action>
          <action>For `top_level_comment` and `fix_all_request`, reuse the latest Roomote-authored top-level fixer comment whose first line starts with `<!-- roomote-pr-fix` when it safely matches the current trigger; otherwise create one new canonical top-level fixer comment with `action: "create_pull_request_comment"`.</action>
          <action>Whenever you create or update the canonical fixer comment, keep the hidden marker first in this form: `<!-- roomote-pr-fix mode=[thread|top-level] trigger=[TRIGGER_VALUE] -->`.</action>
          <action>Use a compact in-progress status line while work is underway. If `task_link_follow` is available, keep it inline on that short status line; otherwise omit it.</action>
          <action>Record the `commentId` (and `threadId` when the surface is a review thread) from the acknowledgment result, and patch that same comment in place for all later updates with `action: "update_pull_request_comment"`, passing `threadId` alongside `commentId` for review-thread comments so the update targets the same comment family. That patch is limited to this run's own `roomote-pr-fix` canonical fixer comment; never use `update_pull_request_comment` to rewrite previous review comments. To respond on earlier review discussion, reply with `reply_to_pull_request_comment` or add a new comment with `create_pull_request_comment`.</action>
        </actions>
        <validation>The fixer run has exactly one canonical acknowledgment surface, later updates can patch that same comment in place, and no prior review comments were rewritten in place.</validation>
      </step>
    </steps>

  </phase>

  <phase name="implementation">
    <description>Implement only the requested fixes, push them on the existing PR branch, and keep the PR metadata aligned to the shipped result.</description>
    <steps>
      <step number="5">
        <title>Turn the recovered issue inventory into a concrete fix plan</title>
        <description>Expand the triggering feedback into a coherent set of code changes before editing.</description>
        <actions>
          <action>Translate the recovered trigger or issue inventory into a concrete list of code changes, tests, and thread-resolution expectations.</action>
          <action>For broad requests, break grouped feedback into discrete actionable fixes before editing.</action>
          <action>If a candidate finding turns out to be invalid, stale, or outside the requested scope, do not treat it as a code fix. Instead plan the dismissal closeout: update the canonical review summary in place by converting the matching unresolved checklist line into a struck-through plain bullet with a brief factual reason, reply on the corresponding review thread or comment, and leave that thread unresolved by default.</action>
          <action>Keep the plan tightly scoped to the requested fixes; do not opportunistically refactor unrelated areas.</action>
        </actions>
        <validation>You have a concrete, repository-grounded fix list that is narrow enough to execute without drifting into unrelated cleanup.</validation>
      </step>

      <step number="6">
        <title>Implement and validate the requested fixes</title>
        <description>Change the repository code without unrelated churn, then validate proportionally while keeping PR operational state honest.</description>
        <actions>
          <action>Implement only the requested fixes in the checked-out PR branch.</action>
          <action>Prefer coherent code changes that resolve the requested issues while preserving surrounding behavior.</action>
          <action>Run proportionate validation for the affected behavior and update any directly affected tests when necessary.</action>
          <action>If the PR came from a fork, preserve the existing PR branch on the correct remote instead of assuming `origin` is the push target.</action>
          <action>Do not claim an issue is fixed unless both the code and the validation evidence support that claim.</action>
        </actions>
        <validation>The requested fixes are implemented, scoped correctly, and supported by validation evidence proportionate to the change.</validation>
      </step>

      <step number="7">
        <title>Push the fix on the existing PR branch</title>
        <description>Commit and push the result to the existing PR branch so any later proof step and PR closeout work refer to the final shipped fixer state.</description>
        <actions>
          <action>Commit the resulting fixes on the existing PR branch, capture `git rev-parse HEAD`, determine the correct push target from the PR head metadata, and push to the existing PR branch without assuming a same-repository `origin` push.</action>
          <action>Do not create a new branch or a new pull request from this workflow.</action>
          <action>Do not stop after the push step; continue into any required proof step and then pull-request closeout unless an explicit blocker prevents it.</action>
          <action>After pushing fixes, do not post an `@roomote` self-mention or manually request a fresh review because eligible pushes trigger automatic review through source-control synchronize handling. The only exception is when the user explicitly asks for a manual review request and automatic review-on-commit is unavailable.</action>
        </actions>
        <validation>The requested fixes are pushed on the existing PR branch and the pushed commit SHA is known for later proof, PR metadata refresh, and closeout.</validation>
      </step>

      <step number="8">
        <title>Resolve required visual proof before PR metadata refresh</title>
        <description>If the pushed fixer result changed repository files, keep this workflow active by loading `capture-visual-proof` before PR metadata refresh. That step decides whether browser proof applies, captures any applicable screenshots or screencasts with `agent-browser`, uploads them, and returns a proof result.</description>
        <actions>
          <action>After the fixes are committed and pushed, check whether the final pushed fixer result changed repository files, including newly added files.</action>
          <action>If no repository files changed, skip the proof step and carry that honest no-op result forward into PR metadata refresh and closeout.</action>
          <action>If repository files changed, continue in the current task/session by loading `capture-visual-proof` and following it for the final shipped fixer result before PR metadata refresh continues. Do not launch a separate task or subagent for this step.</action>
          <action>If the proof step reports that the environment-provided browser target is blocked or that browser capture could not complete, carry that blocker forward honestly into the later PR closeout instead of improvising another browser tool or host.</action>
          <action>Do not substitute Playwright, browser devtools, ad hoc localhost scripts, or any other browser automation for the `agent-browser` path defined in `capture-visual-proof`.</action>
          <action>If pull-request-backed UI work needs proof embeds, carry the canonical uploaded artifact list from the proof result forward when it exists so the PR formatter can render the latest screenshots and screencasts consistently.</action>
          <action>If a later fixer iteration changes repository files again, replace the prior proof evidence with the latest relevant proof result before refreshing PR metadata for that newer shipped state.</action>
        </actions>
        <validation>The pushed fixer result ends with either an in-task `capture-visual-proof` step for repository-file changes or an honest no-op result before PR metadata refresh continues.</validation>
      </step>

      <step number="9">
        <title>Refresh PR metadata from the final shipped diff</title>
        <description>After any required proof step, make the PR title/body match the final shipped diff and the latest retained proof evidence.</description>
        <actions>
          <action>Use the identical `pr-metadata-update-recipe` block below after any required proof step and before thread-resolution closeout. This workflow should normally exercise the open-pull-request path from that recipe.</action>
          <action>Do not stop after the push step or a required proof step; continue into PR metadata refresh unless an explicit blocker prevents it.</action>
          <action>Before any `mcp__roomote__manage_source_control` refresh call, run the recipe's required PR metadata contract check. If the check fails, rewrite `/tmp/pr-body.md` and the title until it passes; do not refresh a pull request with non-contract metadata.</action>
        </actions>
        <pr-metadata-update-recipe>
          <item>When an open pull request exists, capture the full shipped diff for the branch locally with `git fetch origin '<targetBranch>'` and `git diff <baseSha>...HEAD`, using the base SHA and branches from the latest `get_pull_request` result. Use this local git diff for every provider.</item>
          <item>When an open pull request exists, recover existing PR-body metadata that still applies, including current `## Related PRs` links, from the `body` field of the latest `get_pull_request` result.</item>
          <item>Call the Roomote MCP tool `mcp__roomote__manage_tasks` with `action: "get_messages"` for the current task using `limit: 20`. Reverse the returned newest-first message list before extracting the original problem statement, motivation, and key decisions from the conversation history.</item>
          <item>Use the recovered conversation to choose which participant the pull request is opened on behalf of. Prefer the person who requested or explicitly authorized the implementation or PR creation; do not infer ownership from thread ownership, task initiation, or the latest comment alone. When one participant is clear, pass their conversation display name or source-control login as `prAttribution`. If the conversation is genuinely ambiguous, or the task has no human participants at all (for example an automation-started task with no conversation), omit `prAttribution` so the platform retains current acting-user attribution. Never invent a name from repository history, issue trackers, or prior tasks; only participants recorded in this task's conversation, the current acting user, or the task owner are eligible.</item>
          <item>Before writing `/tmp/pr-body.md`, check for a checked-in repository pull request or merge request template in the locations the repository's source-control provider supports. On GitHub, inspect `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, any `.md` files inside `.github/PULL_REQUEST_TEMPLATE/`, `docs/pull_request_template.md`, `docs/PULL_REQUEST_TEMPLATE.md`, `pull_request_template.md`, and `PULL_REQUEST_TEMPLATE.md`. On GitLab, inspect the `.md` files inside `.gitlab/merge_request_templates/`, preferring `Default.md` when present. On Gitea, inspect `.gitea/pull_request_template.md`, `.gitea/PULL_REQUEST_TEMPLATE.md`, any `.md` files inside `.gitea/PULL_REQUEST_TEMPLATE/`, and the same root-level and `docs/` fallbacks GitHub supports. On Azure DevOps, inspect `.azuredevops/pull_request_template.md`, any branch-specific `.md` files inside `.azuredevops/pull_request_template/branches/`, `docs/pull_request_template.md`, and root-level `pull_request_template.md`. Match the repo's actual filename casing when present. When multiple template files exist in the directory path, choose the single template that best matches the current PR scope and treat it as the selected repo template for this run.</item>
          <item>Write `/tmp/pr-body.md` using the shipped diff, the recovered conversation, and the `pr-writing-guide` section below. When a selected repo template exists, use it as the starting scaffold for `/tmp/pr-body.md`: preserve its reviewer-facing headings, checklist items, and other required structure, replace placeholder guidance with final content, and merge the `pr-writing-guide` substance into that scaffold instead of replacing the template. When no repo template exists, structure the body per the `pr-writing-guide` section below. If the current PR body is non-contract relative to the selected repo template or the fallback Roomote contract, rebuild it from the final shipped diff instead of preserving unrelated old sections from that body.</item>
          <item>Preserve only still-applicable metadata from the current PR body: the caller-supplied PR provenance block as the opening blockquote, `## Related PRs` links identified by the current PR body or task context, and current valid proof artifact sections.</item>
          <item>Preserve or refresh `## Linked work items` when the current PR body or current workflow instructions identify linked work items. When the current workflow instructions include a pre-rendered linked-work-item block for this run, include that block verbatim and do not rewrite provider-specific closing or reference syntax.</item>
          <item>When the latest `capture-visual-proof` handoff reports an uploaded artifact list from `manage_artifacts` upload results, treat it as the authoritative proof-section input. Proof sections are only `## Screenshots` and `## Screencasts` when current artifact links exist. Render screenshots from the reported screenshots only when present, embedding each screenshot as `![<shot-description>](<rawUrl>)` so the image renders inline in the PR body; do not create `## Visual proof` for screenshots and do not render screenshot artifact viewer links when `rawUrl` exists. Render screencasts from the reported screencasts only when present using `[![<clip-name>](<first-keyframe-rawUrl>)](<video-viewUrl>)`, plus a caption line below each embed, where `<video-viewUrl>` is the clip's uploaded `viewUrl`. Remove any existing `## Screenshots` or `## Screencasts` section whose latest reported set is empty so stale evidence is not preserved.</item>
          <item>When that uploaded artifact list does not exist and the latest proof handoff is an honest no-op result because this cycle did not run `capture-visual-proof`, preserve existing `## Screenshots` and `## Screencasts` sections only when they already contain valid artifact URLs or screencast embeds. When the latest proof handoff reports that browser proof is not applicable, unnecessary, or blocked, remove existing `## Screenshots` and `## Screencasts` sections instead of preserving stale proof from an earlier cycle. Only when screenshot `rawUrl` values are still available from the latest proof handoff should the screenshot-only fallback include `## Screenshots`.</item>
          <item>Derive a refreshed PR title per the `pr-writing-guide` section below.</item>
          <item>Before the refresh call, validate the exact title and `/tmp/pr-body.md` against the PR writing guide. The title must begin with exactly one approved bracketed type tag. When a selected repo template exists, the body must preserve the template's reviewer-facing headings, checklist items, and required structure, replace placeholder guidance with final content, and cover the same reviewer substance the `pr-writing-guide` requires without forcing Roomote-only headings that the template does not use. When no repo template exists, the body must include `## What changed`, `## Why this change was made`, and `## Impact`. Do not add legacy top-level sections such as `## Summary`, `## Changes`, `## Validation`, `## Checks`, or `## Status` for routine successful runs unless the selected repo template explicitly requires them. Treat this as a hard gate: if the metadata fails, rewrite it and re-check before running the source-control mutation.</item>
          <item>When the latest `get_pull_request` result confirms the pull request is open, refresh it with `mcp__roomote__manage_source_control` `action: "create_or_update_pull_request"`, passing `repositoryFullName`, `sourceBranch` and `targetBranch` from that result, the refreshed `title`, `body` set to the exact `/tmp/pr-body.md` contents, and `prAttribution` when the conversation establishes a clear participant. The refresh never flips draft status: the platform preserves the pull request's existing draft state on update.</item>
          <item>When no open pull request exists for the branch, report a blocker instead of refreshing: `create_or_update_pull_request` would open a new pull request, and `fix-pr` must never create one. Verify the open state from `get_pull_request` before calling the tool.</item>
        </pr-metadata-update-recipe>
        <pr-writing-guide>
          <pr_title_format>
            <format>[Type] user-facing description</format>
            <types>
              <type name="feat">New capability or behavior visible to the user.</type>
              <type name="fix">Bug fix. Description must use the pattern "... when user [does X]" or "... [user-visible symptom]" so the title names the symptom, not the code fix.</type>
              <type name="improve">Enhancement to existing behavior, UX polish, or quality-of-life change.</type>
              <type name="refactor">Code restructuring with no user-visible behavior change.</type>
              <type name="docs">Documentation-only change.</type>
              <type name="chore">Dependency updates, config, CI, infra, or other non-functional maintenance.</type>
            </types>
            <scope>Use a single bracketed type tag such as `[Fix]` or `[Feat]`, then continue with the user-facing description in plain text.</scope>
            <description_rules>
              <rule>Start every title with exactly one singular bracketed type tag such as `[Fix]`, `[Feat]`, `[Improve]`, `[Refactor]`, `[Docs]`, or `[Chore]`.</rule>
              <rule>Keep the bracket contents to the type only, using forms like `[Fix]`, `[Feat]`, `[Improve]`, `[Refactor]`, `[Docs]`, or `[Chore]`.</rule>
              <rule>Follow the bracketed type tag with a space and then the description.</rule>
              <rule>Lead with what the user sees or can do, not the implementation detail.</rule>
              <rule>Write the user-facing description in sentence case. Capitalize the first word after the bracketed tag and preserve proper nouns and acronyms.</rule>
              <rule>For fixes, frame as the user-visible symptom: "task list fails to load when user has no environments", not "add null check to getTaskList query".</rule>
              <rule>For non-fix titles, use present-tense imperative mood.</rule>
              <rule>For features, name the capability: "Add bulk-cancel action to task dashboard", not "implement BulkCancelButton component".</rule>
              <rule>For improvements, name the better experience: "Show environment name in task status notifications", not "pass env name through notification context".</rule>
            </description_rules>
            <examples>
              <example type="fix">[Fix] Task list fails to load when user has no environments</example>
              <example type="feat">[Feat] Add bulk-cancel action to task dashboard</example>
              <example type="improve">[Improve] Show environment name in task status notifications</example>
            </examples>
          </pr_title_format>
          <pr_body_sections>
            <section name="What changed">
              <guidance>Summarize the shipped change in reviewer-facing terms. For fixes, describe the broken behavior and the visible correction. For features or improvements, name the new capability or better experience. For refactors, docs, and chores, describe the internal or maintenance change plainly without inventing user-facing drama. Avoid file-by-file narration.</guidance>
            </section>
            <section name="Why this change was made">
              <guidance>One or two sentences connecting the change to the motivation or risk it addresses. Mention the user problem, new capability, maintenance goal, or reviewer-relevant constraint as appropriate. Include implementation detail only when it helps the reviewer understand outcome or risk.</guidance>
            </section>
            <section name="Impact">
              <guidance>Describe the effect of the change. Lead with the concrete user-visible result when there is one. When there is no intended user-facing change (for example refactor, docs, or chore work), say so plainly and state the operational, maintenance, or reviewer-visible benefit instead.</guidance>
            </section>
            <section name="Validation">
              <guidance>Do not include this as a standalone PR body section for routine successful runs. Mention validation only when a check failed, was skipped or unavailable, materially changes reviewer confidence, or the user explicitly asked for it, and then fold that caveat into the relevant existing section instead of adding `## Validation`, `## Checks`, or `## Status`.</guidance>
            </section>
            <section name="Related PRs">
              <guidance>Include only when the same task ships through multiple pull requests and sibling PR URLs can be recovered honestly from the current PR body or live task context. Link the sibling PRs with short labels such as repository names or frontend/backend. Omit the current PR, and remove stale links when the task split changes.</guidance>
            </section>
          </pr_body_sections>
        </pr-writing-guide>
        <validation>The PR title/body now describe the actual shipped diff and the latest retained proof result rather than stale fixer workflow history.</validation>
      </step>

      <step number="10">
        <title>Resolve only genuinely fixed review threads and patch the canonical fixer comment</title>
        <description>Reflect the true shipped result back onto the pull request without overstating what was fixed.</description>
        <actions>
          <action>Before final closeout, refresh mutable provider state that affects the truthfulness of the report when needed by re-running `list_pull_request_comments`, including review-thread resolution state.</action>
          <action>Resolve only the review threads that were genuinely addressed in the pushed code, using `mcp__roomote__manage_source_control` with `action: "resolve_pull_request_thread"`, the thread's `threadId`, and `resolved: true`. When the result reports `applied: false` because the provider does not expose thread resolution, treat that as a non-blocking capability gap and say so in the final comment instead of implying the thread was closed.</action>
          <action>For any candidate finding dismissed as invalid, stale, or out of scope, leave a short factual reply on the corresponding review thread with `action: "reply_to_pull_request_comment"` explaining why it is not being addressed. Do not edit the original review comment or any prior review-thread comments to record the dismissal.</action>
          <action>For any dismissed candidate finding that still appears as an unresolved checklist item in the canonical Roomote review summary, patch that summary comment in place with `action: "update_pull_request_comment"` and its `commentId` so the entry becomes a struck-through plain markdown bullet like `- ~~Short finding text~~ — dismissed: brief factual reason.` rather than a checked or unchecked checkbox item. This summary-bookkeeping exception does not allow rewriting previous review comments.</action>
          <action>Do not describe dismissed findings as fixed, and do not auto-resolve their review threads by default unless a separate higher-confidence closure policy explicitly applies.</action>
          <action>Treat thread-resolution failures as non-blocking after a successful push, keep the pushed code result, and report the thread-resolution gap accurately instead of implying the thread was closed.</action>
          <action>Patch the canonical fixer comment in place with `action: "update_pull_request_comment"` using the recorded `commentId` (and `threadId` for review-thread surfaces), keeping the hidden marker first, keeping `task_link_see` inline on the final summary when it is available, and including the real commit link in the final comment. Limit that in-place edit to this run's own `roomote-pr-fix` surface; do not manually edit previous review comments, and prefer replies or new comments for any other PR discussion outcome.</action>
          <action>Append the revert link only when `revert_commit_base_url` is available.</action>
          <action>Do not treat code push, local validation, or PR metadata refresh as sufficient completion on their own; this step is required closeout for the fixer workflow.</action>
        </actions>
        <validation>The thread state and canonical fixer comment accurately describe the real pushed result, including any unresolved or unresolvable thread gaps.</validation>
      </step>
    </steps>

  </phase>

  <phase name="validation">
    <description>Verify that the code, review-thread state, and final fixer report all describe the same completed work.</description>
    <steps>
      <step number="11">
        <title>Verify end-to-end fixer consistency</title>
        <description>Make sure the pushed commit, refreshed PR metadata, validation results, thread state, and final comment all align.</description>
        <actions>
          <action>Confirm the implemented fix set still matches the triggering request or recovered issue inventory.</action>
          <action>Confirm the pushed commit, refreshed PR title/body, validation summary, review-thread state, and canonical fixer comment all describe the same shipped result.</action>
          <action>Confirm no unrelated cleanup was reported as part of the requested fix set.</action>
        </actions>
        <validation>The workflow ended with one coherent fixer outcome that matches both the repository state and the provider reporting state.</validation>
      </step>
    </steps>
  </phase>

<completion_criteria>
<criterion>The repository and pull request were identified from live context or trustworthy same-run context.</criterion>
<criterion>When the target PR was conflicted, merge conflicts were resolved through the canonical conflict-resolution skill before the main fixer flow proceeded.</criterion>
<criterion>The triggering request was classified correctly as a thread reply, `fixId` request, top-level PR comment, or broad fix-all request.</criterion>
<criterion>The requested issues were fixed without unrelated churn and validated proportionally.</criterion>
<criterion>When the pushed fixer result changed repository files, the workflow continued in the current task/session by loading `capture-visual-proof` for that shipped result, kept browser capture inside that step on the `agent-browser` path, and carried the proof result or blocker honestly into PR metadata refresh.</criterion>
<criterion>The fixes were pushed to the existing PR branch, and the PR title/body were refreshed from the final shipped diff.</criterion>
<criterion>When the refreshed PR belongs to a split multi-PR task and sibling PR links were available, the updated PR body keeps those related-PR references current.</criterion>
<criterion>The canonical fixer comment and any resolved review threads accurately reflect the actual shipped result.</criterion>
</completion_criteria>
</workflow>

<best_practices>
<guideline priority="high">
<rule>Prefer supplied PR context when it already covers the snapshots and identifiers you need; fetch or revalidate only the missing or mutable provider state. For broad PR-fix requests, a recovered review summary may bootstrap the issue list, but it does not replace live review-comment inspection or later thread closeout.</rule>
<rationale>The builder already assembled useful pull-request context for this workflow. Reusing it avoids redundant fetches while still allowing targeted revalidation before side effects.</rationale>
<exceptions>Only skip a fetch when the exact data was already retrieved earlier in the same run and is still current.</exceptions>
</guideline>
<guideline priority="high">
<rule>Prefer the triggering request over generic PR cleanup.</rule>
<rationale>The fixer should resolve what was actually requested, not opportunistically refactor unrelated code.</rationale>
<exceptions>Broader cleanup is acceptable only when required to safely implement the requested fix.</exceptions>
</guideline>
<guideline priority="high">
<rule>Treat pull-request closeout as part of the fix itself, not as optional reporting.</rule>
<rationale>The purpose of this workflow is to resolve PR feedback in both code and the PR discussion. Stopping after push leaves the discussion stale and makes the workflow incomplete even when the code is correct.</rationale>
<exceptions>Only skip closeout actions when the provider itself is blocked; in that case report the exact gap honestly in the canonical fixer comment.</exceptions>
</guideline>
<guideline priority="high">
<rule>Use PR operational state only to keep fixer execution honest; do not duplicate standalone delivery or merge-resolution workflows here.</rule>
<rationale>The fixer needs enough mergeability, fork, and check-state awareness to report truthfully and choose the right push target, but conflict resolution and generic delivery orchestration already have a canonical owner elsewhere.</rationale>
<exceptions>None.</exceptions>
</guideline>
<guideline priority="high">
<rule>Use the latest Roomote review summary as the canonical issue inventory for broad requests when it can be recovered safely.</rule>
<rationale>Broad requests such as "fix all unresolved issues" need one stable source of truth for the issue list.</rationale>
<exceptions>When the request is narrow and explicit, fix only the requested subset.</exceptions>
</guideline>
<guideline priority="high">
<rule>Keep exactly one canonical fixer comment and update it in place.</rule>
<rationale>One durable fixer comment keeps the PR thread legible and makes later follow-up runs easier to recover.</rationale>
<exceptions>None.</exceptions>
</guideline>
<guideline priority="high">
<rule>Do not manually edit previous review comments. Replying or adding new comments is ok.</rule>
<rationale>Prior review comments are historical discussion. Editing them rewrites the review record and can erase reviewer context; replies and new comments keep the timeline intact while still closing the loop after a push.</rationale>
<exceptions>In-place `update_pull_request_comment` is allowed only for this run's own `roomote-pr-fix` canonical fixer comment and the explicitly required `roomote-review-summary` checklist bookkeeping. Never use it on original or prior review-thread comments.</exceptions>
</guideline>
</best_practices>

<patterns>
  <pattern name="live_pr_fetch">
    <description>Resolve repository and pull-request identifiers first, then fetch the live diff, discussion, and enough PR operational state to know whether the fixer must resolve merge conflicts before the main fix flow can proceed.</description>
    <context>Use for every standalone PR fixer run launched directly or via `implement-changes`.</context>
    <template>resolve repo and PR -> use supplied snapshots when present -> fetch missing PR state including mergeability/fork metadata -> if conflicted, delegate to `resolve-github-pr-merge-conflicts` and then re-fetch live PR state -> fetch review and issue comments -> recover any missing linked-issue context -> checkout refreshed PR branch -> repository reading -> revalidate mutable state before side effects when needed</template>
  </pattern>
  <pattern name="broad_fix_inventory">
    <description>Recover a stable issue inventory for broad fix-all requests from the latest Roomote review summary before falling back to unresolved review comments.</description>
    <context>Use when the triggering request is not anchored to one specific thread.</context>
    <template>find latest `roomote-review-summary` comment -> parse only unchecked checklist items -> ignore checked and dismissed history lines -> inspect the live review comments for each in-scope candidate -> if summary is missing, enumerate unresolved Roomote review comments -> turn results into concrete fix list or dismissals</template>
  </pattern>
  <pattern name="thread_scoped_fix">
    <description>Keep narrow thread replies tied to one line-specific review-thread surface and fix only the scoped issue unless broader fallout requires adjacent updates.</description>
    <context>Use for review-comment replies or `fixId` requests.</context>
    <template>recover exact review comment -> inspect diff hunk and surrounding code -> implement focused fix -> validate -> reply in same thread -> resolve only if genuinely fixed</template>
  </pattern>
  <pattern name="canonical_fixer_comment">
    <description>Maintain one canonical fixer acknowledgment/comment surface with a hidden marker and update it in place.</description>
    <context>Use for both line-specific and top-level fixer runs.</context>
    <template>recover or create fixer comment -> keep `roomote-pr-fix` marker first -> keep comment text plain -> patch same comment family through completion</template>
  </pattern>
  <pattern name="no_prior_review_comment_edits">
    <description>Keep prior review comments immutable while still closing the loop after code is pushed to the PR.</description>
    <context>Use whenever the fixer needs to report status, dismissals, or outcomes on existing review discussion.</context>
    <template>leave prior review comments unchanged -> reply on the thread or create a new comment -> reserve `update_pull_request_comment` for this run's `roomote-pr-fix` surface and allowed summary bookkeeping only</template>
  </pattern>
</patterns>

<decision_guidance>
<principles>
<principle>Prefer requested fixes over unrelated cleanup.</principle>
<principle>Prefer repository truth over inferred intent.</principle>
<principle>Prefer accurate PR-thread reporting over optimistic status updates.</principle>
<principle>Prefer the final shipped diff over stale fixer workflow history when refreshing PR metadata.</principle>
</principles>
<constraints>
<constraint>Do not discard supplied PR context when it already provides the needed snapshot or identifier. Revalidate mutable provider state before push, comment-patch, PR-edit, or thread-resolution side effects when freshness matters.</constraint>
<constraint>Do not treat a recovered `roomote-review-summary` comment as a substitute for inspecting the live review comments needed to implement or close out the selected fixes.</constraint>
<constraint>Do not duplicate the merge-conflict resolution procedure inside this workflow. When mergeability state shows the fixer cannot proceed normally because the PR is conflicted, resolve that preflight through the canonical merge-conflict skill and resume the fixer only after refreshed live state confirms the PR can proceed honestly.</constraint>
<constraint>Do not treat a broad request as permission to refactor unrelated areas.</constraint>
<constraint>Do not create a new branch or a new pull request from this workflow.</constraint>
<constraint>Do not claim an issue is fixed unless the code and validation both support that claim.</constraint>
<constraint>Do not run a local screenshot or screencast procedure outside `capture-visual-proof`; when repository-file-changing fixes require proof before PR metadata refresh, load that skill and capture proof there.</constraint>
<constraint>Do not switch to Playwright, manual browser use, browser devtools, or any other browser automation path for visual proof in this workflow; `capture-visual-proof` defines the approved `agent-browser` path.</constraint>
<constraint>Do not resolve review threads that were not genuinely fixed in code.</constraint>
<constraint>Do not treat a dismissed, invalid, stale, or out-of-scope finding as fixed, and do not resolve its review thread by default.</constraint>
<constraint>Do not manually edit previous review comments with `update_pull_request_comment`. Replying with `reply_to_pull_request_comment` or adding a new comment with `create_pull_request_comment` is the correct way to respond on earlier review discussion. The only in-place comment edits this workflow may perform are this run's own `roomote-pr-fix` canonical fixer comment and the explicitly required `roomote-review-summary` checklist bookkeeping.</constraint>
<constraint>Do not stop after code push alone. For this workflow, pull-request closeout is mandatory unless an explicit blocker prevents it.</constraint>
</constraints>
<boundaries>
<rule>This workflow handles implementing fixes requested through pull-request review threads and PR comments, running any required `capture-visual-proof` step before PR metadata refresh, and then reporting those fixes back into the PR discussion.</rule>
<rule>This workflow may inspect mergeability and fork state to determine whether it can proceed honestly, and it owns the decision to trigger merge-conflict preflight through the canonical conflict skill before resuming normal fixer execution. It does not own generic PR delivery orchestration or the conflict-resolution mechanics themselves.</rule>
<rule>This workflow does not perform a fresh full PR review; it responds to requested fixes within the PR context.</rule>
<rule>When the trigger or issue inventory remains ambiguous after live fetches, ask a focused clarification question and stop instead of guessing.</rule>
<rule>A run that changes code but leaves the PR discussion state untouched is incomplete for this workflow.</rule>
</boundaries>
</decision_guidance>

<error_handling>
<scenario name="missing_pr_identifier">
<problem>The workflow cannot determine which pull request should be fixed.</problem>
<causes>
<cause>The request omitted the repository or PR number.</cause>
<cause>The current checkout is not on a resolvable pull request.</cause>
</causes>
<recovery>Ask for the missing identifier and stop instead of guessing.</recovery>
</scenario>
<scenario name="missing_thread_anchor_for_narrow_request">
<problem>A narrow request references one review issue, but the exact review-thread anchor cannot be recovered safely.</problem>
<causes>
<cause>The request mentions a line-specific issue without a review-comment identifier, URL, or recoverable `fixId`.</cause>
<cause>The original review comment was deleted or is no longer accessible.</cause>
</causes>
<recovery>Ask for the missing review-comment link or identifier, or explicitly fall back to a broader PR-fix request if the user confirms that scope change.</recovery>
</scenario>
<scenario name="missing_summary_for_broad_request">
<problem>A broad request asks to fix all unresolved issues, but the canonical Roomote review summary cannot be recovered.</problem>
<causes>
<cause>The PR does not contain the expected summary comment.</cause>
<cause>The top-level summary comment was deleted or is inaccessible.</cause>
</causes>
<recovery>Fall back to unresolved Roomote review comments when they can be enumerated safely; otherwise ask the user to narrow the scope or supply the missing summary anchor.</recovery>
</scenario>
<scenario name="conflict_resolution_failed_before_fixer_resume">
<problem>The PR was conflicted, but the delegated merge-conflict resolution step did not complete successfully, so the fixer cannot continue honestly.</problem>
<causes>
<cause>The canonical merge-conflict skill reported a blocker or could not produce a clean pushed resolution.</cause>
<cause>The refreshed PR state still shows conflicts or another non-mergeable condition that blocks normal fixer execution.</cause>
</causes>
<recovery>Report the exact conflict-resolution blocker, stop before main fixer implementation, and do not claim the PR-feedback fixes were attempted or shipped.</recovery>
</scenario>
<scenario name="thread_resolution_failure_after_push">
<problem>The code was pushed successfully, but thread-resolution updates failed or only partially succeeded.</problem>
<causes>
<cause>The thread was already closed, missing, or no longer patchable.</cause>
<cause>The provider rejected one or more thread-resolution calls, or does not expose thread resolution.</cause>
</causes>
<recovery>Keep the pushed result, report the exact thread-resolution gap honestly in the canonical fixer comment, and do not imply that the thread was closed when it was not.</recovery>
</scenario>
<scenario name="code_pushed_but_closeout_not_attempted">
<problem>The implementation was pushed, but the run stopped before updating the PR discussion state.</problem>
<causes>
<cause>The fixer treated push as the terminal milestone instead of continuing into PR closeout.</cause>
<cause>The workflow focused on repository state and never attempted canonical comment patching or thread resolution.</cause>
</causes>
<recovery>Resume the same PR-fixer run state: refresh PR metadata if needed, patch the canonical fixer comment, resolve genuinely fixed review threads, and only then report completion.</recovery>
</scenario>
</error_handling>
