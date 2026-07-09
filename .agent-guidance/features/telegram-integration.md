---
title: Telegram Integration
status: active
last_reviewed: 2026-07-09
owner: engineering
summary: Telegram bot task entry, webhook configuration, reply flow, and Slack parity notes.
---

# Telegram Integration

Telegram is a task entry surface backed by a single bot created with
@BotFather. Unlike Slack there is no per-workspace installation or per-user
OAuth: one bot token serves the deployment. Inbound chats are attributed only
to the sender's linked Roomote account (`telegram_user_mappings`, see Account
Linking). There is no deployment-wide fallback owner: an unlinked sender is
never treated as another user, so Roomote takes no task action on their
messages until they link.

## Configuration

| Env var                    | Purpose                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`       | Bot API token from @BotFather. Required for inbound and outbound.                                                                                                            |
| `TELEGRAM_WEBHOOK_SECRET`  | Shared secret verified via `x-telegram-bot-api-secret-token`.                                                                                                                |
| `TELEGRAM_BOT_USERNAME`    | Bot username, used for group-mention task entry detection.                                                                                                                   |
| `TELEGRAM_PRIMARY_CHAT_ID` | Destination for proactive messages (starter suggestions). Captured automatically from the first private chat that reaches the webhook (`primary-chat.ts`); first write wins. |

Saving the Telegram provider from the settings UI registers the webhook
automatically (`registerTelegramWebhookBestEffort` in
`apps/web/src/trpc/commands/comms/index.ts`) at
`<ROOMOTE_APP_URL>/api/webhooks/telegram` with
`allowed_updates=["message","callback_query"]`, and the settings card shows
the live webhook state (`getTelegramWebhookStatus` via `getWebhookInfo`).
Credentials resolve through `resolveTelegramRuntimeCredentials`
(`packages/db`): real env vars win, UI-saved deployment env vars fill gaps,
cached ~30s. Env-only setups that never save from the UI can still register
manually:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$ROOMOTE_PUBLIC_URL/api/webhooks/telegram" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d 'allowed_updates=["message","callback_query"]'
```

`callback_query` in `allowed_updates` is required for inline-keyboard buttons
(for example the cancel button on task-started messages) to reach the webhook.

Local note: model provider keys (for example `OPENROUTER_API_KEY`) must be
present in the environment `pnpm dev` runs from (or in `.env.local`);
otherwise the LLM router and workers silently fall back or fail.

## Inbound Flow

`POST /api/webhooks/telegram` (`apps/api/src/handlers/telegram/index.ts`):

1. Verify `x-telegram-bot-api-secret-token` (`webhook-gate.ts`, timing-safe).
2. Deduplicate by `update_id` in Redis (5-minute TTL).
3. Resolve the sender: a `telegram_user_mappings` row for the sender's
   Telegram user id yields the linked Roomote user
   (`resolveTelegramSenderUserId` in `linked-user.ts`); without a link the
   update is acknowledged and dropped (`reason: "telegram_sender_not_linked"`)
   after a best-effort "link your account" nudge — except a bare private-chat
   `/start`, which is still welcomed so unlinked users get linking guidance.
   In private chats the nudge is textual. In groups it fires only when the
   sender explicitly addressed the bot (mention or `/new@bot`) and carries a
   `https://t.me/<bot>?start=link` deep-link button; tapping it opens the
   bot's DM where `/start link` answers with link-code instructions (or
   confirms the account is already linked) and the private link-code flow
   takes over. The group nudge is rate-limited in Redis
   (`claimTelegramLinkNudge` in `webhook-gate.ts`: once per sender per chat
   per 6h, once per chat per 15min, fails quiet without Redis) so addressing
   the bot repeatedly cannot make it spam the group.
4. If the chat/thread has an active cloud job, queue the message to it via
   `queueCommunicationMessage('telegram', ...)` — the worker consumes it as a
   follow-up prompt.
5. Otherwise, if the update is a task entry signal (private chat message or
   group mention of `TELEGRAM_BOT_USERNAME`): resume from a completed job's
   snapshot when available, else route via the LLM router and either reply
   inline (`platform_answer`) or launch a standard task
   (`task-orchestration.ts`). Bot commands count as invocations — for both
   entry detection and invocation stripping — only when they lead the message
   (offset 0, or preceded only by this bot's mention); a `/command` mentioned
   mid-sentence is ordinary message content and survives into queued text.
   Mentions address the bot from anywhere in the text.
6. A bare `/start` in a private chat gets a welcome message instead of
   launching a task, even before the sender links an account;
   `/start <text>` keeps its existing meaning (command stripped, remaining
   text becomes the task). Private-chat messages also capture
   `TELEGRAM_PRIMARY_CHAT_ID` on first contact once a linked sender resolves.
7. `callback_query` updates (inline-keyboard clicks) dispatch through
   `handleTelegramCallbackQuery` (`callback-actions.ts`). The task-started
   message carries a cancel button whose `callback_data` is
   `cancel_task:<cloudJobId>`; clicking it stops the job via `stopTaskJob`,
   answers the callback, removes the button, and posts a confirmation.
   Starter-suggestion buttons (`idea:<suggestionId>`) atomically claim the
   suggestion and launch it through the normal Telegram routing pipeline.
   Unknown callback data is answered and dropped so buttons never spin.

## Onboarding

Telegram deployments without a Slack destination get the starter-suggestions
intro in the captured primary chat (`setup-suggestions.ts`, forked from
`submitTaskSuggestions`). Unlike Slack's root-plus-five-replies fan-out, the
Telegram intro is a single message listing up to five ideas with one
inline start button each — one notification total. Clicks claim the
suggestion through the `work_items` launch claim (a `status` CAS from `open`
to `launching`, with `work_items.launchClaimedAt` recorded for stale-claim
recovery) so double taps cannot launch twice.

Scheduled automations (suggester, Sentry triage, Dependabot triage,
security/code-quality auditors, CI failure triage) use the same fallback:
when the deployment has no active Slack installation, run summaries post to
the primary chat as one message with start buttons
(`automation-suggestions.ts`), and act-disposition work items launch
execution tasks whose closeouts post back to the chat
(`automation-work-items/telegram.ts` resolves the target; the execution
payload carries `communicationProvider: 'telegram'`). Launch failures post a
failure message to the same chat. Deployments without a Telegram destination
fall through to Teams next (Slack > Telegram > Teams; see
`teams-integration.md`). Thread feedback collection and the automations
destination picker remain Slack-only for now. About 24 hours later a delayed BullMQ job
(`telegram-suggested-tasks-onboarding-followup`) replies to the intro with an
`Open Automations` URL button unless the suggester is already enabled. See
`slack-onboarding.md` for the timeline contract.

## Account Linking

Users link their Telegram identity to their Roomote account with a one-shot
code, from Settings → Personal → Linked Accounts (visible whenever a bot
token resolves). The Telegram comms setup card shows the same linking step
(`TelegramLinkAccountStep`) once credentials are configured, so the admin
links themselves as the last step of setup — the deep link's
`/start <code>` covers first contact, primary-chat capture, and linking in
one tap. The bare `/start` welcome message nudges unlinked senders toward
the Linked Accounts page:

1. `linkedAccounts.createTelegramLinkCode` (web tRPC) mints
   `link-<16 base64url chars>` (`createTelegramLinkCode` in
   `packages/sdk/src/server/lib/telegram-link-codes.ts`), stored in Redis for
   10 minutes keyed by the code with the user id as the value. The dialog
   shows the code and, when `TELEGRAM_BOT_USERNAME` resolves, a
   `t.me/<bot>?start=<code>` deep link (codes stay within Telegram's
   `[A-Za-z0-9_-]{1,64}` start-payload alphabet).
2. The user sends the code to the bot — either as a bare private message or
   via the deep link's `/start <code>`. The webhook consumes it atomically
   (Redis `GETDEL`), upserts `telegram_user_mappings` (unique per Telegram
   user id, so relinking moves the identity), captures the primary chat, and
   replies with a confirmation. Invalid or expired codes get an error reply
   and are never treated as task text.
3. From then on, messages and suggestion-button clicks from that Telegram
   user are attributed to the linked account. Attribution requires a link:
   unlinked senders are never treated as another user. A non-`/start` message
   from an unlinked sender is answered with a best-effort "link your account"
   nudge (textual in private chats; in groups a rate-limited deep-link button
   reply, only when the bot was explicitly addressed) and acknowledged with
   `reason: "telegram_sender_not_linked"` — no task is started, resumed, or
   queued. Because linking requires the user to message the bot first, the bot
   can always message linked users directly.

Unlinking (`linkedAccounts.unlinkTelegram`) deletes the mapping rows for the
current user.

## Outbound Flow

- Launch/resume acknowledgements and router inline answers post from the API
  via `postTelegramMessageBestEffort` (`apps/api/src/handlers/telegram/replies.ts`).
- Worker `send_chat_reply` calls `POST /api/mcp/slack/thread_reply`, which
  dispatches by the job's communication provider to `sendTelegramThreadReply`
  (`apps/api/src/handlers/mcp/slack.ts`). Image artifacts are sent as native
  photos via `sendPhoto` (Telegram fetches the artifact URL), falling back to
  a caption-plus-link text message when Telegram rejects the URL.
- Inbound messages that are queued to an active job or accepted as task
  entries get an eyes-emoji ack reaction (`ackTelegramMessageBestEffort`),
  mirroring Slack's ack. Bot reactions are limited to Telegram's fixed
  reaction emoji set; Slack-style names are mapped in
  `TELEGRAM_REACTION_EMOJI_BY_NAME` (`telegram-provider.ts`).
- Telegram tasks run the same turn-satisfaction machinery as Slack: the
  satisfaction state file is enabled for Telegram context
  (`mcp-task-env.ts`), turn starts are recorded for the launch message and
  each queued follow-up, and the worker's `send_chat_reaction_emoji` tool is
  registered so the agent can answer a turn with an emoji reaction. The
  `reaction_add` MCP endpoint dispatches by provider and only allows
  reactions in the chat the job was launched from.
- Worker thread replies carry the shared task-link footer (task URL, linked
  PR, live preview). Because Telegram replies can span multiple messages, the
  footer is posted as its own message and the previous footer message is
  deleted under the shared thread-footer lock, so only the latest reply
  carries it (`postTelegramThreadReplyFooterBestEffort`).
- `TelegramCommunicationProvider` (`packages/communication/src/telegram-provider.ts`)
  sends via the Bot API. With `textFormat: 'markdown'` it converts markdown to
  Telegram HTML (`telegram-format.ts`), falls back to plain text when Telegram
  rejects entity parsing, and splits messages that exceed the 4096-character
  Bot API limit at line/code-fence boundaries.

## Slack Parity Notes

Supported: task entry, follow-up messages to the active job, snapshot resume,
worker chat replies (with markdown rendering and chunking), native photo
attachments with link fallback, inbound ack reactions, current-turn emoji
reactions with turn-satisfaction enforcement, visual proof auto-post
(worker-side gate accepts communication-provider context), inline-keyboard
buttons (follow task, cancel task, start suggestion), `/start` welcome plus
starter-suggestions onboarding, task-link reply footers, webhook verification
and dedup, per-user account linking (`telegram_user_mappings` via link
codes, analogous to `slack_user_mappings`).

Not supported (Bot API or product limitations): thread/channel history reads,
routing-confirmation buttons (Telegram routes and launches directly; the
cancel button covers mis-routes), account-link education, MCP setup
recommendations, automation thread-feedback collection and an explicit
automations destination picker (summaries and execution output fall back to
the primary chat when Slack is absent). The setup kickoff is supported: when
no Slack destination exists, `/setup` posts the kickoff to the primary chat
and the onboarding task carries Telegram communication metadata.
