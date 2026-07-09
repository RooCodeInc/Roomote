---
title: Agent Entry Surfaces
status: active
last_reviewed: 2026-07-09
owner: engineering
summary: Cross-surface overview of how work enters Roomote from the web dashboard, Slack, Teams, Telegram, Linear, GitHub, and programmatic launch paths, the explicit initiator each surface stamps, and where those paths converge.
---

# Agent Entry Surfaces

Roomote agents are configured in the web dashboard, but work enters the product through several different surfaces and producer paths. This page is the cross-surface map: what creates work, how agent and workspace selection happen on each path, and where those paths converge in the runtime.

Use this page for the entry-path overview. Use the surface-specific docs for end-to-end behavior.

Current direction: the user-facing `Generalist` agent (backed by the `TaskPayloadKind.StandardTask` payload, `workflow: 'standard'`) is the delegated task-entry path for natural-language work.

## Initiator Contract

Every entry surface passes an explicit `initiator` to `enqueueCloudTask()`; it is stamped immutably onto the `tasks` row and there is no attribution inference anywhere downstream:

- **Human-driven launches** (web tRPC, `POST /api/mcp/tasks` StandardTask, Teams, Telegram, linked Slack mentions, linked Linear sessions, manual `@roomote` PR mentions/follow-ups, reaction launches, onboarding queue launches) pass `{ kind: 'user', userId }`.
- **Unlinked human actors** (a Slack or GitHub sender with no Roomote user mapping) are still `kind: 'user'`, carrying `externalId`/`displayName` — and `matchedUserId` when the surface's own mapping lookup resolves one. The initiator CHECK admits external-identity-only humans.
- **Automation launches** (webhook PR open/sync reviews, nightly conflict scans, scheduled scans such as the suggester and triage runners, MCP recommendations, snapshot refresh, Slack channel auto-start) pass `{ kind: 'automation', key }` with the automation's key, plus `actor: { externalId, displayName }` context when the triggering webhook knows the human (e.g. the PR author on a webhook review) so display and commit authorship survive.
- **Resumes never re-attribute**: a follow-up or resume attaches a new run to the existing task and only updates the run's `actingUserId`.

## At a Glance

| Entry path                     | Trigger                                                                      | Agent selection                                                                                   | Workspace selection                          | Initial feedback                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Web dashboard: explicit launch | User submits from Home or another web action with an explicit selection      | Fixed to `Generalist` / `StandardTask`                                                            | Explicit in UI                               | Direct task redirect                                                 |
| Web dashboard: Home Auto       | User submits from Home with `Auto` workspace selected                        | Fixed to `Generalist` / `StandardTask`; Home uses `cloudJobs.routeHomeTask` for workspace routing | Routed to a named environment                | Direct task redirect                                                 |
| Slack                          | Channel mention or DM                                                        | LLM router with confirmation; manual fallback when routing fails or is unavailable                | LLM router or manual picker                  | Slack thread; queued starts omit Follow links until a task exists    |
| Teams                          | Linked account bot mention in a channel/group chat or linked personal chat   | Fixed delegated `Generalist` / `StandardTask`; router selects workspace                           | LLM router or all-repositories fallback      | Teams thread; direct starts include task link when available         |
| Telegram                       | Bot mention in a group chat or private chat                                  | Fixed delegated `Generalist` / `StandardTask`; router selects workspace                           | LLM router or all-repositories fallback      | Telegram chat; direct starts include task link when available        |
| Linear                         | Agent session or issue comment                                               | Fixed delegated `Generalist` / `StandardTask`; router only selects workspace                      | LLM router or elicited selection             | Linear session / issue thread; task link waits for claim when queued |
| GitHub autonomous events       | PR open/reopen/ready/sync, push conflict scan, merge-time Slack notification | Event-specific handler chooses task type and eligible agent set                                   | Repository context comes from the event      | GitHub activity or queued acknowledgement                            |
| Programmatic/API launch        | `POST /api/mcp/tasks` or queued server-side launch helpers                   | Caller supplies the agent or full `CloudTask`                                                     | Caller supplies repo, branch, or environment | Public API task launches return direct task JSON                     |

## Web Dashboard

The web dashboard is the primary configuration and management surface for Roomote agents, and it is also a direct launch surface for delegated work.

Home already reflects the intended entry model. [`Home.tsx`](../../apps/web/src/app/%28authenticated%29/home/Home.tsx) sorts `Generalist` first and defaults to it when one is available.

Current entry paths:

- **Explicit launch from Home**: the user chooses the workspace in [`apps/web/src/app/(authenticated)/home/Home.tsx`](../../apps/web/src/app/%28authenticated%29/home/Home.tsx), then the UI calls the web-router `cloudJobs.createStandardTask` path backed by [`apps/web/src/trpc/commands/cloud-jobs/index.ts`](../../apps/web/src/trpc/commands/cloud-jobs/index.ts).
- **Auto launch from Home**: when the user keeps the workspace on `Auto`, `Home.tsx` first calls the web-router `cloudJobs.routeHomeTask` mutation to run the shared LLM router before launching the task. On this surface, only the workspace is routed because the delegated agent is already fixed to `Generalist`. If the router returns a `platform_answer`, Home shows that answer inline instead of creating a task.
- **Web launch behavior**: Roomote does not expose the old Work Queue dashboard. Web-created launches call `enqueueCloudTask()` with `initiator: { kind: 'user', userId }`, `workflow: 'standard'`, `surface: 'web'`, `trigger: 'manual'`, keep the immediate `{ id, taskId }` web response, and navigate directly to `/task/:taskId`.
- **Converged delegated entry model**: natural-language task creation uses `Generalist` / `StandardTask` as the single delegated entry path.
  The web dashboard is also the first place users manage the prerequisites for the other surfaces: repositories, environments, app connections, and integration setup.

## Slack

Slack is a delegated-agent interaction surface.

Entry behavior:

- A user can start work by mentioning Roomote in a channel or sending it a direct message.
- Slack builds routing context, attempts LLM routing, and either asks the user to confirm the suggestion or falls back to manual Block Kit selection.
- Replies in an active thread are queued back to the running job.
- Replies in a completed thread can resume from a snapshot instead of starting from scratch.

Primary references:

- [Slack Integration](./slack-integration.md)
- [`packages/slack/src/block-kit.ts`](../../packages/slack/src/block-kit.ts)
- [`apps/api/src/handlers/slack/index.ts`](../../apps/api/src/handlers/slack/index.ts)

## Teams

Teams is a delegated-agent interaction surface backed by the provider-neutral communication layer.

Entry behavior:

- A linked user can start work by mentioning the Teams bot in a channel/group chat or by messaging it in a personal chat. If Teams cannot resolve the sender to a Roomote user, the webhook sends a Microsoft Teams account-link DM with a short-lived web callback link, then continues the original Teams request after Microsoft Entra sign-in or account linking succeeds.
- Teams builds routing context with `buildTeamsRoutingContext()`, routes workspace selection, and starts a `StandardTask` through `enqueueCloudTask()`.
- Inbound Teams activities are verified with direct Microsoft Bot Framework JWT validation, installation context is persisted in `teams_installations`, and launch ownership uses `teams_user_mappings`. When no mapping exists yet, a Teams AAD object ID can auto-link to an existing Microsoft Entra Better Auth account through `microsoft_auth_user_mappings` and persist the Teams mapping. New Teams task starts and snapshot resumes require that mapping.
- `Settings > Integrations` shows deployment-level Teams bot readiness from `TEAMS_BOT_*` env vars plus whether a primary Teams conversation has been captured (`teams.integrationStatus.primaryConversationReady`; the card nudges the operator to message the bot until then), while `Settings > Personal` owns per-user Microsoft Teams account linking through `ROOMOTE_AUTH_MICROSOFT_*` and Better Auth's `microsoft-entra-id` provider.
- Replies in an active Teams thread are queued back to the running job through `queueCommunicationMessage("teams", ...)`.
- Replies in a completed Teams thread can resume from a fresh snapshot. The inbound Teams message is embedded in `queuedCommunicationMessages` so the resumed worker replays it.
- Teams-backed tasks use provider-neutral chat metadata and the same `send_chat_reply` MCP tool for visible thread replies.

Primary references:

- [Communication Providers](../architecture/communication-providers.md)
- [Webhook Handlers](../api/webhooks.md#teams-webhooks)
- [`apps/api/src/handlers/teams/index.ts`](../../apps/api/src/handlers/teams/index.ts)

## Telegram

Telegram is a delegated-agent interaction surface backed by the provider-neutral communication layer.

Entry behavior:

- A user can start work by mentioning the Telegram bot in a group chat or by messaging it in a private chat.
- Telegram builds routing context with `buildTelegramRoutingContext()`, routes workspace selection, and starts a `StandardTask` through `enqueueCloudTask()`.
- Inbound Telegram updates are verified with the `X-Telegram-Bot-Api-Secret-Token` header. Launch ownership uses the existing Telegram Better Auth account when inbound `message.from.id` matches an `auth_accounts` row with `providerId="telegram"`.
- Replies in an active Telegram chat or forum topic are queued back to the running job through `queueCommunicationMessage("telegram", ...)`.
- Replies in a completed Telegram chat or forum topic can resume from a fresh snapshot. The inbound Telegram message is embedded in `queuedCommunicationMessages` so the resumed worker replays it.
- Telegram-backed tasks use provider-neutral chat metadata and the same `send_chat_reply` MCP tool for visible replies.

Primary references:

- [Communication Providers](../architecture/communication-providers.md)
- [Webhook Handlers](../api/webhooks.md#telegram-webhooks)
- [`apps/api/src/handlers/telegram/index.ts`](../../apps/api/src/handlers/telegram/index.ts)

## Linear

Linear is another delegated-agent interaction surface.

Entry behavior:

- A user can start work by creating an Agent Session or by mentioning Roomote in a Linear issue comment.
- Linear builds routing context, attempts workspace-only LLM routing, and starts the delegated task immediately when routing succeeds.
- If the router cannot decide, the integration falls back to a workspace-selection elicitation flow.
- Follow-up comments can either continue an active job or resume from the previous snapshot.

Primary references:

- [Linear Integration](./linear-integration.md)
- [`apps/api/src/handlers/linear/index.ts`](../../apps/api/src/handlers/linear/index.ts)

## GitHub

GitHub has mention-driven review and follow-up entry paths plus autonomous repository-event entry paths.

### Mention-driven review and follow-up

- Users can reply in GitHub with `@roomote` or `@newmote` to request another review pass or follow-up work on the current pull request.
- The GitHub webhook parses the PR context directly and either routes the mention into an existing PR-owned task or starts the appropriate review or follow-up run.
- Repository and PR context come from the webhook event and live PR state rather than from the cross-surface LLM router used by Slack, Teams, Telegram, Linear, and Home Auto.

### Autonomous event flows

GitHub can also create work without a user prompt:

- PR open, reopen, ready-for-review, and synchronize events drive review flows.
- Push events can trigger proactive conflict-resolution scans.
- Merge events notify linked Slack threads that the PR was merged.

These autonomous launches are automation-initiated: webhook reviews enqueue with `initiator: { kind: 'automation', key: 'review_code' }` and the nightly conflict scan with key `conflict_resolver`, carrying the webhook sender / PR author as `actor` context for display and commit authorship. Mention-driven review and follow-up launches are user-initiated by the mentioning human (external GitHub identity when unlinked).

GitHub does not currently use the cross-surface LLM router in production entry flows. Repository context comes from the event itself, so there is no environment/workspace chooser comparable to Slack, Teams, Telegram, Linear, or Home Auto.

Primary references:

- [GitHub Integration](./github-integration.md)
- [Webhook Handlers](../api/webhooks.md)
- [`apps/api/src/handlers/github/`](../../apps/api/src/handlers/github/)

## Programmatic And Server-Side Producers

Not every Roomote entry path is a user-facing surface.

Important non-UI producers:

- [`POST /api/mcp/tasks`](../../apps/api/src/handlers/tasks/launchTask.ts) returns `{ success: true, cloudJobId, taskId }`.
- `enqueueCloudTask()` is the normal server-side launch path for trusted callers that already have a complete `CloudTask` plus an explicit initiator and workflow/surface/trigger classification. It validates launch eligibility, creates the `tasks` row plus its first `task_runs` row (and the `task_pull_requests` row for PR workflows), runs any `beforeEnqueue` hook, and pushes the run onto the controller Redis queue.
- Snapshot maintenance and resume helpers use the same enqueue contract's resume shape (a new run on the existing task).

These are real entry paths into the Roomote runtime, but they are not primary end-user product surfaces in the way the web dashboard, Slack, Teams, Telegram, Linear, and GitHub are.

## Where Paths Converge

Fresh-task entry paths should converge on [`enqueueCloudTask()`](../../packages/cloud-agents/src/server/cloud-job-queue.ts). That helper creates the persisted `tasks` row plus its first `task_runs` execution attempt immediately and then the controller launches the worker after dequeuing the Redis entry.

```text
Web UI / Slack / Teams / Telegram / Linear / GitHub / API
  -> surface-specific auth + validation
  -> agent/workspace selection
     (explicit, LLM-routed, heuristic, or event-specific)
  -> enqueueCloudTask({ task, initiator, workflow, surface, trigger, ... })
  -> controller Redis dequeue
  -> worker runtime
  -> output returned to the originating surface
```

Some follow-up paths do not create a brand-new selection flow. Slack, Teams, Telegram, and Linear can create resume jobs from prior snapshots instead.

For the shared runtime after enqueueing, see [Cloud Job Execution Architecture](../architecture/cloud-job-execution.md).

## Current Product Asymmetries

- Slack still consumes routed agent and workspace suggestions. Teams, Telegram, Linear, and Home Auto route workspace only and preserve the delegated Generalist path.
- Shared LLM routing now always collapses delegated routed flows onto Generalist. That matches the intended direction toward `Generalist` / `StandardTask` as the default delegated entry path.
- Explicit web launches bypass the router because the user has already chosen the agent and workspace.
- New delegated producers should enqueue `StandardTask`. The post-`#2163` rollout only remaps still-unclaimed (`pending` / `dequeued`) persisted legacy delegated rows, preserving their bootstrap behavior without changing the visible task description; exited legacy rows may remain as historical records.
- GitHub can start autonomous Roomote work from repository events with no explicit user prompt.
- Most web, Slack, Teams, Telegram, and Linear launches create delegated work; GitHub event flows also create autonomous `Code Reviewer` and `PR Fixer` work.

## Related Documentation

- [Web Dashboard](./web-dashboard.md)
- [Slack Integration](./slack-integration.md)
- [Linear Integration](./linear-integration.md)
- [GitHub Integration](./github-integration.md)
- [LLM Routing System](../architecture/llm-routing.md)
- [Cloud Job Execution Architecture](../architecture/cloud-job-execution.md)
