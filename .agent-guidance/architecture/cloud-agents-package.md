---
title: Cloud Agents Package
status: active
last_reviewed: 2026-07-09
owner: engineering
summary: Technical documentation of the packages/cloud-agents workspace package covering prompt dispatch, strict Generalist pathway routing, packaged workflows, MCP self-setup helpers, and fast-agent subsystems.
---

# Cloud Agents Package

`packages/cloud-agents` is the main application package for Roomote's prompt-building, delegated-task routing, and workflow assembly logic. It is not one feature in isolation; it is the package that translates stored task metadata plus source context into the prompt, workflow, and runtime-control decisions consumed by the worker pipeline.

Use this page for package-level ownership. Use the neighboring architecture docs for the deeper subsystem contracts that this package delegates to.

## Entry Points And Export Surfaces

| File                                                                                                                         | Role                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`packages/cloud-agents/src/index.ts`](../../packages/cloud-agents/src/index.ts)                                             | Client-safe exports such as the Roomote system prompt, compact prompt, and task runtime defaults                |
| [`packages/cloud-agents/src/server/index.ts`](../../packages/cloud-agents/src/server/index.ts)                               | Server-only export surface for routing, workflow, queueing, MCP self-setup, fast-agent, and video-agent helpers |
| [`packages/cloud-agents/src/server/cloud-agent-workflow.ts`](../../packages/cloud-agents/src/server/cloud-agent-workflow.ts) | Prompt dispatch entrypoint keyed by `TaskPayloadKind`                                                           |
| [`packages/cloud-agents/src/server/cloud-job-queue.ts`](../../packages/cloud-agents/src/server/cloud-job-queue.ts)           | Canonical enqueue path and Redis queue interface for new cloud tasks                                            |

## Child Surface Inventory

| Sub-surface                                                | Kind         | Coverage   | Owning doc                                                                             | Notes                                                                                                           |
| ---------------------------------------------------------- | ------------ | ---------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/cloud-agents/src/system-prompt.ts`               | architecture | documented | [Roomote Agent Context](./agent-context.md)                                            | Product-level Roomote identity and behavior in the OpenCode system-prompt layer.                                |
| `packages/cloud-agents/src/compact-prompt.ts`              | architecture | documented | [Roomote Agent Context](./agent-context.md)                                            | OpenCode compaction override shipped with the worker runtime.                                                   |
| `packages/cloud-agents/src/server/cloud-agent-workflow.ts` | architecture | documented | [Cloud Agents Package](./cloud-agents-package.md#prompt-dispatch-and-task-type-entry)  | Dispatches `TaskPayloadKind` values into prompt-builder workflows.                                              |
| `packages/cloud-agents/src/server/cloud-job-queue.ts`      | architecture | documented | [Cloud Job Execution Architecture](./cloud-job-execution.md#job-creation-and-queueing) | Owns enqueue semantics, queue scope, and compute-provider selection.                                            |
| `packages/cloud-agents/src/server/router/`                 | architecture | documented | [LLM Routing System](./llm-routing.md)                                                 | Workspace routing, follow-up classification, MCP-assisted routing, and initial work-kind classification.        |
| `packages/cloud-agents/src/server/workflows/`              | architecture | documented | [Workflow System](./workflow-system.md)                                                | Prompt-builder workflows and the standard packaged-skill catalog.                                               |
| `packages/cloud-agents/src/server/mcp-self-setup/`         | architecture | documented | [Cloud Agents Package](./cloud-agents-package.md#mcp-self-setup-subsystem)             | Shared setup recommendation catalog and normalization helpers for MCP onboarding and recommendation submission. |
| `packages/cloud-agents/src/server/fast-agent/`             | feature      | documented | [Cloud Agents Package](./cloud-agents-package.md#fast-agent-subsystem)                 | Lightweight direct-answer helpers and onboarding suggestion generation.                                         |
| `packages/cloud-agents/src/server/video-agent/`            | architecture | documented | [Cloud Agents Package](./cloud-agents-package.md#video-agent-subsystem)                | Package-owned prompt/service helpers for video-agent workflows.                                                 |

## Prompt Dispatch And Task-Type Entry

[`generatePrompt()` in `packages/cloud-agents/src/server/cloud-agent-workflow.ts`](../../packages/cloud-agents/src/server/cloud-agent-workflow.ts) is the package's main dispatch point. It combines:

- the persisted `task_runs` row,
- the `CloudTask` payload,
- any GitHub token or agent settings needed by that task type,
- and the task URL / user context used in downstream workflow prompts.

From there it selects one of the package-owned workflow builders:

- GitHub review and fix paths (`githubPrReview`, `githubPrReviewSync`, `githubPrReviewFollowUp`, `githubPrConflictResolve`)
- delegated generalist paths (`standardTask`)
- Slack and Linear wrappers over the delegated generalist path (`slackAppMention`, `linearAgentSession`)

Every builder returns the same package-level shape:

- `prompt`: the initial task request text that becomes the first task message
- `harnessInstructions`: workflow and wrapper policy that the worker later
  writes into OpenCode `developer_instructions`
- `artifacts`: side-channel metadata such as GitHub review comment ids

Fresh launches persist both `prompt` and `harnessInstructions` on the
`task_runs` row at dequeue time. `SnapshotResume` jobs intentionally do not run
`generatePrompt()` again; they reuse the source job's persisted
`harnessInstructions`, resume the saved session, and queue any deferred
follow-up after reconnect.

This is the package-level bridge between stored task metadata and the worker's
eventual OpenCode runtime session instructions.

For Generalist work, this package does not just expose a flat skill catalog. It
also owns the stricter first-hop pathway layer inside
[`standardTask()`](../../packages/cloud-agents/src/server/workflows/standardTask.ts):
ordinary requests start in `implement-changes`,
`plan-repo-implementation`, or `explain-repo-code` before the broader packaged
skill catalog becomes relevant.

## MCP Self-Setup Subsystem

`packages/cloud-agents/src/server/mcp-self-setup/` owns the package-local
catalog and helper functions that power MCP setup recommendations.

Current responsibilities include:

- exporting the recommendable integration inventory through
  [`index.ts`](../../packages/cloud-agents/src/server/mcp-self-setup/index.ts),
- defining per-integration setup metadata, capabilities, and setup locations in
  [`catalog.ts`](../../packages/cloud-agents/src/server/mcp-self-setup/catalog.ts),
- normalizing already-enabled integration IDs from current MCP config, and
- hydrating derived recommendation IDs into user-facing setup recommendations
  for submission flows and setup UI consumers.

This surface is intentionally package-owned because the same recommendation
catalog is consumed across multiple entry points, including setup commands in
`apps/web` and recommendation submission handlers in `apps/api`, while the
package-level export in
[`packages/cloud-agents/src/server/index.ts`](../../packages/cloud-agents/src/server/index.ts)
keeps it available to other server-side Roomote surfaces.

## Fast Agent Subsystem

`packages/cloud-agents/src/server/fast-agent/` owns the lightweight no-worker or reduced-workflow helpers that answer narrow questions quickly instead of launching a full sandbox-backed task.

Current responsibilities include:

- fast-agent session lifecycle helpers,
- fast GitHub/MCP-backed question answering,
- onboarding task-suggestions prompt generation,
- onboarding task-suggestions persistence helpers.

The subsystem stays in this package because it still depends on the same routing models, prompt conventions, and Roomote product framing as the full delegated-task workflows, even though it does not always launch a normal worker-backed task.

## Video Agent Subsystem

`packages/cloud-agents/src/server/video-agent/` is a smaller package-owned workflow family that keeps video-agent prompt/service logic out of the general workflow builders.

It is intentionally separate from `standardTask()` and the LLM router:

- it uses package-local prompt constants and service helpers,
- it has its own tests under `packages/cloud-agents/src/server/video-agent/__tests__/`,
- and it remains a dedicated subsystem rather than another variant of the general delegated-task path.

## Relationship To Neighboring Docs

This page is the package-level index for `packages/cloud-agents`. Use neighboring docs for the subsystem contracts:

- [Roomote Agent Context](./agent-context.md) for prompt layering and product personality assembly
- [Workflow System](./workflow-system.md) for prompt-builder and packaged-skill inventory
- [LLM Routing System](./llm-routing.md) for router behavior under `src/server/router/`
- [Cloud Job Execution Architecture](./cloud-job-execution.md) for enqueue and worker/runtime behavior downstream of this package
- [MCP Server Configuration](../features/mcp-servers.md) for product-facing MCP integration behavior outside this package-owned recommendation catalog
