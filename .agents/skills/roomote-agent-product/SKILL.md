---
name: roomote-agent-product
description: Understand the Roomote product model centered on Roomote agents. Use when working in the Roomote repo on product framing, onboarding, routing, integrations, UI, or docs where you need to know what a Roomote agent is, which agent types exist, which surfaces users interact through (web dashboard, Slack, Linear, GitHub), and how autonomous vs delegated agents differ.
---

# Roomote Agent Product

Treat Roomote agents as the core product surface.

## Start Here

- Read `packages/types/src/cloud-agents.ts` for the current agent types, metadata, and autonomous vs delegated behavior.
- Read surface code that matches the user path you are touching:
  - web dashboard under `apps/web/`
  - Slack integration under packages/apps serving Slack
  - Linear integration under packages/apps serving Linear
  - GitHub integration under packages/apps serving GitHub
  - public docs under `apps/docs/`

## Product Model

- Treat Roomote as a product centered on Roomote agents, not as a loose bundle of infrastructure services.
- Preserve the current user-facing agent types:
  - `Coder`
  - `Explainer`
  - `Planner`
  - `Generalist`
  - `PR Reviewer`
  - `PR Fixer`
- Distinguish delegated agents from autonomous agents:
  - delegated: `Coder`, `Explainer`, `Planner`, `Generalist`
  - autonomous: `PR Reviewer`, `PR Fixer`
- Use `Generalist` in user-facing copy. Keep `CloudAgentType.StandardTask` / `Standard Task` only when referring to the existing code identifier.

## Surface Rules

- Web dashboard is the primary configuration and management surface for Roomote agents.
- Slack, Linear, and GitHub are interaction surfaces that feed work into Roomote agents and receive agent output back.
- Do not document Slack, Linear, or GitHub as separate products; frame them as ways to interact with Roomote agents.
- Prefer `Roomote agents` in user-facing prose. Use `cloud agent` only when matching code/schema/API names that already use that term.

## When The Task Touches Behavior

- Read `packages/cloud-agents/src/system-prompt.ts` and workflow builders under `packages/cloud-agents/src/server/workflows/` when the task touches prompts, personality, harness behavior, or channel-specific wrapping.
- Read routing code under `packages/cloud-agents/` when the task touches agent selection, workspace routing, follow-up classification, or confirmation flows.
- Read dequeue and run-task paths under `packages/sdk/` and `apps/worker/` when the task touches how user intent becomes a running Roomote agent task.

## Output Standard

- Make the agent type and interaction surface explicit.
- Keep product framing consistent across docs, UI copy, and implementation notes.
