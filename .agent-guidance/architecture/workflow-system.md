---
title: Roomote Workflow System
status: active
last_reviewed: 2026-07-06
owner: engineering
summary: Technical reference for Roomote's workflow builders, strict core pathway layer, and the shipped standard packaged-skill catalog that drives agent behavior.
---

# Roomote Workflow System

Roomote's workflows are a primary behavior contract for the product, not just an implementation detail. They decide how requests are classified, which execution path is allowed to run, when proof or delivery steps are mandatory, and which specialized paths own review, fixing, setup, or browser work.

This page is the canonical workflow reference for the current system. Use it together with [Roomote Agent Context](./agent-context.md) for prompt-layer architecture, [Workflow Contracts](./workflow-contracts.md) for detailed behavior mechanics, and the feature docs for surface-specific behavior.

## What Counts As A Workflow

For Roomote product behavior, it is more accurate to think in terms of three workflow layers:

1. **Prompt-builder workflows** in [`packages/cloud-agents/src/server/workflows/`](../../packages/cloud-agents/src/server/workflows/) choose the task-type-specific startup contract.
2. **Core pathway workflows** inside [`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts) strictly route ordinary Generalist requests into one of `implement-changes`, `plan-repo-implementation`, or `explain-repo-code`.
3. **Broader packaged-skill workflows** in [`packages/cloud-agents/src/server/workflows/skills/standard/`](../../packages/cloud-agents/src/server/workflows/skills/standard/) define the reusable execution contracts available once a run is underway.

The prompt-builder layer decides which task contract starts. The core pathway layer decides the first-hop Generalist direction. The broader packaged-skill layer defines the larger catalog of reusable playbooks available after that first hop, plus any explicitly invoked packaged workflows.

## Builder Layer

[`generatePrompt()`](../../packages/cloud-agents/src/server/cloud-agent-workflow.ts#L38-L123) is the dispatch point for the current workflow builders.

| Task type                     | Builder                                                                                                    | Main trigger surface                                          | Behavior role                                                                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `standard.task`               | [`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts)                       | Manual web launches, API launches, and general delegated work | Generalist orchestration wrapper that routes ordinary requests into the standard packaged-skill catalog                                                                                                                                                                            |
| `suggested.tasks`             | [`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts)                       | Suggested task generation and follow-up work                  | Reuses the same general delegated workflow contract as `standard.task`                                                                                                                                                                                                             |
| `onboarding.task.suggestions` | [`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts)                       | Historical onboarding suggestion tasks                        | Historical task type routed through `standardTask()`                                                                                                                                                                                                                               |
| `mcp.recommendations`         | [`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts)                       | Hidden MCP setup recommendation scans after setup             | Hidden Generalist run that reuses the same delegated workflow wrapper while submitting recommendation IDs                                                                                                                                                                          |
| `slack.app.mention`           | [`slackAppMention()`](../../packages/cloud-agents/src/server/workflows/slackAppMention.ts)                 | Slack mentions and Slack-started setup flows                  | Wraps `standardTask()` with Slack-specific intermediary-update, closeout-reply, and visual-proof artifact posting rules, including the rule that delegated child skills must leave the final Slack closeout parent-owned until the parent workflow reaches its real terminal state |
| `linear.agent.session`        | [`linearAgentSession()`](../../packages/cloud-agents/src/server/workflows/linearAgentSession.ts)           | Linear issue and comment sessions                             | Builds Linear issue context, then hands off to `standardTask()`                                                                                                                                                                                                                    |
| `github.pr.review`            | [`githubPrReview()`](../../packages/cloud-agents/src/server/workflows/githubPrReview.ts)                   | Initial autonomous PR review                                  | Starts the GitHub review path with an explicit `review-code` workflow invocation                                                                                                                                                                                                   |
| `github.pr.review.sync`       | [`githubPrReviewSync()`](../../packages/cloud-agents/src/server/workflows/githubPrReviewSync.ts)           | Re-review after new PR commits                                | Starts the sync review path, still anchored on the `review-code` skill                                                                                                                                                                                                             |
| `github.pr.review.followup`   | [`githubPrReviewFollowUp()`](../../packages/cloud-agents/src/server/workflows/githubPrReviewFollowUp.ts)   | Mention-driven PR follow-up work                              | Starts a PR-specific follow-up task that can review, explain, plan, or implement depending on the request                                                                                                                                                                          |
| `github.pr.conflict.resolve`  | [`githubPrConflictResolve()`](../../packages/cloud-agents/src/server/workflows/githubPrConflictResolve.ts) | Autonomous PR conflict-resolution jobs                        | Starts the dedicated `resolve-github-pr-merge-conflicts` path through `standardTask()`                                                                                                                                                                                             |

`SnapshotResume` is intentionally absent from this builder table. Resume jobs do
not call `generatePrompt()` again. They restore the prior harness session,
reuse the source job's persisted `harnessInstructions`, start with an empty
initial prompt, and then queue any deferred follow-up message onto the resumed
session after reconnect.

## How `standardTask()` Decides Behavior

[`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts) is the main orchestration router for Generalist work. The global system prompt owns the broader cross-surface user-facing behavior contract, including the generic communication-milestone policy, while `standardTask()` owns the run-specific workflow envelope, the strict core pathway selection, execution mode, and delegated-workflow mechanics.

### Core pathway layer

For ordinary natural-language Generalist requests, `standardTask()` does not behave like a generic "pick any skill" loader. It establishes a stricter first-hop pathway layer:

- `implement-changes`
- `plan-repo-implementation`
- `explain-repo-code`

Those three pathways are first-class control surfaces for Roomote behavior. They should be treated separately from the rest of the packaged-skill catalog, because they are the default initial directions for normal product use rather than merely three entries inside a larger toolbox.

### Initial routing

For ordinary natural-language requests, `standardTask()` hard-routes the initial path into exactly one of these parent workflows:

- [`implement-changes`](../../packages/cloud-agents/src/server/workflows/skills/standard/implement-changes/SKILL.md) for action-oriented repository changes
- [`plan-repo-implementation`](../../packages/cloud-agents/src/server/workflows/skills/standard/plan-repo-implementation/SKILL.md) for planning-only requests
- [`explain-repo-code`](../../packages/cloud-agents/src/server/workflows/skills/standard/explain-repo-code/SKILL.md) for explanation and code-reading requests

When the request begins with an explicit Roomote packaged-skill invocation such
as `/review-code`, `/create-pr`, `$environment-setup`, or `$sentry-triage`,
`standardTask()` skips that core three-way pathway step and starts the named
packaged workflow directly instead. The recognized packaged-skill invocation
set lives in
[`packages/cloud-agents/src/server/workflows/standardTask.ts:24-53`](../../packages/cloud-agents/src/server/workflows/standardTask.ts#L24-L53).
The checked-in
[`agent-browser`](../../packages/cloud-agents/src/server/workflows/skills/standard/agent-browser/SKILL.md)
file is included in that explicit-invocation set so direct `/agent-browser` or
`$agent-browser` requests land on the stub, but it is still a hidden discovery
stub rather than part of the ordinary three-way natural-language bootstrap.

### Execution policy

`standardTask()` also sets task-wide execution policy:

- Autonomous mode is the default unless the task explicitly starts interactive.
- Repository-changing `implement-changes` runs must stay inside the active workflow until they reach the configured delivery outcome.
- Repository-changing `implement-changes` runs still owe targeted validation and parent self-review before delivery.
- After repository-changing implementation, the workflow still owes an in-task handoff to [`capture-visual-proof`](../../packages/cloud-agents/src/server/workflows/skills/standard/capture-visual-proof/SKILL.md) before delivery continues. The parent workflow does not expose or directly use browser tooling.
- Validation gaps and proof no-op/blocker results are carried forward into delegated delivery when the implementation remains the intended shipped diff; they are not terminal closeout states for autonomous repository-changing runs.
- Delivery is delegated to one of [`push`](../../packages/cloud-agents/src/server/workflows/skills/standard/push/SKILL.md), [`create-draft-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/create-draft-pr/SKILL.md), or [`create-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/create-pr/SKILL.md) based on agent settings and run mode.
- When the task creator has a linked GitHub login, `standardTask()` now passes that login into delegated PR delivery so `create-draft-pr` and `create-pr` can assign newly created or refreshed pull requests to the creating user.
- PR-linked work-item references belong to the shared PR metadata layer under [`packages/cloud-agents/src/server/workflows/`](../../packages/cloud-agents/src/server/workflows/), not to source integrations. Source integrations normalize provider-specific issue or task data into canonical task context, and any new integration that can originate or resolve work items eligible for PR metadata must ship the task-context mapping, renderer adapter, tests, and guidance update in the same change.

### Plan mode enforcement

When the `PlanMode` feature flag is enabled, the OpenCode worker enforces the
planning-only contract at the harness layer with per-prompt agent selection:

- The worker's generated OpenCode config always registers a Roomote-owned
  `architect` primary agent
  ([`agent-home.ts`](../../apps/worker/src/run-task/agent-home.ts)). It is
  read-mostly rather than read-only: `edit` is denied as the single hard
  guard, and everything else — full bash (including git), webfetch, subagents,
  skills, and the full Roomote MCP toolset — stays available. Bash-side
  mutation and delivery discipline are prompt-governed, an accepted tradeoff
  documented in the agent's own prompt.
- The OpenCode server harness tracks the last packaged workflow skill loaded
  by the primary session and submits prompts on `architect` while
  `plan-repo-implementation` is active
  ([`harness.ts`](../../apps/worker/src/sandbox-server/lib/harnesses/opencode-server/harness.ts)).
  Architect prompts omit the request-level model so `ROOMOTE_PLANNING_MODEL`
  can apply through the agent-level config.
- The exit path is the user-requested `implement-changes` skill load. When a
  mid-turn skill load leaves `plan-repo-implementation` for a different
  packaged workflow skill
  ([`workflow-skill-transition.ts`](../../apps/worker/src/sandbox-server/lib/harnesses/opencode-server/workflow-skill-transition.ts)),
  the harness queues exactly one hidden continuation prompt that drains after
  the read-only turn ends and submits on the writable `build` agent, so the
  implementation continues automatically in the same task.
- Snapshot resume is a pre-existing quirk: a fresh harness starts with no
  active workflow skill, so resumed prompts run on `build` and only
  prompt-level plan instructions persist until a workflow skill load happens
  on the resumed session.

### Prompt shape

`standardTask()` returns two different prompt surfaces:

- `prompt`: the initial task request text
- `harnessInstructions`: the orchestration contract that the worker later writes
  into OpenCode `developer_instructions`

For ordinary delegated work, `prompt` is a `<request>...</request>` wrapper
around the task description. For builders that opt into
`requestFormat: 'structured'`, `standardTask()` preserves an explicit leading
packaged-skill command such as `/review-code` or `/resolve-github-pr-merge-conflicts`
on the first line and wraps only the remaining body in `<request>...</request>`.

That distinction matters when changing workflow behavior: editing the request
body changes what the agent sees as the task, while editing
`harnessInstructions` changes the workflow contract and policy layer around that
task.

### Testing guidance

Follow the testing guidance in [Testing Strategy](../operations/testing.md) when
adding or updating workflow-system tests. When a test is meant to prove the
membership of an exported constant or other shipped list, declare an
independent hardcoded expected set in the test file and then assert that the
production export matches it. Do not import the production list as the
expected source. That makes the test tautological and unable to catch
omissions or additions.

## Standard Packaged-Skill Catalog

The shipped `standard` catalog currently contains the following canonical workflows.

### Core parent workflows

| Workflow                                                                                                                         | Role                                             | Typical entry path                                                                                                     | Notes                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`implement-changes`](../../packages/cloud-agents/src/server/workflows/skills/standard/implement-changes/SKILL.md)               | Default mutation workflow for repository changes | Default `standardTask()` route for action-oriented work and straightforward ambiguous asks                             | Owns implementation, validation, self-review, proof handoff, and delegated delivery |
| [`plan-repo-implementation`](../../packages/cloud-agents/src/server/workflows/skills/standard/plan-repo-implementation/SKILL.md) | Planning-only workflow                           | Default `standardTask()` route for planning and scoping asks, plus ambiguous asks that still need meaningful decisions | Must stay non-mutating and publish the decision-complete plan as a durable artifact |
| [`explain-repo-code`](../../packages/cloud-agents/src/server/workflows/skills/standard/explain-repo-code/SKILL.md)               | Explanation-only workflow                        | Default `standardTask()` route for understanding and code-reading asks                                                 | Must stay grounded in repository truth and avoid mutation                           |

### Delivery and proof workflows

| Workflow                                                                                                                 | Role                                                                                                 | Typical entry path                                                                            | Notes                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`capture-visual-proof`](../../packages/cloud-agents/src/server/workflows/skills/standard/capture-visual-proof/SKILL.md) | Decides whether browser proof applies and reports proof-runtime blockers when capture is unavailable | Delegated from `implement-changes`; explicit Task Tool                                        | Owns proof classification and blocker reporting. The OpenCode-only worker currently reports `proof runtime unavailable` when browser proof is required and no proof runtime config exists.                           |
| [`push`](../../packages/cloud-agents/src/server/workflows/skills/standard/push/SKILL.md)                                 | Push-only delivery workflow                                                                          | Delegated delivery from `implement-changes`; explicit invocation; Task Tool                   | Commits and pushes without opening a pull request                                                                                                                                                                    |
| [`create-draft-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/create-draft-pr/SKILL.md)           | Draft PR delivery workflow                                                                           | Default autonomous delivery for most repository-changing runs; explicit invocation; Task Tool | Creates or refreshes draft PRs for changed repositories, creates the delivery branch from the provided base/default branch, targets that same base for new PRs, and assigns PRs to the linked creator when available |
| [`create-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/create-pr/SKILL.md)                       | Ready-for-review PR delivery workflow                                                                | Delegated delivery when agent settings request ready PRs; explicit invocation; Task Tool      | Creates or refreshes non-draft PRs, creates the delivery branch from the provided base/default branch, targets that same base for new PRs, and assigns PRs to the linked creator when available                      |

### Review, fix, and PR maintenance workflows

| Workflow                                                                                                                                           | Role                                                                      | Typical entry path                                                                        | Notes                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`review-code`](../../packages/cloud-agents/src/server/workflows/skills/standard/review-code/SKILL.md)                                             | Inline review workflow for current changes                                | GitHub review builders; explicit invocation; Task Tool                                    | Used both for local diff review and as the canonical GitHub review path                          |
| [`review-and-fix`](../../packages/cloud-agents/src/server/workflows/skills/standard/review-and-fix/SKILL.md)                                       | Inline review followed by fixes                                           | Explicit invocation; Task Tool                                                            | Focused on current workspace changes rather than GitHub thread orchestration                     |
| [`fix-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/fix-pr/SKILL.md)                                                       | GitHub PR feedback fixer workflow                                         | PR follow-up tasks, GitHub fixer flows, or explicit invocation                            | Owns live PR-state fetches, requested fixes, push, PR metadata refresh, and GitHub-side closeout |
| [`address-pr-feedback`](../../packages/cloud-agents/src/server/workflows/skills/standard/address-pr-feedback/SKILL.md)                             | Focused slash-command entrypoint for unresolved current-PR review threads | Explicit invocation; Task Tool                                                            | Builds scope from unresolved review threads only, then delegates into `fix-pr`                   |
| [`resolve-github-pr-merge-conflicts`](../../packages/cloud-agents/src/server/workflows/skills/standard/resolve-github-pr-merge-conflicts/SKILL.md) | PR merge-conflict resolution workflow                                     | GitHub conflict-resolver jobs, PR fixer preflight when conflicted, or explicit invocation | Merges base into the PR branch, resolves conflicts by intent, validates, and reports the result  |

### Specialized support workflows

| Workflow                                                                                                               | Role                                           | Typical entry path                                                                           | Notes                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`debug-reported-bug`](../../packages/cloud-agents/src/server/workflows/skills/standard/debug-reported-bug/SKILL.md)   | Reproduce-first diagnosis workflow             | Explicit invocation or later transition from a broader task                                  | Stops at root-cause and provenance; it does not implement the fix                                                                                                                                                                                                                                    |
| [`sentry-triage`](../../packages/cloud-agents/src/server/workflows/skills/standard/sentry-triage/SKILL.md)             | Workspace-scoped Sentry MCP triage workflow    | Scheduled Sentry triage automation, tracked Slack follow-up launches, or explicit invocation | Uses the Sentry MCP in task context as the primary evidence source, keeps scheduled runs read-only, and prefers launchable follow-up actions or concise Slack reporting over broad prose                                                                                                             |
| [`update-dependencies`](../../packages/cloud-agents/src/server/workflows/skills/standard/update-dependencies/SKILL.md) | Repository-agnostic dependency update workflow | Dependabot Slack follow-up launches or explicit invocation                                   | Re-verifies alert-driven tasks, derives package manager and validation from the target repository, and defaults successful dependency diffs to `create-draft-pr`                                                                                                                                     |
| [`agent-browser`](../../packages/cloud-agents/src/server/workflows/skills/standard/agent-browser/SKILL.md)             | Hidden discovery stub for browser CLI guidance | Delegated proof children or explicit browser-oriented helper work                            | Not part of ordinary `standardTask()` initial routing or Task Tools; mirrors the upstream `vercel-labs/agent-browser` discovery stub and tells the agent to load CLI-served `agent-browser skills get core` guidance first, while still honoring explicit `/agent-browser` or `$agent-browser` entry |
| [`simplify`](../../packages/cloud-agents/src/server/workflows/skills/standard/simplify/SKILL.md)                       | Behavior-preserving simplification workflow    | Explicit invocation; Task Tool                                                               | Operates on recently changed files and local guidance                                                                                                                                                                                                                                                |
| [`environment-setup`](../../packages/cloud-agents/src/server/workflows/skills/standard/environment-setup/SKILL.md)     | Internal environment configuration workflow    | Explicit setup bootstraps such as the `/setup` flow                                          | Explicit-use-only internal workflow for producing and validating Roomote environment configs                                                                                                                                                                                                         |

## Entry Surfaces And Workflow Mapping

Different product surfaces start different workflows, even when they eventually converge on the same packaged skills.

| Surface                                | Starting workflow                                                                                                                                    | Common packaged-skill path                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Web task composer or API manual launch | [`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts)                                                                 | Usually `implement-changes`, `plan-repo-implementation`, or `explain-repo-code`                                                    |
| Web `Task Tools` menu                  | [`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts) with explicit invocation text resolved from `taskTool.actionId` | `simplify`, `push`, `create-draft-pr`, `create-pr`, `review-code`, `review-and-fix`, `address-pr-feedback`, `capture-visual-proof` |
| Slack mention or Slack setup thread    | [`slackAppMention()`](../../packages/cloud-agents/src/server/workflows/slackAppMention.ts)                                                           | Same standard catalog as `standardTask()`, but with Slack reply rules layered on top                                               |
| Linear issue session                   | [`linearAgentSession()`](../../packages/cloud-agents/src/server/workflows/linearAgentSession.ts)                                                     | Same standard catalog as `standardTask()`, with Linear issue context prepended                                                     |
| GitHub initial PR review               | [`githubPrReview()`](../../packages/cloud-agents/src/server/workflows/githubPrReview.ts)                                                             | `review-code`                                                                                                                      |
| GitHub sync review                     | [`githubPrReviewSync()`](../../packages/cloud-agents/src/server/workflows/githubPrReviewSync.ts)                                                     | `review-code`                                                                                                                      |
| GitHub PR follow-up                    | [`githubPrReviewFollowUp()`](../../packages/cloud-agents/src/server/workflows/githubPrReviewFollowUp.ts)                                             | Often `fix-pr`, but the follow-up task can also route into the normal `implement/plan/explain` trio                                |
| GitHub autonomous conflict resolver    | [`githubPrConflictResolve()`](../../packages/cloud-agents/src/server/workflows/githubPrConflictResolve.ts)                                           | `resolve-github-pr-merge-conflicts`                                                                                                |
| Scheduled Sentry triage automation     | [`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts) with explicit `$sentry-triage` bootstrap                        | `sentry-triage`                                                                                                                    |
| Dependabot follow-up from Slack        | [`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts) with explicit `$update-dependencies` bootstrap                  | `update-dependencies`                                                                                                              |
| `/setup` onboarding                    | [`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts) with explicit `$environment-setup` bootstrap                    | `environment-setup`                                                                                                                |

## Task Tools Catalog

The current `Task Tools` catalog is defined in [`apps/web/src/app/(sandbox)/task/[taskId]/task-tools.ts`](../../apps/web/src/app/%28sandbox%29/task/[taskId]/task-tools.ts).

| UI label                     | Action ID              | Workflow                                                                                                                 |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Simplify changed code`      | `simplify`             | [`simplify`](../../packages/cloud-agents/src/server/workflows/skills/standard/simplify/SKILL.md)                         |
| `Commit + push`              | `push`                 | [`push`](../../packages/cloud-agents/src/server/workflows/skills/standard/push/SKILL.md)                                 |
| `Push to a draft PR`         | `create-draft-pr`      | [`create-draft-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/create-draft-pr/SKILL.md)           |
| `Push to a ready PR`         | `create-pr`            | [`create-pr`](../../packages/cloud-agents/src/server/workflows/skills/standard/create-pr/SKILL.md)                       |
| `Review code`                | `review-code`          | [`review-code`](../../packages/cloud-agents/src/server/workflows/skills/standard/review-code/SKILL.md)                   |
| `Review code and fix issues` | `review-and-fix`       | [`review-and-fix`](../../packages/cloud-agents/src/server/workflows/skills/standard/review-and-fix/SKILL.md)             |
| `Address PR feedback`        | `address-pr-feedback`  | [`address-pr-feedback`](../../packages/cloud-agents/src/server/workflows/skills/standard/address-pr-feedback/SKILL.md)   |
| `Capture visual proof`       | `capture-visual-proof` | [`capture-visual-proof`](../../packages/cloud-agents/src/server/workflows/skills/standard/capture-visual-proof/SKILL.md) |

## Canonical Names And Invocation Aliases

The canonical workflow names are the packaged-skill directory names under [`packages/cloud-agents/src/server/workflows/skills/standard/`](../../packages/cloud-agents/src/server/workflows/skills/standard/).

[`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts#L24-L52) also recognizes a few invocation aliases that should not be treated as separate canonical workflows in docs:

- `implement-repo-change` maps to the canonical `implement-changes` workflow
- `push-branch` maps to the `push` delivery path
- `merge-resolver` and `merge-resolution-review` map to the merge-conflict resolver path

Document and discuss the canonical names in product and repository docs unless an alias is the specific thing being debugged.

## Relationship To Neighboring Docs

Use this page for the workflow inventory and the cross-cutting behavior contract.
Use [Workflow Contracts](./workflow-contracts.md) when you need the detailed mechanics of the builders and shipped skill contracts.

Use neighboring docs for surface-specific detail:

- [Roomote Agent Context](./agent-context.md) for prompt-layer assembly and personality architecture
- [Workflow Contracts](./workflow-contracts.md) for the detailed mechanics of `standardTask()`, builder wrappers, and packaged skills
- [GitHub Integration](../features/github-integration.md) for GitHub webhook triggers, review flows, and conflict-resolution jobs
- [Web Dashboard](../features/web-dashboard.md) for the task UI and `Task Tools` surface
- [Slack Onboarding Timeline](../features/slack-onboarding.md) for `/setup` thread behavior and Slack-visible progress rules
- [Web tRPC Router](../api/trpc-web.md) for `/setup` launcher and onboarding route behavior

## Key Files Reference

- [`packages/cloud-agents/src/server/cloud-agent-workflow.ts`](../../packages/cloud-agents/src/server/cloud-agent-workflow.ts)
- [`packages/cloud-agents/src/server/workflows/standardTask.ts`](../../packages/cloud-agents/src/server/workflows/standardTask.ts)
- [`packages/cloud-agents/src/server/workflows/slackAppMention.ts`](../../packages/cloud-agents/src/server/workflows/slackAppMention.ts)
- [`packages/cloud-agents/src/server/workflows/linearAgentSession.ts`](../../packages/cloud-agents/src/server/workflows/linearAgentSession.ts)
- [`packages/cloud-agents/src/server/workflows/githubPrReview.ts`](../../packages/cloud-agents/src/server/workflows/githubPrReview.ts)
- [`packages/cloud-agents/src/server/workflows/githubPrReviewSync.ts`](../../packages/cloud-agents/src/server/workflows/githubPrReviewSync.ts)
- [`packages/cloud-agents/src/server/workflows/githubPrReviewFollowUp.ts`](../../packages/cloud-agents/src/server/workflows/githubPrReviewFollowUp.ts)
- [`packages/cloud-agents/src/server/workflows/githubPrConflictResolve.ts`](../../packages/cloud-agents/src/server/workflows/githubPrConflictResolve.ts)
- [`packages/cloud-agents/src/server/workflows/skills/standard/`](../../packages/cloud-agents/src/server/workflows/skills/standard/)
- [`apps/web/src/app/(sandbox)/task/[taskId]/task-tools.ts`](../../apps/web/src/app/%28sandbox%29/task/[taskId]/task-tools.ts)
