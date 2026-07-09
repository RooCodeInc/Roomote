---
title: Slack Integration
status: active
last_reviewed: 2026-07-07
owner: engineering
summary: Current Slack integration guidance for Roomote's single-deployment model.
---

# Slack Integration

Slack is both a sign-in provider and a task entry surface. The local product has one deployment, so Slack installation, onboarding state, automation destinations, and shared Slack preferences are deployment-level data. User-specific Slack identity still lives in account/linking tables so task authorship and channel visibility can follow the human actor.

## Runtime Shape

| Surface            | Current behavior                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| Sign-in            | Better Auth can use Slack OpenID Connect for the browser auth boundary.                                   |
| App installation   | The Slack OAuth app install creates or updates `slack_installations` and installer `slack_user_mappings`. |
| Linked users       | Human Slack users map to Roomote users through `slack_user_mappings` and linked-account flows.            |
| Tasks              | Slack app mentions and selected interactive actions create or resume Roomote tasks.                       |
| Automations        | Slack-posting automations store destinations in `background_automation_targets`.                          |
| Shared preferences | Emoji, tone, authorship, and suggestion preferences live on `deployment_settings`.                       |
| Setup state        | Slack setup/onboarding stage and router debug destination live in `deployment_settings`.                  |

## Key Code

- [`apps/api/src/handlers/slack/index.ts`](../../apps/api/src/handlers/slack/index.ts): public Slack webhook entrypoint.
- [`apps/api/src/handlers/slack/dispatch/interactive.ts`](../../apps/api/src/handlers/slack/dispatch/interactive.ts): Block Kit actions and task-start decisions.
- [`apps/api/src/handlers/slack/events/message-entry.ts`](../../apps/api/src/handlers/slack/events/message-entry.ts): app mentions, channel auto-start, and routing.
- [`apps/web/src/lib/slack-app-manifest.ts`](../../apps/web/src/lib/slack-app-manifest.ts): setup-time manifest builder for Slack app creation prefill URLs.
- [`packages/slack/src/start-slack-app-mention.ts`](../../packages/slack/src/start-slack-app-mention.ts): Slack task creation helper.
- [`packages/slack/src/start-auto-routed-slack-task.ts`](../../packages/slack/src/start-auto-routed-slack-task.ts): auto-routed Slack launch path.
- [`packages/slack/src/manager-mcp-setup.ts`](../../packages/slack/src/manager-mcp-setup.ts): manager-channel setup nudges for deployment-scoped MCP integrations.
- [`packages/communication/src/chat-messages.ts`](../../packages/communication/src/chat-messages.ts): shared copy builders that Slack Block Kit formats for account linking, routing confirmation, task start, retryable errors, and PR-merged notices.
- [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts): `slack_installations`, `slack_user_mappings`, `deployment_settings` (shared agent settings), `background_automations`, and `background_automation_targets`.

## App Setup

The `/setup` Slack credential step defaults to a guided app manifest path.
`apps/web/src/lib/slack-app-manifest.ts` builds a Slack manifest for the current
public web origin and `StepAuthEnvVars` opens Slack's create-app URL with
`new_app=1&manifest_json=...` prefilled. V1 intentionally does not call
Slack's Manifest API (`apps.manifest.create`) because that would require a
Slack app configuration access token that self-host operators do not otherwise
need.

The manifest must stay aligned with the manual README Slack manifest and the
`connectSlackAppCommand` scope list. It includes:

- OAuth redirect URLs for `/api/auth/oauth2/callback/slack` and `/api/slack/callback`.
- Event subscription and interactivity request URLs at `/api/webhooks/slack` on
  the current public origin.
- Bot scopes for app mentions, channel/group/DM history, chat writes, link
  unfurls, reactions, team, and users.
- Bot events for mentions, messages, reactions, links, channel joins, entity
  details, and workflow `function_executed` events.

Manual entry remains available from the same step for existing Slack apps and
for pasting the generated Client ID, Client Secret, and Signing Secret back into
Roomote. The setup form does not ask for `SLACK_APP_ID`: the later Slack
workspace installation stores `app_id` from Slack's `oauth.v2.access` response,
while `SLACK_APP_ID` remains an optional manual-env fallback. Runtime
environment variables still take precedence over saved setup values, and saved
secret values remain masked in the manual form.

After Slack redirects back, the `/api/slack/callback`, `/api/slack/auth`, and
`/api/slack/install-after-auth` routes build their browser redirect through
[`apps/web/src/lib/server/get-callback-host.ts`](../../apps/web/src/lib/server/get-callback-host.ts),
which rewrites internal listen origins (`localhost`, `127.0.0.1`, `0.0.0.0`,
and IPv6 wildcard/loopback) to the configured `ROOMOTE_APP_URL`. This matters
in containerized deployments where the Next.js standalone server binds
`HOSTNAME=0.0.0.0` and echoes that host back in `request.url`; without the
rewrite the user lands on an unreachable `http://0.0.0.0:3000`. The Teams auth
callback uses the same helper.

## App Mention Flow

1. Slack sends a signed event to `/api/webhooks/slack`.
2. The handler verifies the signing secret and dedupes the Slack event id.
   The secret resolves through `resolveSlackSigningSecret` (`packages/db`):
   the `SLACK_SIGNING_SECRET` env var wins, a value saved from the comms
   settings UI (encrypted deployment env var) fills the gap, cached ~30s.
   The web install-state signing uses the same resolver.
3. Message routing resolves the Slack installation, Slack user mapping, linked Roomote user, channel context, and any active task in the thread.
4. New actionable messages either launch a task directly or ask for a launch target only when multiple viable targets exist.
5. Follow-up messages on active task threads enqueue a resume/follow-up path and preserve the Slack channel/thread metadata in the cloud-job payload.

If the only launch option is `All repositories`, Slack should not ask the user to choose an environment.

Slack task launches resolve the canonical conversation permalink via `chat.getPermalink` (`SlackNotifier.getMessagePermalink`) and persist it as `slackConversationUrl` in the cloud-job payload, including onto a reused active job when a follow-up arrives in the same thread. The PR provenance line prefers that exact permalink for its Slack follow-up link; when it is unavailable, `buildSlackThreadPermalink` falls back to the workspace-domain archives URL, then to Slack's channel-level `app_redirect` URL when only a `teamId` is known, trading exact thread targeting for a reliable desktop-app handoff into the correct workspace.

The same PR provenance line (`getPrBodyAttributionLine` in [`packages/cloud-agents/src/server/workflows/utils.ts`](../../packages/cloud-agents/src/server/workflows/utils.ts)) deep-links back to the originating conversation for Telegram and Teams tasks, not just Slack. Telegram links are built from the persisted chat/thread/message ids by `buildTelegramMessagePermalink` (`https://t.me/c/<internalId>/<threadId>/<messageId>`) for supergroup and private-channel chats; personal/bot DM chat ids are not deep-linkable to a specific message, so they fall back to the Roomote bot's DM link (`https://t.me/<TELEGRAM_BOT_USERNAME>`) when `TELEGRAM_BOT_USERNAME` is configured, and to a web-UI-only follow-up link otherwise. Teams links are built by `buildTeamsMessagePermalink` (`https://teams.microsoft.com/l/message/<conversationId>/<messageId>?tenantId=<tenantId>`) from the persisted `teamsConversationId`, `teamsMessageId`, and `teamsTenantId` for `19:` channel-style conversations; personal (`a:`) 1:1 chats fall back to the Roomote bot's personal-app deep link (`https://teams.microsoft.com/l/app/<TEAMS_BOT_APP_ID>?tenantId=<tenantId>`) when `TEAMS_BOT_APP_ID` is configured, opening the user's DM with the bot. `cloud-agent-workflow.ts` resolves these via the provider-neutral `getCommunicationChannelFromTaskPayload` / `getCommunicationThreadIdFromTaskPayload` / `getCommunicationMessageIdFromTaskPayload` / `getCommunicationTenantIdFromTaskPayload` payload helpers, so Telegram and Teams tasks only need the generic `communicationChannelId` / `communicationThreadId` / `communicationMessageId` fields they already persist.

## Unmentioned Thread Reply Routing

Replies in Roomote-owned threads do not need an @-mention to reach the agent.
`shouldRouteUnmentionedSlackThreadReplyToAgent` in
[`apps/api/src/handlers/slack/events/message-entry.ts`](../../apps/api/src/handlers/slack/events/message-entry.ts)
routes an unmentioned thread reply unless somebody else sent a message or was
mentioned since the bot's last message in the thread. The window is
sender-relative and computed from fetched thread history: only human-authored
messages between the bot's latest reply and the current message count, and a
message from (or mentioning) anyone other than the current sender and the bot
closes the window. Each new bot reply reopens it, so the flow "user ↔ bot"
keeps working without mentions even in multi-participant threads, while
interjections force an explicit @-mention until the bot speaks again.

The no-mention flow is limited to senders who are already in conversation with
the bot in that thread: the thread's task owner, the thread root author, or
someone who @-mentioned the bot earlier in the thread. A drive-by reply from
anyone else (for example a casual "nice" right under a bot reply) is ignored
rather than routed; mentioning the bot once is how a new participant joins the
conversation, and the window rule governs their replies after that.

The user-visible footer hint mirrors this: when the window closes, the current
footer is rewritten to "Reply with @-mention…" and a per-thread Redis flag
(`markSlackThreadExplicitMentionRequired` in
[`packages/slack/src/slack-messages.ts`](../../packages/slack/src/slack-messages.ts))
is set so refreshed footers keep the hint. `setLatestSlackBotReply` clears the
flag whenever the bot posts a new reply, so new footers return to the plain
"Reply or use the web app" text. The flag is only a footer hint; the routing
decision always derives from thread history.

## Outbound Slack Replies

Worker runtime activity is not mirrored automatically. Agents post Slack-visible updates explicitly through the built-in Roomote MCP tools:

- `send_chat_reply`: default path for replying to the originating Slack thread.
- `post_to_slack_channel`: explicit off-thread/channel delivery only when the user asked for it.
- visual-proof uploads auto-post proof artifacts when the job has trusted Slack thread env.

Slack tokens stay server-side. Workers receive only job tokens, artifact ids, and Slack channel/thread hints that the API validates before posting.

Slack follow-up queueing now delegates to the provider-neutral communication queue in [`packages/communication/src/messages.ts`](../../packages/communication/src/messages.ts). Keep the Slack-specific helpers in [`packages/slack/src/slack-messages.ts`](../../packages/slack/src/slack-messages.ts) for compatibility with existing Slack handlers and tests, but use the communication-provider helpers and task payload metadata helpers when adding new chat providers such as Teams.

User-facing operational copy that should stay aligned across chat providers lives in [`packages/communication/src/chat-messages.ts`](../../packages/communication/src/chat-messages.ts). Slack should continue to own Block Kit layout, buttons, reactions, and mrkdwn formatting, but account-linking, routing confirmation, start/queue acknowledgements, retryable failure text, and merge notifications should use the shared builders before adding Slack-only wording.

## Automations And Preferences

Deployment-level Slack automation state is split between:

- `background_automations`: enablement, schedule, and automation-specific settings.
- `background_automation_targets`: per-automation Slack destinations such as manager channels or auto-respond channels.
- `deployment_settings`: shared tone, reaction emoji, authorship, and suggestion settings (folded in from the former `background_agent_settings` table).

Router debug posts are not background automations. Their Slack destination is
stored as `deployment_settings.router_debug_slack_channel_id` and can be managed
by admins from the Slack communications provider section in Settings →
Communications. The legacy `ROUTER_DEBUG_CHANNEL_ID` env var remains an env
fallback when no persisted channel is set.

Do not add new `org_*` automation tables or per-workspace membership joins. New Slack automation features should hang off the deployment tables above unless they are clearly user-specific.

Scheduled-suggestion channel parent notes are posted server-side from the structured `submit_task_suggestions` payload in [`apps/api/src/handlers/tasks/submitTaskSuggestions.ts`](../../apps/api/src/handlers/tasks/submitTaskSuggestions.ts) via [`apps/api/src/handlers/tasks/scheduled-suggestion-root-summary.ts`](../../apps/api/src/handlers/tasks/scheduled-suggestion-root-summary.ts). The Suggested Tasks (suggester) parent note is always composed deterministically from the submitted suggestions (lead line, top titles, overflow count); it must never route through a free-text model call, because raw model narration and harness output can otherwise become the channel parent message. Other scheduled automations (Sentry, Dependabot, security, code quality, CI failure triage) still generate their parent summary with a small model but fall back to the same deterministic composition. Because the suggester posts exactly one deterministic parent message per run and the per-suggestion details fan out into its thread, changes here should avoid adding any additional channel-level messages near the run to keep the suggestions channel low-noise.

Channel auto-start (auto-respond channels) treats unlinked human authors the same way app mentions do: instead of silently skipping the launch, it prompts the author to connect their Roomote account via `showConnectAccount` (DM link prompt plus a thread reply), then stops. Bot-authored auto-start messages that have no automation launch identity still skip silently.

## Feature Flags

Slack feature gates resolve from deployment metadata unless the feature is explicitly user-scoped:

- `SlackEvalLauncher`

Use deployment-level feature-flag evaluation for Slack launch behavior, shared posting behavior, and settings visibility.

## Testing

Prefer the mock Slack harness for integration behavior:

- [`packages/slack/src/__tests__/`](../../packages/slack/src/__tests__)
- [`apps/api/src/handlers/slack/__tests__/`](../../apps/api/src/handlers/slack/__tests__)
- [`packages/slack/src/mock-slack-server.ts`](../../packages/slack/src/mock-slack-server.ts)

When a change touches task launching, resume behavior, or Block Kit actions, cover both the payload shape and the persisted task/cloud-job state.
