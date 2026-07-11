# Telegram User-Journey Scenario Catalog

Each scenario lists the updates to inject, the expected observable behavior, and where to assert it. "State" means `GET http://127.0.0.1:3013/mock/state`; "DB" means the `cloud_jobs` table. Bot messages have `from.is_bot == true`.

Because Telegram has no threads, the core product invariant under test is: **one chat (or forum topic) maps to at most one active conversation**, continuity comes from the active-job lookup, and `/new`/`/done` are the only ways to break out early.

## 1. private-fast-answer

A linked user DMs `!fast <question>`.

- Inject: `message` in private chat `111000111`, text `!fast what file handles Telegram webhooks?`.
- Expect: eyes reaction on the inbound message; one inline bot answer in the same chat; **no** cloud job created.
- Assert: state `.messages` (one bot message), `.messages[].reactions`; DB has no new `cloud_jobs` row.

## 2. private-task-entry

A linked user DMs a work request.

- Inject: `message` in private chat, text `fix the flaky login test in apps/web`.
- Expect: eyes ack; a task-started message with a follow-task URL button and a `cancel_task:<jobId>` cancel button; a new cloud job whose payload carries `communicationProvider: 'telegram'`, `communicationChannelId: '111000111'`.
- Assert: state (started message with `reply_markup.inline_keyboard`); DB payload fields.

## 3. followup-to-active-job (the no-threads core case)

A second message arrives in the same chat while the job is active.

- Inject: scenario 2, then ~5s later another `message` in the same chat: `also check the retry logic`.
- Expect: the follow-up is **queued to the running job** (`queueCommunicationMessage`), acked with eyes — no second task-started message, no second job.
- Assert: state shows the second inbound message with a reaction but no new task-start ack; DB still has one active job for the chat.
- Regression risk: if active-job lookup breaks, every follow-up silently launches a parallel task — the worst UX failure this surface has.

## 4. new-task-command / done-command

After a task completes, the next plain message resumes its snapshot; `/new` or `/done` must force a fresh task instead.

- Inject: complete a task in the chat (or seed a Completed job with a resumable snapshot), then `message` with text `/new upgrade the login tests to vitest 4`.
- Expect: a fresh task launch (new job id), not a snapshot resume; the `/new` invocation is stripped from the queued task text.
- Variants: `/done <req>`; group forms `/new@roomote_mock_bot <req>` and `@roomote_mock_bot /new <req>`; a mid-sentence `/new` must NOT trigger (it is ordinary text); `/new` while a job is still running is refused with an echo-back so the user can resend.
- Assert: DB (new job vs `SnapshotResume` payload); state for the refusal echo.

## 5. group-mention-gating

Groups only enter tasks on explicit address. Requires `R_TELEGRAM_BOT_USERNAME=roomote_mock_bot` on the API.

- Inject: `message` in supergroup `-100222000222` without any mention → expect **silence** (no ack, no reply, no job).
- Inject: `@roomote_mock_bot <request>` in the same group → expect ack + task entry.
- Follow-ups in the group while that job is active queue to it even without a mention (chat-id continuity), which is intentional but worth observing.
- Assert: state message list; DB job payload `communicationChannelId: '-100222000222'`.

## 6. forum-topic-isolation

Forum supergroups scope conversations per topic via `message_thread_id`.

- Inject: task entry with `message_thread_id: 7`; then a follow-up with `message_thread_id: 8`.
- Expect: the topic-8 message does **not** queue to the topic-7 job (thread id is part of the active-job key) — it is its own task entry.
- Assert: DB `communicationThreadId` on each job; bot replies carry the matching `message_thread_id` in state.

## 7. duplicate-delivery

Telegram redelivers updates on webhook timeouts.

- Inject: the same event twice with an explicit identical `updateId`, 6s apart.
- Expect: exactly-once handling — one ack, one answer/launch.
- Assert: state has exactly one bot response; the eval fixture `telegram-duplicate-delivery.json` automates this.

## 8. unlinked-sender

- Inject: `message` from `from.id: 222000222` (no `telegram_user_mappings` row).
- Expect: private chat → textual "link your account" nudge, update acked and dropped, no job. Group → nudge only when the bot was addressed, rate-limited (once/sender/chat/6h), with a `t.me/...?start=link` deep-link button.
- Assert: state (nudge message, no task ack); DB unchanged.

## 9. link-code-flow

- Mint a code via the web UI (or `createTelegramLinkCode`), then inject a private `message` whose text is the bare code (or `/start <code>`).
- Expect: mapping upserted, confirmation reply, primary chat captured (`TELEGRAM_PRIMARY_CHAT_ID` deployment env var written once).
- Assert: DB `telegram_user_mappings`; state confirmation message. Also verify an invalid/expired code gets an error reply and is never treated as task text.

## 10. start-welcome

- Inject: bare `/start` in a private chat from an unlinked user.
- Expect: welcome message with linking guidance — no task, no nudge-drop.
- Assert: state.

## 11. long-reply-chunking

Worker replies over 4096 chars must split at line/code-fence boundaries.

- Drive a running task to produce a long `send_chat_reply` (or call the MCP thread-reply endpoint directly with a long body).
- Expect: multiple bot messages each ≤ 4096 chars; only the first quotes the user's message (`reply_to_message_id`); code fences reopen across chunks; the task-link footer is a separate message and the previous footer was deleted.
- Assert: state message lengths, `reply_to_message_id` distribution, exactly one footer message present.
- The harness enforces the 4096 limit with a real `message is too long` 400, so a chunking regression fails loudly.

## 12. markdown-fallback

- Set `state.behavior.rejectHtmlParseMode: true` in the scenario, then drive any bot reply with markdown.
- Expect: the provider retries as plain text; the reply lands without parse_mode instead of erroring.
- Assert: state (`parse_mode` absent, raw markdown text).

## 13. photo-fallback

- Set `state.behavior.rejectPhotos: true`; drive a reply with an image artifact.
- Expect: caption-plus-link text message instead of a photo.
- Assert: state (`photo_url` absent, text contains the artifact URL).

## 14. cancel-button

- Inject: `callback_query` with `data: "cancel_task:<jobId>"` for a running job.
- Expect: job stopped, callback answered (spinner cleared), cancel button removed from the started message, confirmation posted.
- Assert: state `.callbackAnswers`, the started message's `reply_markup` now empty, confirmation message; DB job status canceled.

## 15. routing-confirmation (verified live 2026-07-08)

When the router is unsure (confidence < 0.95, workspace remapped, or all-repositories picked while environments exist), task entry posts a confirmation card instead of launching.

- Inject: private-chat task entry whose target workspace is ambiguous (e.g. `fix the flaky login test in the web app` with several environments configured).
- Expect: webhook responds `confirmationPending: true`; a compact card "Planning to run this in **{suggested}** — starting in ~5s." with one row of buttons: ✅ Yes (`route_ok:<id>`) and ✖️ Nope (`route_alt:<id>`). Router `fallback` skips the Yes/Nope step and shows the picker directly ("could not confidently pick a workspace") with no auto-start.
- Click paths:
  - ✅ Yes → callback answered `Starting in {workspace}.`, the card is edited in place to "Starting in **{workspace}**." (keyboard removed), task launched.
  - ✖️ Nope → the same message is edited into the picker ("Okay — where should I run this?" + one button per workspace + ✖️ Nevermind), re-keyed under a fresh pending-route id so the 5s timer can never fire the suggestion afterwards. The picker waits — no timer.
  - Picker choice (`route_pick:<id>:<n>`) → same as Yes but with the chosen workspace.
  - ✖️ Nevermind (`route_no:<id>`) → callback answered `Okay — not starting a task.`, card finalized, nothing launches (the safe path for live testing: Nope → Nevermind).
  - No click → the Yes/Nope card auto-starts the suggestion after ~5s (card edited to "Starting in **{workspace}**." when the timer fires); pickers just expire (15-min Redis TTL).
  - Click from a different Telegram user → `Only the requester can choose a workspace for this task.` and the pending choice is NOT consumed.
- Assert: state `.messages` (card text edited through the stages, final `reply_markup` empty), `.callbackAnswers`; DB `cloud_jobs` for the launch (or its absence after Nevermind).
- Note: the pending choice is one-shot (`GETDEL`) — a second click on a stale card gets `This choice expired — send the request again.` The 5s window is too short to tap from a phone notification; that is intentional — Nope is for users watching the chat, and the started message's cancel button covers everyone else.

## 16. suggestion-button

- Seed starter suggestions (or run the suggester), then inject `callback_query` with `data: "idea:<suggestionId>"`.
- Expect: suggestion claimed atomically (double taps do not double-launch), task launched through normal routing.
- Assert: DB `agentSuggestionMessages.launchClaimedAt`; state.

## 17. typing-indicator

While a worker reply is being delivered, the bot shows "typing…".

- Drive a running task to post a `send_chat_reply` (or call the MCP thread-reply endpoint directly), OR unit-test the provider: `provider.sendChatAction({ channelId })`.
- Expect: one or more `sendChatAction` calls with `action: "typing"` for the chat, fired on a ~4s heartbeat that stops the moment delivery finishes. It never fires during the idle/work phase (no worker→API signal exists before the reply is composed).
- Assert: state `.chatActions` (array of `{ chat_id, action, message_thread_id? }`); the reply message(s) still land even if the typing action errors (best-effort).
- Note: Telegram auto-clears a chat action after ~5s and when the message lands, so a single short reply shows one brief flash; a long chunked/photo reply re-fires until the last message posts.

## Known parity gaps (do not file as harness bugs)

- No "still working" indicator during the long silence: the typing indicator is scoped to reply _delivery_, so the gap between the eyes ack and the first reply is unfilled (no worker→API pre-reply signal exists). A status line via `editMessageText` would be a future addition.
- No free-text routing correction: while a confirmation card is pending, a new message starts a fresh routing flow (and invalidates the old card) instead of being classified as confirm/cancel/correct like Slack.
- No thread/channel history reads: the Bot API cannot fetch history, so routing sees only the current message and queued follow-ups.
