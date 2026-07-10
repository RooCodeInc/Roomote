---
name: roomote-runtime-integrations
description: Trace how Roomote agents run through the Roomote runtime and integrations. Use when debugging or changing controller/worker/queue behavior, preview proxy flows, snapshots, MCP setup, or Slack/Linear/GitHub entry points that create or resume Roomote agent work.
---

# Roomote Runtime Integrations

Trace the full Roomote agent path before changing runtime code.

## Start Here

- Read `packages/cloud-agents/src/server/cloud-job-queue.ts` for queue claim/release behavior.
- Read `apps/controller/src/BaseController.ts` and `apps/controller/src/orphaned-cloud-jobs.ts` for dispatch and recovery.
- Read `apps/worker/src/run-task/*` and `apps/worker/src/commands/*` for worker execution and harness startup.
- Read `packages/cloud-agents/src/system-prompt.ts` and `packages/cloud-agents/src/server/workflows/` for prompt assembly and workflow builders.

## Runtime Map

- Producers create tasks from web UI, API routes, or integration webhooks.
- Queue/controller logic turns those requests into dequeued jobs and machine dispatch.
- Workers prepare repos/services, configure MCPs, and run the active harness.
- Preview proxy exposes preview URLs and auth flows for running agent environments.
- Slack, Linear, GitHub, and MCP routes are entry surfaces into the same Roomote agent runtime.

## OpenCode Runtime Debugging Playbook

Use this when you need to debug worker, sandbox-server, or OpenCode server
harness behavior with the currently checked-in repo surfaces.

### Preferred Validation

- Confirm the OpenCode CLI exists: `command -v opencode`.
- Confirm auth exists when needed: `OPENAI_API_KEY`.
- Start with the smallest targeted worker or sandbox-server test that covers
  the code you are changing.
- If you need lower-level payload inspection beyond the checked-in tests, use
  the real caller under test or add a temporary local-only probe in your branch.
  Do not leave ad hoc probe helpers committed unless you intentionally turn
  them into supported scripts.

## Read By Problem

- Queueing, claim/release, orphan recovery:
  - `packages/cloud-agents/src/server/cloud-job-queue.ts`
  - `apps/controller/src/BaseController.ts`
  - `apps/controller/src/orphaned-cloud-jobs.ts`
- Worker execution and harness startup:
  - `apps/worker/src/commands/*`
  - `apps/worker/src/run-task/*`
- Preview URLs, auth, and nested routing:
  - `apps/preview-proxy/src/*`
  - environment package code under `packages/` related to environment config
- Slack / Linear / GitHub flows:
  - webhook handlers under `apps/api/src/handlers/`
  - related packages under `packages/slack`, `packages/linear`, and GitHub handlers
- MCP setup:
  - `packages/types/src/mcp-oauth.ts`
  - `apps/worker/src/commands/setup/setup-mcps.ts`
  - `apps/api/src/handlers/mcp/index.ts`
  - `apps/api/src/handlers/mcp/routing.ts`

## Current Invariants

- Docker is the default worker compute provider for Roomote local and self-hosted deployments.
- Hosted compute providers should preserve the sandbox-compatible API/contract surface used by Docker, Vercel Sandbox, and Modal-backed workers.
- Local preview-proxy runs on port `8081`.
- Webhook mounts are under `/api/webhooks/*`.
- GitHub MCP is router-side today. The worker-side integration catalog is no
  longer just Linear; treat `packages/types/src/mcp-oauth.ts` as the source of
  truth for the current task-facing integrations.
- GitHub App installation flow and GitHub user OAuth flow are separate concepts.

## Output Standard

- Name the exact entry surface affected by the change.
- Trace the handoff path end-to-end before proposing a fix.
