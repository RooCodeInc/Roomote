---
title: Telegram Integration
status: active
last_reviewed: 2026-07-08
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
| `TELEGRAM_API_BASE_URL`    | Bot API host, default `https://api.telegram.org`. Point it at the mock Telegram harness to capture outbound Bot API traffic in tests (see Testing).                          |

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
   (`task-orchestration.ts`). Before launching, low-confidence routes get a
   **routing-confirmation card** (`routing-confirmation.ts`, mirroring
   Slack's gate): when the router's `debug.confidence` is below 0.95, the
   workspace was remapped, or it picked all-repositories while environments
   exist, the bot posts a compact card — "Planning to run this in
   {suggested} — starting in ~5s." with ✅ Yes / ✖️ Nope buttons — instead
   of launching. Yes (or ~5 seconds of silence) starts the suggestion; the
   short window keeps the normal flow near-instant, with the started
   message's cancel button covering late mis-route recovery (in-process
   timer; a restart drops it and the pending choice expires via its
   15-minute Redis TTL). Nope swaps the same message into a workspace
   picker (environments, All repositories, ✖️ Nevermind) via the provider's
   `editMessageText`; the picker never auto-starts. A router `fallback`
   shows the picker directly (previously it silently launched in all
   repos). The pending choice lives in Redis
   (`telegram:pending_route:<id>`; buttons carry only the short id to stay
   under the 64-byte callback_data limit) and is claimed one-shot with
   `GETDEL`, so a click and the auto-confirm timer can never both launch;
   the Nope transition re-keys the state under a fresh id so the suggestion
   timer can never fire after the user said no. Only the requester's linked
   account may click; a new task-entry message in the same chat/topic
   invalidates the previous pending card. Suggestion
   buttons and other explicit-intent launches skip the card
   (`skipRoutingConfirmation`). In a Topics-enabled supergroup
   (`chat.is_forum`), a task launched outside any topic gets **its own forum
   topic** (`launchTelegramTask` in `task-launch.ts`): the bot creates a
   topic named after the request (`createForumTopic`, requires admin with
   the manage-topics right), the job's `communicationThreadId` points at it,
   the started card posts inside it, and a pointer with an "Open topic" deep
   link is left as a reply to the launch message. Worker replies re-anchor
   to the in-topic started card (`setLatestInboundMessageId`), so the whole
   conversation lives in the topic — Telegram's native equivalent of a Slack
   thread. Launches from inside an existing topic stay there;
   topic-creation failure (plain groups, missing rights) falls back to the
   main chat instead of dropping the task. Bot commands count as invocations — for both
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
   Routing-confirmation buttons (`route_ok:<id>` Yes, `route_alt:<id>` Nope
   → picker, `route_pick:<id>:<n>` picker choice, `route_no:<id>`
   Nevermind; build/parse helpers in `callback-data.ts`) claim the pending
   route from Redis and launch, transition, or dismiss via the shared
   `launchTelegramTask` (`task-launch.ts`). Unknown callback data is
   answered and dropped so buttons never spin.

## Onboarding

Telegram deployments without a Slack destination get the starter-suggestions
intro in the captured primary chat (`setup-suggestions.ts`, forked from
`submitTaskSuggestions`). Unlike Slack's root-plus-five-replies fan-out, the
Telegram intro is a single message listing up to five ideas with one
inline start button each — one notification total. Clicks claim the
suggestion (`agentSuggestionMessages.launchClaimedAt`) so double taps cannot
launch twice.

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
- While a reply is being delivered, `sendTelegramThreadReply` shows a
  "typing…" chat action (`provider.sendChatAction`) on a ~4s heartbeat
  (`startTelegramTypingHeartbeat`), stopping the instant delivery finishes.
  The reply text is composed on the worker before the API is called, so this
  spans the delivery window (chunks, photo fetch, footer), not the work
  phase — it never lingers during idle or long silences, and a chat-action
  failure never blocks the reply. Telegram auto-clears the action after ~5s
  and when the message lands, so it is a fire-and-forget burst, not a state
  to turn off.
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

## Testing

Prefer the mock Telegram harness for integration behavior — it impersonates
both halves of the Bot API the way the mock Slack harness does for Slack:

- [`packages/communication/src/mock-telegram-server.ts`](../../packages/communication/src/mock-telegram-server.ts) —
  in-process Bot API fake (`sendMessage`, `sendPhoto`, `setMessageReaction`,
  `deleteMessage`, `editMessageReplyMarkup`, `answerCallbackQuery`,
  `setWebhook`/`getWebhookInfo`) with a `/mock/state` + `/mock/events` control
  plane and an update `dispatch()` that posts signed updates (secret-token
  header) to the real `/api/webhooks/telegram` handler. It enforces real
  Telegram limits (4096-char messages, unknown-chat and missing-reply-target
  rejections) and auto-computes `entities` for injected message text so
  bot-command/mention detection behaves as in production. Failure-injection
  knobs (`behavior.rejectHtmlParseMode`, `behavior.rejectPhotos`) exercise the
  provider's fallback paths.
- `TELEGRAM_API_BASE_URL` reroutes every runtime
  `TelegramCommunicationProvider` construction to the harness (resolved in
  [`packages/communication/src/telegram-api-base-url.ts`](../../packages/communication/src/telegram-api-base-url.ts)).
- CLI runner: `pnpm --filter @roomote/communication mock:telegram --state <scenario.json>`
  ([`packages/communication/scripts/run-mock-telegram.ts`](../../packages/communication/scripts/run-mock-telegram.ts),
  example scenario next to it). Eval runner with LLM-judged criteria bundles:
  `pnpm --filter @roomote/communication eval:telegram-scenario`
  ([`packages/communication/evals/run-telegram-scenario.ts`](../../packages/communication/evals/run-telegram-scenario.ts)).
- Unit coverage: [`packages/communication/src/__tests__/mock-telegram-server.test.ts`](../../packages/communication/src/__tests__/mock-telegram-server.test.ts)
  drives the real provider against the harness;
  [`apps/api/src/handlers/telegram/__tests__/`](../../apps/api/src/handlers/telegram/__tests__)
  covers the webhook handler with module mocks.
- End-to-end workflow (DB seeding, env wiring, scenario catalog):
  [`.agents/skills/mock-telegram-testing/SKILL.md`](../../.agents/skills/mock-telegram-testing/SKILL.md).

When a change touches task entry, active-job follow-up queueing, `/new` +
`/done` handling, or callback buttons, cover both the update payload shape and
the persisted cloud-job state — chat-id continuity is the Telegram substitute
for Slack threads, so continuation bugs are the highest-value scenarios.

## Slack Parity Notes

Supported: task entry, follow-up messages to the active job, snapshot resume,
worker chat replies (with markdown rendering and chunking), native photo
attachments with link fallback, inbound ack reactions, current-turn emoji
reactions with turn-satisfaction enforcement, visual proof auto-post
(worker-side gate accepts communication-provider context), inline-keyboard
buttons (follow task, cancel task, start suggestion), `/start` welcome plus
starter-suggestions onboarding, task-link reply footers, webhook verification
and dedup, per-user account linking (`telegram_user_mappings` via link
codes, analogous to `slack_user_mappings`), routing confirmation with a
manual workspace picker (same Yes/Nope-then-picker two-step as Slack, via
inline keyboard + `editMessageText`; same 0.95 confidence gate but a ~5s
auto-confirm vs Slack's 30s constant; router fallback shows the picker
instead of silently launching in all repos), and a "typing…" indicator while
a reply is delivered (`sendChatAction` heartbeat, bounded to the send), and
per-task forum topics in Topics-enabled supergroups (the closest analog to
Slack threads; DMs and plain groups keep chat-scoped continuity).
Unlike Slack there is no free-text correction while a confirmation is
pending — a new message in the chat starts a fresh routing flow and
invalidates the old card.

The typing indicator is scoped to reply delivery, not the work phase: there
is no worker→API progress signal before a reply is composed (the worker
sends the finished text), so the long silence between the eyes ack and the
first reply is still unfilled. A "still working" status line during that
silence remains a possible future addition (would reuse `editMessageText`).

Not supported (Bot API or product limitations): thread/channel history reads,
account-link education, MCP setup
recommendations, automation thread-feedback collection and an explicit
automations destination picker (summaries and execution output fall back to
the primary chat when Slack is absent). The setup kickoff is supported: when
no Slack destination exists, `/setup` posts the kickoff to the primary chat
and the onboarding task carries Telegram communication metadata.
