---
name: mock-telegram-testing
description: Run Roomote Telegram integration flows through the checked-in mock Telegram Bot API harness instead of a real Telegram bot. Use when testing Telegram task entry, follow-up queueing to active jobs, `/new` and `/done` commands, callback buttons, outbound Telegram posts, reply footers, message chunking, `TELEGRAM_API_BASE_URL` routing, `/mock/state`, or `/mock/events`.
---

# Mock Telegram Testing

Use this skill to exercise Roomote's Telegram integration against the checked-in mock Telegram harness. Do not invent another fake Telegram stack and do not fall back to a real Telegram bot unless the user explicitly asks for that parity test.

Telegram has no threads: conversation continuity is inferred from **chat id (+ forum topic id) → active cloud job**, with `/new` and `/done` as the explicit escape hatches after a task completes. That continuity logic is the highest-value thing to test here.

## Quick Reference

| What                          | Value                                                       |
| ----------------------------- | ----------------------------------------------------------- |
| Harness port                  | `3013`                                                      |
| Harness base URL              | `http://127.0.0.1:3013`                                     |
| Telegram API base for Roomote | `TELEGRAM_API_BASE_URL=http://127.0.0.1:3013`               |
| API webhook endpoint          | `http://localhost:3001/api/webhooks/telegram`               |
| Mock state endpoint           | `http://127.0.0.1:3013/mock/state`                          |
| Mock event replay endpoint    | `http://127.0.0.1:3013/mock/events`                         |
| Example scenario              | `packages/communication/scripts/mock-telegram.example.json` |
| Webhook secret source         | `Env.R_TELEGRAM_WEBHOOK_SECRET` from dotenvx                |
| Mock bot identity             | `roomote_mock_bot` (id `7000000001`)                        |
| Mock linked user              | Telegram user id `111000111` (`grace_mock`)                   |

## Step 1: Seed the database

The Telegram webhook handler attributes messages only to linked senders: it needs a `telegram_user_mappings` row for the mock Telegram user pointing at a real local user. Query existing state first, then seed only what's missing:

```bash
# Check existing state
PGPASSWORD=password psql -h localhost -U postgres -d development -c "SELECT telegram_user_id, telegram_chat_id, user_id FROM telegram_user_mappings LIMIT 5;"

# Get a valid user for seeding
PGPASSWORD=password psql -h localhost -U postgres -d development -c "SELECT id FROM users LIMIT 1;"
```

Then seed (adjust user_id from the query above):

```sql
-- Link mock Telegram user 111000111 to a local Roomote user
INSERT INTO telegram_user_mappings (telegram_user_id, telegram_chat_id, telegram_username, user_id)
VALUES ('111000111', '111000111', 'grace_mock', '<user_id>')
ON CONFLICT ON CONSTRAINT telegram_user_mappings_unique DO NOTHING;
```

Messages from unlinked senders are acked and dropped (`telegram_sender_not_linked`) — that is itself a scenario worth testing, but every task-entry scenario requires the mapping above.

## Step 2: Wire the API server env

The API resolves Telegram credentials from real env vars first (`resolveTelegramRuntimeCredentials`, cached ~30s). Set these in the API server's environment (or `.env.local`) before it starts:

```bash
R_TELEGRAM_BOT_TOKEN=7000000001:mock-telegram-token   # any value; the harness accepts all tokens unless acceptedBotTokens is set
R_TELEGRAM_WEBHOOK_SECRET=<any-shared-secret>         # harness reads the same var via dotenvx, so signatures match automatically
R_TELEGRAM_BOT_USERNAME=roomote_mock_bot              # required for group-mention and /new@bot gating scenarios
TELEGRAM_API_BASE_URL=http://127.0.0.1:3013           # reroutes ALL outbound Bot API calls to the harness
```

Without `R_TELEGRAM_WEBHOOK_SECRET` the webhook returns 503; with a mismatched secret it returns 401.

## Step 3: Create a scenario file

Copy the example and fix the webhook target to point at the sandbox API (port 3001, not 4000):

```bash
cp packages/communication/scripts/mock-telegram.example.json /tmp/mock-telegram-test.json
sed -i '' 's|localhost:4000|localhost:3001|g' /tmp/mock-telegram-test.json   # macOS; drop '' on Linux
grep webhookUrl /tmp/mock-telegram-test.json
# Should show: "webhookUrl": "http://localhost:3001/api/webhooks/telegram"
```

For custom scenarios, edit `/tmp/mock-telegram-test.json` directly. Never mutate the committed example.

## Step 4: Start the harness

```bash
pnpm --filter @roomote/communication mock:telegram --state /tmp/mock-telegram-test.json
```

The harness starts on port 3013, replays any events in the `replay` array, and keeps listening. For one-shot replay that exits after: add `--exit-after-replay`.

## Step 5: Inject updates manually (optional)

`update_id` is minted automatically (unique per run) when omitted — pass an explicit `updateId` only when testing the Redis dedup path. `entities` are computed from the text (bot commands, @mentions) exactly like real Telegram, so `/new` and `@roomote_mock_bot` are detected without hand-counting offsets.

```bash
# Private-chat task entry
curl -s -X POST http://127.0.0.1:3013/mock/events \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "message",
    "message": {
      "chat": { "id": 111000111, "type": "private", "first_name": "Grace" },
      "from": { "id": 111000111, "first_name": "Grace", "username": "grace_mock" },
      "text": "!fast what file handles Telegram webhooks?"
    }
  }'

# Follow-up while the job is active (same chat id = same conversation)
curl -s -X POST http://127.0.0.1:3013/mock/events \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "message",
    "message": {
      "chat": { "id": 111000111, "type": "private", "first_name": "Grace" },
      "from": { "id": 111000111, "first_name": "Grace", "username": "grace_mock" },
      "text": "also check the retry logic please"
    }
  }'

# Cancel button click (callback_query) — use a real cloudJobId from the DB
curl -s -X POST http://127.0.0.1:3013/mock/events \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "callback_query",
    "callbackQuery": {
      "id": "cbq-manual-1",
      "from": { "id": 111000111, "first_name": "Grace", "username": "grace_mock" },
      "data": "cancel_task:<cloudJobId>",
      "message": { "message_id": 42, "chat": { "id": 111000111, "type": "private" } }
    }
  }'
```

## Step 6: Inspect results

Always check the mock state after replay — do not declare success just because the harness returned 200:

```bash
# Full state dump
curl -s http://127.0.0.1:3013/mock/state | jq .

# Just the messages (bot messages have from.is_bot == true)
curl -s http://127.0.0.1:3013/mock/state | jq '.messages'

# Bot replies that quote a user message (reply anchoring)
curl -s http://127.0.0.1:3013/mock/state | jq '.messages[] | select(.reply_to_message_id != null)'

# Ack reactions on inbound messages (eyes = picked up)
curl -s http://127.0.0.1:3013/mock/state | jq '.messages[] | select(.reactions | length > 0)'

# Callback answers (button spinners stopped)
curl -s http://127.0.0.1:3013/mock/state | jq '.callbackAnswers'
```

## Scenario Selection

See `references/scenarios.md` for the full user-journey catalog. Common picks:

- **`private-fast-answer`** — `!fast ...` inline Q&A without a cloud job
- **`private-task-entry`** — DM task kickoff that creates a cloud job
- **`followup-to-active-job`** — second message in the same chat queues to the running job instead of launching a new task
- **`new-task-command`** — `/new <req>` after completion forces a fresh task instead of snapshot resume
- **`group-mention-gating`** — group messages ignored unless the bot is mentioned
- **`duplicate-delivery`** — same `update_id` twice → exactly-once handling
- **`unlinked-sender`** — message from an unmapped Telegram user is nudged and dropped
- **`long-reply-chunking`** — worker reply over 4096 chars splits into multiple messages
- **`cancel-button`** — callback_query cancels the running job
- **`routing-confirmation`** — low-confidence route posts a workspace picker; Nevermind is the zero-side-effect live-test path

LLM-judged eval scenarios live in `packages/communication/evals/scenarios/` and run via `pnpm --filter @roomote/communication eval:telegram-scenario`.

## Guardrails

- Do not create a second mock Telegram server. Use the harness in `packages/communication/`.
- Do not use a real Telegram bot unless the user explicitly asks for that.
- Do not declare success because the harness started. Always inspect `/mock/state`.
- Do not mutate the committed example scenario — copy it to `/tmp/` first.
- Do not assume the example webhook target port is correct. The sandbox API runs on 3001.
- Do not reuse explicit `updateId` values across runs — Redis dedups update ids for 5 minutes, silently dropping your event. Omit `updateId` unless the dedup path is what you are testing.
- Do not claim continuity behavior is covered unless you observed the second message being queued to the existing job (no second task-start ack) in `/mock/state` and `cloud_jobs`.

## Output Standard

End each use of this skill with:

- the scenario used and the webhook target
- the inbound updates injected (if any)
- the key messages, reactions, or callback answers observed in `/mock/state`
- a pass or fail judgment
- the next debugging lead if the behavior failed
