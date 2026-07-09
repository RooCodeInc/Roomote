---
title: Roomote Workflow Contracts
status: active
last_reviewed: 2026-07-01
owner: engineering
summary: Detailed contract reference for Roomote's workflow prompt builders, OpenCode system and developer instruction layering, strict core pathway rules, proof handoffs, and the shipped standard packaged-skill workflows.
---

# Roomote Workflow Contracts

This page is the contract-level companion to [Workflow System](./workflow-system.md). It captures the detailed mechanics that shape runtime behavior: prompt layering, `standardTask()` orchestration rules, builder-specific entry contracts, and the execution contracts of the shipped `standard` packaged-skill catalog.

Use this page when you need the behavior contract itself, not just the workflow inventory.

## Prompt And Instruction Stack

A Roomote task is not driven by one prompt string. The workflow contract is assembled from layers, each with a different responsibility.

### Product control layers vs OpenCode text channels

The repo docs now distinguish two views of the same runtime:

- **OpenCode text channels**: `model_instructions_file`, `developer_instructions`, and `prompt`
- **Roomote control layers**: system prompt, workflow envelope, core pathway layer, startup task prompt, and broader skill catalog

That distinction matters because the strict `implement / plan / explain` first-hop pathway and the active skill catalog both materially control behavior, but neither is a separate OpenCode text field on its own.

### Global prompt and runtime layers

- The global product voice and overall OpenCode behavior live in [`ROOMOTE_SYSTEM_PROMPT`](../../packages/cloud-agents/src/system-prompt.ts), while the compaction override lives in [`ROOMOTE_COMPACT_PROMPT`](../../packages/cloud-agents/src/compact-prompt.ts).
- That system-prompt layer also owns the cross-surface user-facing behavior contract: intermediary-update tone, concise response-shape expectations, the generic communication-milestone policy, and the rule that internal packaged-skill names or transitions should not be narrated in ordinary user-visible updates unless the user explicitly asks.
- The worker writes workflow-owned `harnessInstructions` plus formatted `<environment-instructions>` into OpenCode `developer_instructions` at task runtime. That layer carries environment-specific constraints, available services, browser targets, and task-scoped runtime guidance without owning the top-level persona.
- The worker chooses the packaged skill catalog at task startup and activates it in the agent home before the run begins.

### Workflow-owned layers

- Prompt-builder workflows in [`packages/cloud-agents/src/server/workflows/`](../../packages/cloud-agents/src/server/workflows/) decide the initial task contract for a task type.
- `standardTask()` is the main orchestration wrapper for Generalist work and determines the run-specific workflow envelope, the strict initial `implement / plan / explain` pathway selection, execution mode policy, todo policy, and child-skill delegation rules.
- The three `implement-changes`, `plan-repo-implementation`, and `explain-repo-code` pathways are first-class workflow controls for ordinary Generalist requests, not merely three arbitrary entries in the broader skill catalog.
- Packaged skills in [`packages/cloud-agents/src/server/workflows/skills/standard/`](../../packages/cloud-agents/src/server/workflows/skills/standard/) own the broader execution mechanics once a run enters the `standard` catalog or explicitly invokes a packaged workflow.
- Channel wrappers such as Slack and Linear extend the same underlying task contract with channel-specific communication obligations.

For the broader layering model, see [Roomote Agent Context](./agent-context.md).

## `standardTask()` Contract

[`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts) is the core workflow orchestrator for delegated Generalist work.

### Initial routing contract

- If the user begins with an explicit Roomote packaged-skill invocation, `standardTask()` treats that as authoritative and skips ordinary three-way routing.
- Otherwise it routes the request into exactly one of these core directions as a first-class pathway layer for normal Generalist work:
  - [`implement-changes`](../../packages/cloud-agents/src/server/workflows/skills/standard/implement-changes/SKILL.md)
  - [`plan-repo-implementation`](../../packages/cloud-agents/src/server/workflows/skills/standard/plan-repo-implementation/SKILL.md)
  - [`explain-repo-code`](../../packages/cloud-agents/src/server/workflows/skills/standard/explain-repo-code/SKILL.md)
- The [`implement-repo-change`](../../packages/cloud-agents/src/server/workflows/skills/standard/implement-repo-change/SKILL.md) entry maps to the canonical `implement-changes` workflow for explicit invocations.
- Repo-local skills are not allowed to act as first-hop routers for ordinary natural-language requests. They are helper context only after a Roomote-owned workflow is active.
- Ambiguous ordinary requests default to `implement-changes`.
- For ordinary natural-language requests, first-hop selection is executable, not advisory: the agent must enter the selected packaged workflow before repository exploration, file edits, validation, or final reporting. The wrapper should not be treated as a substitute implementation workflow.

### Prompt-shape contract

- `standardTask()` returns `prompt` separately from `harnessInstructions`; they
  are not interchangeable channels.
- `prompt` is the first task message. For plain delegated work it is a
  `<request>...</request>` wrapper around the task description.
- `harnessInstructions` carry the workflow contract, execution policy, todo
  policy, and wrapper-specific runtime rules that the worker later writes into
  OpenCode `developer_instructions`.
- When the launching payload identifies the task's source-control provider,
  `standardTask()` injects a `<source_control_context>` block naming the
  provider, pointing PR/MR delivery at the Roomote MCP `manage_source_control`
  tool, and, for non-GitHub providers, warning that GitHub-only CLI commands
  such as `gh pr` and `gh api` cannot operate on the task repositories.
- The first-hop pathway choice is part of that workflow-owned control layer. It
  is expressed through builder-owned rules and the selected packaged path, not
  through a fourth OpenCode text field.
- Product-wide user-facing style stays in the system prompt instead of this
  workflow layer.
- When `requestFormat: 'structured'` is used, `standardTask()` preserves a
  recognized leading packaged-skill invocation on the first line and wraps only
  the remaining body in `<request>...</request>`.
- Changing builder-owned request text affects the task payload seen by the
  model. Changing `harnessInstructions` affects the orchestration and policy
  layer around that task.

### Execution-mode contract

- Autonomous mode is the default unless the task explicitly starts interactive.
- The deployment-level `prAction` setting (Settings > Source Control, stored in deployment public metadata) selects the default delivery skill for repository-changing runs: `draft` (default) finishes through `create-draft-pr`, `create` through `create-pr`, and `push` through `push`. `generatePrompt()` resolves it once per launch and threads it through `standardTask()`, `slackAppMention()`, and `linearAgentSession()`.
- Interactive mode pauses before final push/PR actions unless the user explicitly invokes a push/PR skill.
- Repository-changing `implement-changes` runs must remain active until they reach the required delivery state; local edits and validation are not treated as a finish line.
- For repository-changing `implement-changes` runs, targeted validation and the parent self-review loop happen before delivery.
- When repository files changed, the active `implement-changes` run must still hand off to [`capture-visual-proof`](../../packages/cloud-agents/src/server/workflows/skills/standard/capture-visual-proof/SKILL.md) before delegated delivery continues, and the parent workflow must not expose or directly use browser tooling.
- Failed, skipped, or unavailable validation is reviewer-facing context for delegated delivery, not a replacement for that delivery. When the implementation is still the intended shipped diff, the validation gap must be carried into `push`, `create-pr`, or `create-draft-pr` instead of ending the run with a local summary.
- `capture-visual-proof` no-op, non-applicable, unnecessary, or blocked results are also delivery inputs, not terminal closeout states. Repository-changing autonomous runs must continue into the configured delivery skill after the proof result is known.
- The final delivery step is delegated to one of `push`, `create-pr`, or `create-draft-pr`, based on agent settings and run mode.

### Todo-management contract

- Multi-step work must create a concrete live todo list before deep exploration.
- The todo list is treated as a user-visible execution state, not a hidden scratchpad.
- Workflow-specific todo requirements override the generic short-plan default when necessary.
- Scope changes must rewrite the live plan rather than leaving stale steps in place.
- Completion-style responses must reconcile the visible plan with actual task state.

### Delegation contract

- Once a workflow is selected, the selected skill owns the execution contract.
- Child-skill delegation stays inside the active parent workflow; it is not a post-completion phase.
- Do not conflate child-skill delegation with product-level Roomote agent selection. The current OpenCode runtime does not expose packaged role-agent TOMLs or nested child processes; delegated capture runs inside the hidden worker-registered `proof-runner` OpenCode subagent.
- Workflow transitions are allowed later in the run when the conversation clearly calls for them.
- Internal packaged-skill selection is still treated as implementation detail, but that user-facing non-narration rule now lives in the system prompt rather than in `standardTask()` itself.

### Request-user-input contract

- `request_user_input` is preferred when several related decisions block the same next step or when structured/private input helps.
- Slack-started runs have an extra carveout: lightweight non-secret clarification can stay in-thread first.

## Channel Wrapper Contracts

### Slack wrapper

[`slackAppMention()`](../../packages/cloud-agents/src/server/workflows/slackAppMention.ts) layers Slack-specific obligations on top of `standardTask()`.

It requires:

- interpreting `<slack_message>`, `<replying_to>`, and `<thread_context>` as an ongoing Slack conversation
- a Slack turn lifecycle: `ack` before substantial work that will not post to Slack when the answer is not immediate, `progress` only for new decision-useful state or timed silence prevention, and `closeout` when there is an answer, completion, blocker, or handoff
- a no-routine-heartbeat rule that still allows a concise in-thread Slack-visible progress update when same-phase investigation, patching, validation, CI/review-waiting, or proof-capture work has gone more than 10 minutes without one
- a closeout reply for the same turn once there is an answer, completion, blocker, or handoff
- using `send_chat_reply` for user-visible Slack lifecycle replies, and `post_to_slack_channel` for explicit off-thread delivery instead of relying on commentary updates
- posting uploaded screenshots back into Slack when image proof artifacts are generated and visible proof is part of the workflow result
- treating screencasts as retained proof artifacts for PR descriptions or text links rather than in-thread Slack attachments, because the current Slack MCP artifact-attachment path is image-only
- preferring concise, link-friendly Slack replies without internal reasoning or tool logs

Mechanically, the Slack wrapper splits its work across the same two prompt
surfaces as `standardTask()`:

- Slack thread history, `<replying_to>`, `<thread_activity>`, and the current
  `<slack_message>` are folded into the builder description and end up in the
  returned `prompt`.
- Slack-specific reply obligations, formatting rules, and tool-usage policy are
  appended to `harnessInstructions`, which means they later flow into OpenCode
  `developer_instructions` rather than the first user message.

#### Slack block-budget contract

Any helper that builds or trims Slack block arrays has to budget against the
final assembled payload, not just the subsection it is currently appending.

- Compute the remaining content budget as the Slack hard limit (`50`) minus any
  quote/context blocks, image blocks, footer blocks, action blocks, or other
  structural blocks that the final payload will append.
- Treat `maxBlocks`-style parameters as the total remaining budget for all
  blocks the helper contributes, not as a per-section allowance that ignores
  later summary, action, footer, or media blocks.
- Unit tests for Slack block-building helpers should assert that the final
  assembled block array stays within Slack's 50-block limit.

### Linear wrapper

[`linearAgentSession()`](../../packages/cloud-agents/src/server/workflows/linearAgentSession.ts) is simpler:

- it formats issue title, description, previous comments, and the current comment into a structured task description
- it then hands that description directly to `standardTask()`
- it does not add a second workflow policy layer the way Slack does

Like Slack, the Linear wrapper hands builder-owned task context to
`standardTask()` as request content. Unlike Slack, it does not prepend a second
channel-policy block to `harnessInstructions`.

## GitHub Builder Contracts

### Initial PR review builder

[`githubPrReview()`](../../packages/cloud-agents/src/server/workflows/githubPrReview.ts) starts GitHub initial review runs by explicitly invoking `review-code`.

Its contract is:

- fetch PR context, diff, review comments, issue comments, and linked issue context before the task begins
- attach to a canonical top-level summary comment when possible
- route into the correct `review-code` appendix based on approval settings
- optionally relay the final review result back into the linked implementation task after the GitHub review is complete

### Sync PR review builder

[`githubPrReviewSync()`](../../packages/cloud-agents/src/server/workflows/githubPrReviewSync.ts) starts re-review after new commits.

Its contract is:

- recover the prior reviewed SHA and summary artifact
- fetch only the delta since that anchor when possible
- still emit an explicit `no_new_delta` outcome when the head SHA has not changed
- route into the sync-review appendix of `review-code`
- optionally relay the sync-review result back into the linked implementation task

### PR follow-up builder

[`githubPrReviewFollowUp()`](../../packages/cloud-agents/src/server/workflows/githubPrReviewFollowUp.ts) has two modes:

- explicit fix bootstraps invoke `fix-pr` directly and mark the active appendix as `fix-github-pr-feedback`
- mention-driven follow-up requests stay on the broader follow-up path and let `standardTask()` choose between implement, plan, explain, or later specialized transitions

The builder still preloads rich PR, diff, comment, and linked-issue context in both cases.

### Conflict-resolution builder

[`githubPrConflictResolve()`](../../packages/cloud-agents/src/server/workflows/githubPrConflictResolve.ts) builds a structured request that explicitly invokes `resolve-github-pr-merge-conflicts` and marks the active appendix path accordingly.

## Core Direction Contracts

### `implement-changes`

[`implement-changes`](../../packages/cloud-agents/src/server/workflows/skills/standard/implement-changes/SKILL.md) is the main mutation workflow. [`implement-repo-change`](../../packages/cloud-agents/src/server/workflows/skills/standard/implement-repo-change/SKILL.md) remains as a compatibility alias for older explicit invocations and resumed tasks.

#### Shared contract

- Child mutating skills may inherit its `core-contract`, but that does not authorize running the default path.
- The default path applies only when no explicit child path was selected.
- It owns the parent-level contract for implementation, validation, proof handoff, and delivery-state reporting.

#### Default phase contract

- **Analysis**: initialize tracking, ground the task in repository reality, and build a concrete implementation plan.
- **Implementation**: record the proof rule for the current iteration, make the actual repo change, and decide whether the run will later owe a `capture-visual-proof` handoff.
- **Validation**: run proportional validation, perform a self-review/fix loop, run the flagged pre-push review loop when enabled, reach the required delivery state, and report from the true end state.

#### Core gates and constraints

- Repository-file changes trigger a mandatory in-task proof handoff to `capture-visual-proof`.
- The parent workflow must not substitute Playwright, manual browser use, or local screenshot or screencast hacks for that proof step.
- Proof blockers and validation blockers are carried forward into delegated delivery when the repository change is still intended for review; they should appear as honest reviewer context instead of stopping PR creation.
- The run is incomplete if it stops after local edits or validation while push/PR delivery is still required.
- Child-path selection is appendix-based and must resolve to exactly one delegated path when needed.

#### Child-path registry

The workflow owns these named child paths:

- `create-pr`
- `create-draft-pr`
- `push-branch`
- `fix-github-pr-feedback`
- `resolve-github-pr-merge-conflicts`

It also defines user-facing aliases such as `push`, `draft PR`, `PR fixer`, and `merge conflict resolver`.

### `plan-repo-implementation`

[`plan-repo-implementation`](../../packages/cloud-agents/src/server/workflows/skills/standard/plan-repo-implementation/SKILL.md) is a planning-only workflow.

Its contract is:

- inspect the repository before asking avoidable questions
- separate discoverable repository facts from real user decisions
- stay non-mutating throughout the run
- produce a compact but decision-complete implementation plan
- publish the final plan through the plan-artifact mechanism before closing, then use chat or Slack only to summarize and link to that durable artifact
- serve as the conservative fallback for ambiguous first-hop asks when the implementation path is not obviously narrow and low-decision

### `explain-repo-code`

[`explain-repo-code`](../../packages/cloud-agents/src/server/workflows/skills/standard/explain-repo-code/SKILL.md) is an explanation-only workflow.

Its contract is:

- identify the explanation target
- read the real code before answering
- explain both behavior and rationale when the repository supports it
- match explanation depth to the question
- avoid implementation, mutation, or invented rationale

## Proof And Delivery Contracts

### `capture-visual-proof`

[`capture-visual-proof`](../../packages/cloud-agents/src/server/workflows/skills/standard/capture-visual-proof/SKILL.md) decides whether browser proof applies and returns one proof package. When invoked by `implement-changes` or another active parent workflow, that package is a handoff result for the parent, not the terminal closeout of the repository-changing task.

Its contract is unusually strict:

- always use the browser target or URL exposed by the current environment instructions
- capture proof in the real product surface, not a shortcut surface, unless explicitly requested
- keep Storybook as a constrained fallback only when the real product surface is blocked for infrastructure or reachability reasons, or when realistic setup still cannot reach the product state that contains the component or rendered claim, and the shipped change is Storybook-scoped or has a matching checked-in story that can prove the same rendered claim
- never treat Storybook fallback as equivalent to product proof when the real product surface is reachable but the implementation is simply wrong
- keep browser tooling contained inside the delegated `proof-runner` subagent instead of exposing it as a general packaged skill
- reuse the active Roomote browser session unless a second isolated session is actually needed
- treat rendered UI claims differently from non-visual provenance/lifecycle claims when deciding whether screenshots or screencasts are valid evidence
- keep the parent path thin: after analysis, delegate one proof brief per run to the hidden `proof-runner` subagent with the Task tool
- when the harness instructions do not state that a hidden `proof-runner` subagent is configured, report blocker type `proof runtime unavailable` instead of inventing another proof path
- treat artifact URLs from the subagent's report as canonical only when it attributes them to `manage_artifacts` upload tool results from that delegated run

Its phases are:

- **Analysis**: define proof scope, decide whether browser proof applies, choose `screenshot-only`, `screencast-only`, `both`, or `not applicable`
- **Execution**: delegate the proof brief to the `proof-runner` subagent when proof is needed; otherwise return a proof-runtime blocker
- **Reporting**: return a concise artifact-first proof result; when parent-invoked, frame it as a handoff result that the parent carries into delivery

The worker image still ships the `agent-browser` CLI for proof infrastructure, and the standard catalog now carries a hidden [`agent-browser`](../../packages/cloud-agents/src/server/workflows/skills/standard/agent-browser/SKILL.md) discovery stub that tells the agent to load CLI-served guidance first. That checked-in stub mirrors the upstream `vercel-labs/agent-browser` discovery file so Roomote does not drift into a second local browser-command guide. Command syntax and browser-session mechanics still stay in the installed CLI skill content plus the worker-owned `proof-runner` subagent prompt rather than turning `agent-browser` into a standard routed workflow.

### `agent-browser`

[`agent-browser`](../../packages/cloud-agents/src/server/workflows/skills/standard/agent-browser/SKILL.md) is a hidden discovery stub rather than a routed workflow.

Its contract is:

- if the user explicitly invokes `/agent-browser` or `$agent-browser`, `standardTask()` should hand off to the stub directly so it can redirect the agent into CLI-served browser guidance
- load `agent-browser skills get core` or `agent-browser skills get core --full` before issuing browser commands
- treat the installed CLI guidance as the source of truth for command syntax and current behavior
- keep the stub itself short so Roomote does not duplicate a second browser command reference in-repo
- do not treat the stub as a replacement for `capture-visual-proof` containment rules in parent workflows

### `push`, `create-draft-pr`, and `create-pr`

These three delivery skills share a basic delivery contract:

- detect single-repo vs multi-repo workspace shape
- enumerate changed repositories only
- derive per-repo base branch, delivery branch, commit, and PR metadata
- use the provided base/default branch to create the delivery branch; if no branch is provided for the run, use the repository default branch
- keep branch setup ahead of all delivery work: do not stage files, write `/tmp/pr-body.md`, commit, push, or mutate PRs while still on `main` or `master` unless the user explicitly selected that branch as the existing delivery branch for the task
- preserve git hooks unless there is no safe alternative
- report per-repo outcomes clearly

The PR-editing delivery skills [`create-draft-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/create-draft-pr/SKILL.md) and [`create-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/create-pr/SKILL.md) additionally share the PR metadata contract:

- create and refresh pull requests through the built-in Roomote MCP `manage_source_control` tool (`action: "create_or_update_pull_request"`), not through provider-specific CLIs such as `gh`; the platform resolves the task's source-control provider and mutates the PR/MR server-side
- `fix-pr` and `address-pr-feedback` use the same tool family for review interactions: `get_pull_request` for details (including mergeability and fork state), `list_pull_request_comments` for review threads with resolution state, `reply_to_pull_request_comment` / `create_pull_request_comment` / `update_pull_request_comment` for the canonical fixer comment and thread replies, and `resolve_pull_request_thread` for closeout; provider capability gaps surface as `applied: false` plus warnings and must be reported honestly rather than treated as failures
- `review-code` publishes findings through the same family: replies on existing threads when a matching file/line anchor exists, summary-carried findings with explicit `file:line` references otherwise (no provider-neutral API exists for new line-anchored inline comments), the canonical review summary comment patched in place via `update_pull_request_comment`, and approval via `submit_pull_request_review`
- pass the same base branch explicitly as `targetBranch` on every tool call, create or refresh; do not rely on the provider's repository default branch or local tracking branch
- treat the `manage_source_control` tool result as delivery truth; a closeout message or URL string is reporting evidence only, and the PR number and URL come from the tool result
- capture the shipped diff with local git (`git merge-base` against the base branch) for every provider instead of reading the remote pull request; still-applicable prior-body metadata is recovered from the previous `/tmp/pr-body.md` of an earlier delivery pass in the same task
- treat PR title/body as a function of the full shipped diff plus aligned task context
- own PR-linked work-item rendering through the shared PR metadata layer under `packages/cloud-agents/src/server/workflows/`, while source integrations only normalize provider-specific issue/task data into the canonical task-context shape consumed by delivery
- validate the exact PR title and `/tmp/pr-body.md` against the PR-writing guide before any `manage_source_control` call; non-contract titles or legacy body sections must be rewritten before the source-control mutation runs
- when provider-compatible assignee usernames are available in workflow context, pass them as `assignees` on the tool call

When a new integration can originate or resolve work items that should appear in PR metadata, the same change is expected to:

- add or update the canonical task-context mapping for those work items
- add or update the provider-specific renderer adapter in the shared PR metadata layer
- add targeted formatter or task-context tests
- update the relevant internal guidance in the same PR

Differences:

- [`push`](../../packages/cloud-agents/src/server/workflows/skills/standard/push/SKILL.md) stops after pushing branches and reports a follow-up PR command path
- [`create-draft-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/create-draft-pr/SKILL.md) creates or refreshes draft PRs and preserves draft state
- [`create-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/create-pr/SKILL.md) creates or refreshes ready-for-review PRs

## GitHub Review, Fix, And Merge Contracts

### `fix-pr`

[`fix-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/fix-pr/SKILL.md) is the canonical PR-feedback fixer.

Its contract is:

- resolve the target PR and triggering request from live GitHub state
- clear merge conflicts first through `resolve-github-pr-merge-conflicts` when needed
- classify the fixer mode from thread reply, `fixId`, top-level comment, or broad fix-all request
- create exactly one canonical fixer acknowledgment comment
- implement only the requested fixes on the existing PR branch
- validate, push, and then refresh PR metadata from the final shipped diff, replacing any existing non-contract PR body shape instead of preserving legacy sections
- resolve only genuinely fixed review threads
- patch the canonical fixer comment so GitHub-side state matches the shipped result

It has a hard completion gate: the run is incomplete if it stops after code changes or even after push but before GitHub-side closeout was attempted.

### `address-pr-feedback`

[`address-pr-feedback`](../../packages/cloud-agents/src/server/workflows/skills/standard/address-pr-feedback/SKILL.md) is a focused slash-command entrypoint, not a second fixer implementation.

Its contract is:

- resolve the current PR
- build the issue inventory from unresolved review threads only
- read every thread reply before deciding what still needs to be addressed
- delegate the actual repo edits, push, and PR closeout to `fix-pr`
- reply on handled threads and resolve only the threads that are fully addressed

### `review-code`

[`review-code`](../../packages/cloud-agents/src/server/workflows/skills/standard/review-code/SKILL.md) is a path family, not just one review mode.

#### Local workspace path

The base path is a four-step local review workflow:

- identify changed files
- read them in full with surrounding context
- review for discrete, provable issues
- present findings in a severity-ranked markdown table

#### GitHub initial review paths

The `review-github-pr` and `review-github-pr-with-approval` appendices add a much richer contract:

- resolve the target PR and create a full review todo list
- use supplied snapshots when available and revalidate mutable GitHub state before side effects
- fetch PR details, diff, review comments, issue comments, linked issues, and check state
- wait up to 10 minutes for pending required checks, then continue from the freshest available state
- create or reuse exactly one canonical top-level summary comment with a hidden `roomote-review-summary` marker and status/checklist blocks
- post one inline comment per diff-mappable actionable issue
- keep failing or still-pending required checks in the summary inventory even when they are not diff-mappable
- optionally send a structured `<review_result>` relay to the linked implementation task; `<code-review-results>` remains a compatibility wrapper for legacy or mutated relays
- in approval-enabled mode, approve only when the review is clean and the PR author is not a normalized Roomote-managed login

#### GitHub sync review paths

The `sync-github-pr-review` and `sync-github-pr-review-with-approval` appendices add delta-review mechanics:

- recover a trustworthy last-reviewed SHA from explicit context, marker-based summary state, or a review-comment fallback
- use legacy full-rereview only when a reusable legacy summary exists but no reliable anchor can be recovered
- scope the since-last-review delta to the PR's authoritative Files Changed (`base...head`): the compare range `lastReviewSha...head` uses three-dot semantics, so after a rebase it also contains base-branch commits, and those files are excluded from `diff_in_range`, `changed_files_since_last_review`, and the `pull_request_changed_files` scope hint so a rebase cannot import findings for code the PR does not touch (a rebase-only head change with no PR-relevant delta collapses to the no-op path)
- emit an explicit no-op path when there is no new delta
- surface only net-new actionable issues
- carry forward prior unresolved issues in the rolling summary instead of re-commenting them
- update the hidden summary marker to the new head SHA on each successful sync review
- optionally approve only after the rolling summary is final and the synced PR is clean

#### Merge-resolution review path

The `review-merge-resolution` appendix reviews a proposed merge-conflict resolution before commit by classifying findings into blocking, warning, or informational severity.

### `review-and-fix`

[`review-and-fix`](../../packages/cloud-agents/src/server/workflows/skills/standard/review-and-fix/SKILL.md) is a local inline review-and-fix workflow.

Its contract is:

- review current workspace changes first
- identify issues in the current diff
- implement fixes in the same run rather than only reporting findings
- stay scoped to current workspace changes rather than GitHub thread coordination

### `resolve-github-pr-merge-conflicts`

[`resolve-github-pr-merge-conflicts`](../../packages/cloud-agents/src/server/workflows/skills/standard/resolve-github-pr-merge-conflicts/SKILL.md) owns merge-conflict resolution.

Its contract is:

- merge the base branch into the PR branch instead of rebasing
- resolve conflicts by intent rather than by naïve side-picking
- preserve merge history
- classify findings with explicit HIGH, MEDIUM, and LOW severity definitions
- perform an integrated safety review before finalizing the merge commit
- validate the merged result and report the resolution clearly

## Specialized Support Contracts

### `debug-reported-bug`

[`debug-reported-bug`](../../packages/cloud-agents/src/server/workflows/skills/standard/debug-reported-bug/SKILL.md) is a reproduce-first diagnosis workflow.

Its contract is:

- attempt reproduction before deeper investigation
- use MCP-backed evidence gathering when it sharpens reproduction
- stop and ask for missing repro details if reproduction fails
- create a rerunnable failing check before using history tools
- use git history and `git bisect` only when the signal is stable enough
- finish with diagnosis and provenance only, never the fix

### `sentry-triage`

[`sentry-triage`](../../packages/cloud-agents/src/server/workflows/skills/standard/sentry-triage/SKILL.md)
is the shipped Sentry MCP triage workflow for workspace-scoped operational
review.

Its contract is:

- use the Sentry MCP available in task context as the primary evidence source,
  and keep follow-up work focused on code or instrumentation changes rather
  than direct Sentry issue-state mutations
- honor the requested scan window, project scope, Slack channel, and run mode
- keep scheduled or background runs read-only even when obvious archive, mute,
  merge, resolve, or reopen opportunities appear
- inspect new, regressed, trending, high-frequency, and unresolved issues and
  keep only the evidence needed to rank them
- prefer submitting up to five repository-targeted follow-up suggestions when
  repository scope and the suggestion tool are available
- otherwise post a concise Slack report when a Slack channel is provided
- mutate Sentry only when a human explicitly asks for a supported hygiene
  action in the current task
- end with a concise prioritized report or a clear auth/setup blocker

### `simplify`

[`simplify`](../../packages/cloud-agents/src/server/workflows/skills/standard/simplify/SKILL.md) is a behavior-preserving simplification workflow.

Its contract is:

- identify recently changed files from branch and workspace state
- load local guidance such as `AGENTS.md` and `CLAUDE.md`
- simplify code without changing behavior
- stop with a no-op when nothing changed recently enough to simplify

### `environment-setup`

[`environment-setup`](../../packages/cloud-agents/src/server/workflows/skills/standard/environment-setup/SKILL.md) is a specialized internal setup workflow.

Its contract is:

- inspect the repository and infer the smallest valid Roomote environment config
- validate install, test, start, and localhost reachability when practical
- configure named preview `ports` for validated human-facing web surfaces so the environment publishes shareable preview URLs
- create or update the environment only after validation is sufficient
- launch one lightweight verification task against the resulting environment
- monitor that task and iterate if it reveals fixable setup errors
- return exactly one final YAML plus explicit assumptions, validated observations, and blockers
- when local startup exposes a browser UI, verify browser-backed localhost URLs through loopback reachability instead of direct browser automation

## Task Tools Coverage

The web `Task Tools` surface does not expose the entire workflow catalog. It exposes only these packaged-skill entrypoints:

- `simplify`
- `push`
- `create-draft-pr`
- `create-pr`
- `review-code`
- `review-and-fix`
- `address-pr-feedback`
- `capture-visual-proof`

The rest of the workflow system is reached through ordinary routing, explicit skill invocation, or task-type-specific builders.

## Canonical Versus Compatibility Names

The canonical workflow names are the packaged-skill directory names.

Compatibility names exist at the `standardTask()` invocation layer and should not be treated as distinct workflows in docs:

- `push-branch` is a compatibility invocation for the `push` path
- `merge-resolver` and `merge-resolution-review` are compatibility invocations around merge-conflict resolution/review

## How To Keep This Doc Accurate

When a workflow contract changes, update both:

- [Workflow System](./workflow-system.md) for inventory, ownership, and entry-surface mapping
- this page for the detailed mechanics, phase structure, gates, constraints, and delegated ownership changes

### Skill Authoring Guardrail

Before merging any `SKILL.md` change, verify every referenced runtime capability against the actual checked-in harness surface rather than older prose, copied prompts, or Slack summaries.

- Verify packaged-skill names, child-path names, and Task Tool entrypoints against the shipped skill tree plus [`task-tools.ts`](../../apps/web/src/app/%28sandbox%29/task/[taskId]/task-tools.ts).
- Verify harness-owned behavior against the checked-in prompt and runtime sources that actually assemble and deliver it, such as [`standardTask.ts`](../../packages/cloud-agents/src/server/workflows/standardTask.ts), the relevant packaged `SKILL.md`, and the worker code that writes `developer_instructions`.
- Verify any exploration or worker-facing subagent reference against the prompt or launcher source that actually defines it, such as [`suggested-tasks-prompt.ts`](../../packages/cloud-agents/src/server/suggested-tasks-prompt.ts). Do not invent or preserve subagent labels that the runtime does not expose.
- Verify MCP tool names against the currently exposed `tools/list` and proxy/allowlist surface under [`apps/api/src/handlers/mcp/`](../../apps/api/src/handlers/mcp/) instead of provider marketing docs or stale screenshots.
- Verify every shell command against a checked-in script or executable surface, including real git hooks under [`.husky/`](../../.husky/) and worker-owned scripts when the prose names them.
- If prose references a capability that does not exist in the shipped runtime, remove the prose or ship the capability in the same pull request. Do not merge contract docs that describe nonexistent tools, subagents, hooks, or commands.

## Related Docs

- [Workflow System](./workflow-system.md)
- [Roomote Agent Context](./agent-context.md)
- [GitHub Integration](../features/github-integration.md)
- [Web Dashboard](../features/web-dashboard.md)
- [Slack Onboarding Timeline](../features/slack-onboarding.md)
- [Web tRPC Router](../api/trpc-web.md)
