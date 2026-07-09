---
title: Communication Providers
status: active
last_reviewed: 2026-07-09
owner: engineering
summary: Provider-neutral chat communication boundary for Slack, Teams, Telegram, and future chat providers.
---

# Communication Providers

Roomote keeps chat-follow-up transport separate from task execution. Slack remains the most complete provider. Teams and Telegram use the provider-neutral path for shared metadata, Redis queues, worker polling, visible chat replies, message task start, and snapshot resume without introducing another Slack-shaped path.

## Provider Boundary

- [`packages/types/src/communication.ts`](../../packages/types/src/communication.ts) owns `CommunicationProvider`, currently `slack | teams | telegram`, plus the provider-neutral queued message schema.
- [`packages/communication/src/provider.ts`](../../packages/communication/src/provider.ts) defines the outbound provider adapter contract for posting messages, reading threads/channel history, and adding reactions when the provider supports them.
- [`packages/communication/src/messages.ts`](../../packages/communication/src/messages.ts) owns Redis-backed active-task follow-up queues for chat providers. Queue prefixes live in [`packages/types/src/communication.ts`](../../packages/types/src/communication.ts) so adding more chat providers does not require provider-specific branches in the queue implementation.
- [`packages/communication/src/chat-messages.ts`](../../packages/communication/src/chat-messages.ts) owns shared user-facing copy builders for cross-provider chat messages: account-link prompts and acknowledgements, routing confirmations, task start/queue acknowledgements, retryable failure copy, snapshot resume notices, PR-merged notifications, and the setup onboarding copy (kickoff text, starter-suggestions intros, and suggested-tasks follow-up reminders). Provider packages should format those strings for their surface instead of re-authoring the copy in Slack, Teams, or Telegram handlers.
- [`packages/slack/src/communication-provider.ts`](../../packages/slack/src/communication-provider.ts) adapts `SlackNotifier` to the provider-neutral outbound contract.
- [`packages/communication/src/teams-bot-framework-client.ts`](../../packages/communication/src/teams-bot-framework-client.ts) implements the Bot Framework connector token exchange and message send call.
- [`packages/communication/src/teams-provider.ts`](../../packages/communication/src/teams-provider.ts) adapts that Bot Framework client to `CommunicationProviderAdapter` and exposes `createTeamsCommunicationProviderFromEnv()` as the shared factory for building the adapter from `TEAMS_BOT_*` env configuration.
- [`packages/communication/src/teams-activity.ts`](../../packages/communication/src/teams-activity.ts) parses inbound Teams activities into provider-neutral queued messages and routing metadata.
- [`packages/communication/src/telegram-provider.ts`](../../packages/communication/src/telegram-provider.ts) adapts the Telegram Bot API `sendMessage` method to `CommunicationProviderAdapter`.
- [`packages/communication/src/telegram-update.ts`](../../packages/communication/src/telegram-update.ts) parses inbound Telegram updates into provider-neutral queued messages and routing metadata.

## Task Metadata

Shared cloud-task payloads can carry provider-neutral routing metadata:

- `communicationProvider`
- `communicationTeamId`
- `communicationTeamDomain`
- `communicationServiceUrl`
- `communicationChannelId`
- `communicationThreadId`
- `communicationMessageId`

Slack aliases such as `slackChannelId`, `channel`, `thread_ts`, and `slackThreadTs` are still supported for existing payloads. Teams aliases such as `teamsTenantId`, `teamsServiceUrl`, `teamsChannelId`, `teamsConversationId`, `teamsThreadId`, and `teamsMessageId` are accepted for Teams-specific identifiers, but new code should populate the provider-neutral fields whenever possible.

Use helpers from [`packages/types/src/cloud-jobs.ts`](../../packages/types/src/cloud-jobs.ts), such as `getCommunicationProviderFromTaskPayload`, `getCommunicationChannelFromTaskPayload`, and `populateSnapshotResumeCommunicationMetadata`, instead of open-coding provider checks.

## Active Follow-Up Messages

The SDK exposes provider-neutral queue endpoints in addition to Slack compatibility endpoints:

- `cloudJobs.getCommunicationMessages({ cloudJobId, provider })`
- `cloudJobs.queueCommunicationMessage({ cloudJobId, provider, message })`

Workers start the existing Slack polling path for Slack jobs and the generic communication polling path for non-Slack jobs with provider metadata. Generic polling wraps unformatted messages as `<communication_message provider="...">` prompts and requeues undelivered messages through `@roomote/communication`.

`SnapshotResume` payloads can also embed `queuedCommunicationMessages` while a resume job waits in the product queue. The worker replays those messages on resume and requeues undelivered messages into the provider-specific Redis queue.

## Teams Scope

Teams support covers active-job follow-up delivery, app-mention or personal-message task entry, snapshot resume, and outbound Bot Framework posting:

- `POST /api/webhooks/teams` parses Teams message activities, ignores bot-authored activity echoes before installation persistence or queueing, strips bot mention markup, deduplicates by activity ID in Redis, and first tries to find an active job by provider-neutral or Teams-specific payload metadata. Active-thread replies are queued under the `teams:messages:{cloudJobId}` Redis key. Channel-thread activities prefer the Bot Framework conversation id's `;messageid=<root>` suffix as the canonical thread id before falling back to `replyToId`, so untagged replies to bot messages inside an active thread still route to the original job instead of starting new work.
- When no active job exists, Teams personal messages and channel/group messages that mention the bot can start work only after the sender resolves to a Roomote user mapping. The handler routes linked-user requests with `buildTeamsRoutingContext()`, starts a `TaskPayloadKind.StandardTask` through `enqueueCloudTask()`, and stores provider-neutral Teams metadata on the task payload. Unlinked task-entry messages receive a Microsoft Teams account-link DM when the activity includes enough Bot Framework coordinates, plus a short public thread reply. The DM link stores the original activity in Redis under `teams:auth:{token}` for 15 minutes; after Microsoft Entra sign-in or account linking, `POST /api/webhooks/teams/auth/resume` consumes that token and continues the original Teams request. If the DM cannot be sent, Roomote posts non-resumable public instructions to open a personal chat rather than posting the state-bearing link in the original Teams thread.
- Teams image input is allowed even when the usable text becomes empty after bot-mention stripping; the queued message uses `Image attachment` as the prompt text and carries downloaded prompt images. Bot Framework attachment URLs are tried first. If they identify an image but do not yield prompt-safe bytes, linked users can fall back to delegated Microsoft Graph hosted-content reads for inline Teams images referenced as `hostedContents/.../$value`.
- If the matching Teams thread belongs to a completed job with a fresh snapshot, the webhook creates a `SnapshotResume` job for linked users and embeds the inbound Teams message in `queuedCommunicationMessages` so the resumed worker replays it after startup.
- Teams-backed `StandardTask` prompts include Teams-specific chat visibility instructions. The worker registers `send_chat_reply` from provider-neutral communication env vars, and the MCP reply endpoint sends Teams replies through `TeamsCommunicationProvider` when the authenticated cloud job payload has `communicationProvider: "teams"`. Teams thread replies append a markdown footer with the task link plus any linked PR and live-preview links, mirroring the Slack thread footer via the shared `buildThreadReplyFooterText()` copy builder in [`packages/communication/src/chat-messages.ts`](../../packages/communication/src/chat-messages.ts). Like Slack, only the latest reply in a thread keeps the footer: the previous footer-bearing reply is tracked in Redis via [`packages/communication/src/thread-reply-footer-state.ts`](../../packages/communication/src/thread-reply-footer-state.ts) and rewritten without the footer through a Bot Framework activity update.
- When a Teams-launched job fails, `finishCloudJob` posts the shared startup/runtime failure copy back into the originating Teams conversation with a task link, mirroring the Slack failure notification path (see `sendTeamsFailureNotification` in [`packages/sdk/src/server/lib/cloud-jobs/finish-cloud-job.ts`](../../packages/sdk/src/server/lib/cloud-jobs/finish-cloud-job.ts)).
- When a tracked GitHub PR merges, [`apps/api/src/handlers/github/notifyTeamsPrMerge.ts`](../../apps/api/src/handlers/github/notifyTeamsPrMerge.ts) posts the shared PR-merged notification into Teams conversations whose cloud-job payloads carry Teams communication metadata, alongside the existing Slack notification.
- Generic communication follow-up prompts wrap queued messages as `<communication_message provider="..." ts="..." author="...">` so the agent sees who sent each Teams or Telegram follow-up.
- The Teams webhook route verifies Microsoft Bot Framework bearer JWTs directly using the Bot Framework OpenID metadata/JWKS, issuer `https://api.botframework.com`, audience `TEAMS_BOT_APP_ID`, token validity, matching Activity `serviceUrl`, and JWK channel endorsement when present.
- `teams_installations` persists tenant/team installation context, current service URL, bot identity, conversation/channel identity, and last activity timestamp. The webhook upserts it on verified activities.
- `microsoft_auth_user_mappings` stores Microsoft Entra account IDs by tenant and AAD object ID from Better Auth Microsoft sign-in hooks. `teams_user_mappings` maps Teams users to Roomote users by Teams tenant plus Teams user ID, with optional AAD object ID support. The webhook includes the mapped Roomote `userId` in queued messages and uses it as the launch owner for new Teams tasks. If no mapping exists and the Teams activity includes an AAD object ID, the webhook performs indexed lookups through `microsoft_auth_user_mappings` and the Better Auth `(providerId, accountId)` unique index, then seeds `teams_user_mappings` automatically. If no mapping or Microsoft sign-in match exists, new task launch and snapshot resume are blocked until the user links Microsoft Teams.
- `TeamsCommunicationProvider` can send Bot Framework markdown activities when configured with `TEAMS_BOT_APP_ID`, `TEAMS_BOT_APP_PASSWORD`, optional `TEAMS_BOT_TENANT_ID`, optional `TEAMS_BOT_TOKEN_ENDPOINT`, optional `TEAMS_BOT_OAUTH_SCOPE`, and a Teams `serviceUrl`. It can also send one-on-one DMs by creating a direct Bot Framework conversation from the inbound activity's service URL, tenant ID, and Teams user ID, then posting a message to the returned conversation ID.
- Bot Framework does not provide Slack-style channel/thread history reads, so Teams history goes through Microsoft Graph instead: [`packages/communication/src/teams-graph-client.ts`](../../packages/communication/src/teams-graph-client.ts) reads channel messages/replies and group-chat messages with a **delegated** Graph token minted from the acting user's linked Microsoft Entra account (`exchangeMicrosoftDelegatedGraphToken` exchanges the stored Better Auth refresh token; Entra sign-in requests `offline_access` so refresh tokens are stored, and rotated refresh tokens are persisted back). `TeamsCommunicationProvider.fetchThreadMessages`/`fetchChannelMessages` use a caller-supplied `graphTokenProvider`, and the Bot Framework `getTeamDetails` call bridges Bot Framework team ids to the AAD group id Graph requires. Without a Graph token provider, both reads still throw `UnsupportedCommunicationOperationError` with `code: "communication_operation_unsupported"`. The Teams webhook uses these reads best-effort (as the mapped launch user) to include channel-thread history in task routing context. Operators only need delegated Graph permissions (`ChannelMessage.Read.All`, `Chat.Read`) with admin consent on the app registration — no Microsoft protected-API approval, which app-only message reads would require.
- Teams reactions use the same MCP `reaction_add` path as Slack/Telegram but are delivered as Bot Framework replies containing only the mapped emoji, because Bot Framework has no outbound native reaction API. `TeamsCommunicationProvider.addReaction` maps Slack-style reaction names to emoji, replies in the originating conversation/thread with the normal bot credentials and launch activity `serviceUrl`, and returns the targeted user message id so the worker's current-turn satisfaction check treats the shortcut as handled. The message appears from the bot rather than as a Microsoft Teams reaction badge.

## Telegram Scope

Telegram support covers active-job follow-up delivery, bot-mention or private-message task entry, snapshot resume, and outbound Bot API posting:

- `POST /api/webhooks/telegram` verifies the Telegram `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`, parses message updates, deduplicates by `update_id` in Redis, resolves the inbound `message.from.id` to a linked Telegram auth account, and ignores unlinked senders before active-job lookup, snapshot resume, task launch, queueing, or replies. Active-chat replies are queued under the `telegram:messages:{cloudJobId}` Redis key only for linked Telegram users.
- When no active job exists, Telegram private messages and group messages that mention the configured bot start work. The handler routes the request with `buildTelegramRoutingContext()`, starts a `TaskPayloadKind.StandardTask` through `enqueueCloudTask()`, and stores provider-neutral Telegram metadata on the task payload.
- If the matching Telegram chat or forum topic belongs to a completed job with a fresh snapshot, the webhook creates a `SnapshotResume` job and embeds the inbound Telegram message in `queuedCommunicationMessages` so the resumed worker replays it after startup.
- Because Telegram has no threads, a `/new` or `/done` command forces a fresh `StandardTask` launch and skips the snapshot-resume path. `getTelegramNewTaskCommand` ([`packages/communication/src/telegram-update.ts`](../../packages/communication/src/telegram-update.ts)) detects the command and returns the command name plus the description with the invocation stripped. The command must lead the message — a `/new` or `/done` mentioned mid-sentence is ordinary text (a follow-up or resume message), not a command. In groups the command must target this bot, either as `/new@<botUsername>` or mention-prefixed as `@<botUsername> /new <text>`, so a bare `/new` from another member does not hijack the chat. The webhook refuses the command while a task is already running in the chat (naming the command sent, echoing the request text so it can be resent, and directing the sender to the cancel button) and replies with a usage hint when the command carries no description; both replies carry the forum `threadId` like every other inline reply. `/start <text>` does not bypass resume — only `/new` and `/done` do.
- Telegram-backed `StandardTask` prompts include Telegram-specific chat visibility instructions. The worker registers `send_chat_reply` from provider-neutral communication env vars, and the MCP reply endpoint sends Telegram replies through `TelegramCommunicationProvider` when the authenticated cloud job payload has `communicationProvider: "telegram"`.
- Telegram launch and follow-up ownership is resolved from the existing Better Auth Telegram account: inbound `message.from.id` is matched against `auth_accounts(providerId="telegram", accountId=<telegram-user-id>)`, then the product user row is created idempotently if needed. If no matching Telegram sign-in exists, the webhook acknowledges and ignores the message instead of using a deployment fallback owner.
- `TelegramCommunicationProvider` can send plain text Bot API messages when configured with `TELEGRAM_BOT_TOKEN`. It maps `communicationChannelId` to `chat_id`, `communicationThreadId` to `message_thread_id` for forum topics, and `communicationMessageId` to `reply_parameters.message_id` for replies.
- The Bot API adapter does not provide Slack-style channel/thread history reads, so `fetchThreadMessages` and `fetchChannelMessages` intentionally throw `UnsupportedCommunicationOperationError` with `code: "communication_operation_unsupported"`.

## Adding Providers

New chat providers should follow the same shape:

- Add the provider to `communicationProviders` and `communicationProviderQueuePrefixes`.
- Add provider-specific activity/update parsing that returns `QueuedCommunicationMessage` plus provider-neutral routing metadata.
- Add an outbound adapter behind `CommunicationProviderAdapter` and declare unsupported operations explicitly.
- Add a webhook route that verifies the provider signature or token before queueing active-job follow-ups or launching fresh tasks.
- Extend task-start/onboarding separately from active-job follow-up delivery, including provider-specific installation and user mapping when the provider needs it.
