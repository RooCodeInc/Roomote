---
name: roomote-agent-product
description: Understand the Roomote product model centered on tasks and workflows executed by Roomote agents. Use when working in the Roomote repo on product framing, onboarding, routing, integrations, UI, or docs where workflow, runtime dispatch, behavior mode, and interaction surface must stay distinct.
---

# Roomote Agent Product

Treat Roomote agents as the core product surface.

## Start Here

- Read `packages/types/src/task-runs.ts` for task workflow, surface, trigger,
  visibility, and runtime payload classifications.
- Read surface code that matches the user path you are touching:
  - web dashboard under `apps/web/`
  - Slack integration under packages/apps serving Slack
  - Linear integration under packages/apps serving Linear
  - GitHub integration under packages/apps serving GitHub
  - public docs under `apps/docs/`

## Product Model

- Treat a Roomote agent as the task-running product abstraction, not as a
  persisted identity or subtype.
- Do not introduce public or persisted agent identities such as `Generalist`,
  `Coder`, `Planner`, `Explainer`, `PR Reviewer`, or `PR Fixer`.
- Keep these concepts separate:
  - task workflow: the durable kind of work, such as `standard`, `pr_review`,
    or `pr_conflict_resolve`;
  - payload kind: the internal worker/controller dispatch discriminator;
  - behavior mode or skill: how a delegated run approaches the current work;
  - surface and trigger: where the request arrived and what launched it.
- `Standard Task` is an internal payload name, never an agent identity.
- `Agent` may be used as a generic user-facing noun or fallback display label;
  it does not imply a selectable identity.

## Surface Rules

- Web dashboard is the primary configuration and management surface for Roomote agents.
- Slack, Linear, and GitHub are interaction surfaces that feed work into Roomote agents and receive agent output back.
- Do not document Slack, Linear, or GitHub as separate products; frame them as ways to interact with Roomote agents.
- Prefer `Roomote agents` in user-facing prose. Describe review, conflict
  resolution, planning, explanation, and coding as workflows or behavior, not
  as distinct agent identities. Use `cloud agent` only when matching existing
  code/schema/API names.

## When The Task Touches Behavior

- Read `packages/cloud-agents/src/system-prompt.ts` and workflow builders under `packages/cloud-agents/src/server/workflows/` when the task touches prompts, personality, harness behavior, or channel-specific wrapping.
- Read routing code under `packages/cloud-agents/` when the task touches agent selection, workspace routing, follow-up classification, or confirmation flows.
- Read dequeue and run-task paths under `packages/sdk/` and `apps/worker/` when the task touches how user intent becomes a running Roomote agent task.

## Output Standard

- Make the workflow and interaction surface explicit.
- Keep product framing consistent across docs, UI copy, and implementation notes.
