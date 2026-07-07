---
title: Slack Onboarding Timeline
status: active
last_reviewed: 2026-07-08
owner: engineering
summary: Current proactive Slack messages during setup and first-task onboarding in the single-deployment product.
---

# Slack Onboarding Timeline

This page is the maintenance contract for proactive Slack copy. Update it whenever a setup, linking, suggestion, or integration-recommendation message is added, removed, moved to another thread, or materially reworded.

Roomote stores onboarding stage in `deployment_settings`. Do not add new campaign tables or hooks tied to local workspace creation; the product has one deployment.

## Current State

| State                                        | Storage                               | Purpose                                                                         |
| -------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `deployment_settings.slack_onboarding_stage` | `deployment_settings`                 | Tracks whether Slack task-milestone checks should still run.                    |
| Slack account mappings                       | `slack_user_mappings`                 | Links Slack users to Roomote users.                                             |
| Setup repository selection                   | `deployment_settings.setup_new_state` | Carries the setup repository set while Slack drives the environment setup task. |
| Automation destinations                      | `background_automation_targets`       | Stores per-automation Slack channels.                                           |

## Current Timeline

| Step                       | Timing                                                                           | Surface                         | Behavior                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account-link request       | When an unlinked Slack user mentions Roomote or clicks a legacy follow-up action | Original thread plus DM         | Roomote attempts to DM a link-account button and posts a short public thread reply only when needed.                                                                                                                                                        |
| Account-link confirmation  | After a user completes linking                                                   | DM                              | Roomote confirms the Slack account is connected and can continue in the original thread.                                                                                                                                                                    |
| Account-link education     | About one hour after a new or reassigned mapping                                 | DM                              | A delayed queue job can send a short education message; unchanged mappings and users who already created a question task are skipped.                                                                                                                       |
| Setup kickoff              | After `/setup` has GitHub, Slack, and repository selection                       | Installer DM                    | Roomote starts a real Slack task from the environment-setup kickoff prompt. When no Slack workspace is connected or the installer has no linked Slack account, the kickoff falls back to the Telegram primary chat, then the primary Teams conversation (a `StandardTask` carrying provider-neutral communication metadata); only when no chat surface exists does the same kickoff run as a web-only task shown in the `/setup` task panel. |
| Setup progress             | During environment setup                                                         | Setup task thread               | The agent uses `send_chat_reply` for useful `ack`, `progress`, `clarification`, blocker, proof, and `closeout` messages.                                                                                                                                    |
| Secure env-var handoff     | When setup discovers required deployment env vars                                | Setup task thread               | The agent may explain the needed keys, then `request_environment_variables` posts the secure `/setup` handoff automatically.                                                                                                                                |
| Setup terminal handoff     | When setup succeeds or fails                                                     | Setup task thread               | Roomote posts an `Open setup` handoff so the operator can continue or recover from `/setup`.                                                                                                                                                                |
| Starter suggestions intro  | After hidden task-suggestions work submits results                               | Installer DM                    | Roomote posts one parent message introducing starter tasks.                                                                                                                                                                                                 |
| Starter suggestion replies | Immediately after the intro                                                      | Thread below the intro          | Roomote posts up to five `Idea N` replies and tracks reactions.                                                                                                                                                                                             |
| MCP setup recommendations  | After setup completes and recommendation scanning finishes                       | Installer DM                    | Roomote posts recommended deployment or user integrations with setup links.                                                                                                                                                                                 |
| Suggested Tasks follow-up  | About 24 hours after the suggestions intro                                       | Existing suggestions thread     | Roomote can ask whether to configure recurring ideas and links to Automations.                                                                                                                                                                              |
| Reaction-launched task     | When a human reacts to an idea                                                   | New task root in the DM channel | Roomote launches a normal Slack task seeded with the selected idea.                                                                                                                                                                                         |

Retired manager-channel and second-task-milestone campaigns should not be reintroduced as deployment setup requirements. Slack-posting automations now configure their own destinations in Automations.

## Telegram Counterparts

Deployments without a Slack destination deliver these onboarding moments on
Telegram instead (see [Telegram Integration](./telegram-integration.md)):

| Step                      | Timing                                              | Surface                        | Behavior                                                                                                                        |
| ------------------------- | --------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `/start` welcome          | Bare `/start` in a private chat                     | Same chat                      | One welcome message describing task entry, follow-ups, and cancel buttons. `/start <text>` still launches a task.               |
| Setup kickoff             | After `/setup` repo selection, no Slack set         | Captured Telegram primary chat | One kickoff message, then the setup task runs with Telegram communication metadata so agent progress replies land in that chat. |
| Starter suggestions intro | After onboarding suggestions submit, no Slack set   | Captured Telegram primary chat | One message listing up to five ideas with an inline start button each; clicks claim the idea and launch through normal routing. |
| Suggested Tasks follow-up | About 24 hours after the Telegram suggestions intro | Reply to the intro message     | One message with an `Open Automations` URL button; skipped when the suggester is already enabled. No interactive prompt state.  |

## Teams Counterparts

Deployments whose only chat surface is Microsoft Teams get the same steps in
the primary Teams conversation (see
[Teams Integration](./teams-integration.md)); Telegram outranks Teams when
both are available, so at most one surface receives each step:

| Step                      | Trigger                                                        | Destination                    | Shape                                                                                                                              |
| ------------------------- | -------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Setup kickoff             | After `/setup` repo selection, no Slack or Telegram set        | Primary Teams conversation     | One kickoff message, then the setup task runs with Teams communication metadata so agent progress replies thread under it.          |
| Starter suggestions intro | After onboarding suggestions submit, no Slack or Telegram set  | Primary Teams conversation     | One markdown message listing up to five ideas; no inline buttons yet, so the intro asks the user to reply with the idea they want.  |
| Suggested Tasks follow-up | About 24 hours after the Teams suggestions intro               | Thread reply to the intro      | One message with an Automations markdown link; skipped when the suggester is already enabled. No interactive prompt state.          |

Both Teams steps are single messages, matching the noise guardrails below —
adding a nearby step risks clustering with the intro and the follow-up. The
kickoff and the suggestions intro land in the same primary chat minutes to
tens of minutes apart; keep any new step out of that window.

The Telegram suggestions intro is deliberately a single message (not the
Slack root-plus-replies fan-out) so the moment produces one notification.
When adding Telegram onboarding steps, follow the same noise guardrails
below and prefer buttons on an existing message over new top-level messages.

## Shared Onboarding Modules

The three surfaces share their onboarding plumbing; change these instead of
forking per-surface copies:

- Onboarding copy (kickoff text, suggestions intros, follow-up reminders)
  lives in
  [`packages/communication/src/chat-messages.ts`](../../packages/communication/src/chat-messages.ts);
  surfaces only add their own formatting (Slack mention prefixes, Telegram
  buttons, Teams inline links).
- Suggestion dedup, tracked-message rows, and follow-up scheduling live in
  [`apps/api/src/handlers/tasks/setup-suggestion-lifecycle.ts`](../../apps/api/src/handlers/tasks/setup-suggestion-lifecycle.ts).
- The three 24h follow-up queues share one enqueuer factory
  ([`packages/sdk/src/server/lib/suggested-tasks-onboarding-followup.ts`](../../packages/sdk/src/server/lib/suggested-tasks-onboarding-followup.ts))
  and one BullMQ starter plus job skeleton in `apps/bullmq`. The per-surface
  queue names are a deployed contract for already-scheduled delayed jobs — do
  not rename them.

## Noise Guardrails

- Prefer reusing an existing thread and CTA over creating a new top-level message.
- Keep setup kickoff, first progress, secure env-var handoff, and terminal handoff distinct; do not restate the same CTA in adjacent messages.
- The suggestions intro already fans out into several replies. Avoid adding another summary near that moment.
- MCP recommendations are a separate DM because they come from a hidden scanner after setup. Keep that intro concise and avoid duplicating starter suggestions.
- Account linking uses one public thread reply only when a DM was sent or could not be sent. Do not add more same-thread reminders unless the state changes.

## Related Documentation

- [Slack Integration](./slack-integration.md)
- [Web Dashboard](./web-dashboard.md)
- [Web tRPC Router](../api/trpc-web.md)
