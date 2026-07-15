---
name: mock-discord-testing
description: Run Roomote Discord integration flows through the checked-in mock Discord REST harness and synthetic Gateway envelopes instead of a real Discord bot. Use when testing Discord task entry, follow-up queueing to active jobs, slash commands (`/new`, `/link`, `/help`), button interactions, outbound Discord posts, task threads and forum posts, message chunking, `DISCORD_API_BASE_URL` routing, `/mock/state`, or `/mock/events`.
---

# Mock Discord Testing

Use this skill to exercise Roomote's Discord integration against the checked-in mock Discord harness. Do not invent another fake Discord stack and do not fall back to a real Discord bot unless the user explicitly asks for that parity test.

Discord differs from the webhook surfaces: inbound events arrive through the **Gateway** (WebSocket) service, which forwards durable envelopes to `POST /api/internal/discord/events` guarded by a shared secret header. The harness stands in for both halves: it serves the Discord REST API (outbound calls, via `DISCORD_API_BASE_URL`) and injects synthetic Gateway envelopes into the internal events endpoint (inbound, via `/mock/events`). The real Gateway service never needs to run.

Discord continuity is inferred from **task thread → active cloud job**: root-channel messages need an @mention (DMs do not), each task gets its own thread or forum post, and messages inside a known task thread continue the active run without a mention.

## Quick Reference

| What                            | Value                                                        |
| ------------------------------- | ------------------------------------------------------------ |
| Harness port                    | `3014`                                                       |
| Harness base URL                | `http://127.0.0.1:3014/api/v10`                              |
| Discord API base for Roomote    | `DISCORD_API_BASE_URL=http://127.0.0.1:3014/api/v10`         |
| Internal events endpoint        | `http://localhost:3001/api/internal/discord/events`          |
| Mock state endpoint             | `http://127.0.0.1:3014/mock/state`                           |
| Mock event injection endpoint   | `http://127.0.0.1:3014/mock/events`                          |
| Example scenario                | `packages/communication/scripts/mock-discord.example.json`   |
| Gateway secret source           | `R_DISCORD_GATEWAY_SECRET`, falling back to `ENCRYPTION_KEY` |
| Mock bot identity               | `RoomoteBot` (id `100000000000000001`)                       |
| Mock application id             | `200000000000000001`                                         |
| Mock guild id                   | `300000000000000001`                                         |

## Step 1: Seed the database

The Discord events handler attributes messages only to linked senders: it needs a `discord_user_mappings` row for the mock Discord user pointing at a real local user. Query existing state first, then seed only what's missing:

```bash
# Check existing state
PGPASSWORD=password psql -h localhost -U postgres -d development -c "SELECT discord_user_id, user_id FROM discord_user_mappings LIMIT 5;"

# Get a valid user for seeding
PGPASSWORD=password psql -h localhost -U postgres -d development -c "SELECT id FROM users LIMIT 1;"
```

Then seed (adjust user_id from the query above):

```sql
-- Link mock Discord user 111000111000111001 to a local Roomote user
INSERT INTO discord_user_mappings (discord_user_id, discord_username, user_id)
VALUES ('111000111000111001', 'grace_mock', '<user_id>')
ON CONFLICT DO NOTHING;
```

Messages from unlinked senders that attempt task entry get a "link your account" reply and are dropped — that is itself a scenario worth testing, but every task-entry scenario requires the mapping above.

## Step 2: Wire the API server env

The API resolves Discord credentials from real env vars first (`resolveDiscordRuntimeCredentials`, cached). Set these in the API server's environment (or `.env.local`) before it starts:

```bash
R_DISCORD_BOT_TOKEN=mock-discord-token                       # must match the harness botToken (default: mock-discord-token)
DISCORD_API_BASE_URL=http://127.0.0.1:3014/api/v10           # reroutes ALL outbound Discord REST calls to the harness
# R_DISCORD_GATEWAY_SECRET is optional; the events endpoint falls back to ENCRYPTION_KEY
```

The harness reads the same gateway secret via dotenvx, so the `x-roomote-discord-gateway-secret` header matches automatically. Without any secret configured the events endpoint returns 503; with a mismatched secret it returns 401.

Note: token validation calls `/users/@me` and `/oauth2/applications/@me`, which the harness serves, so saved-credential validation succeeds against the mock.

## Step 3: Create a scenario file

Copy the example and fix the events target to point at the sandbox API (port 3001, not 4000):

```bash
cp packages/communication/scripts/mock-discord.example.json /tmp/mock-discord-test.json
sed -i '' 's|localhost:4000|localhost:3001|g' /tmp/mock-discord-test.json   # macOS; drop '' on Linux
grep eventsUrl /tmp/mock-discord-test.json
# Should show: "eventsUrl": "http://localhost:3001/api/internal/discord/events"
```

For custom scenarios, edit `/tmp/mock-discord-test.json` directly. Never mutate the committed example.

## Step 4: Start the harness

```bash
pnpm --filter @roomote/communication mock:discord --state /tmp/mock-discord-test.json
```

The harness starts on port 3014, replays any events in the `replay` array, and keeps listening. For one-shot replay that exits after: add `--exit-after-replay`.

## Step 5: Inject events manually (optional)

`/mock/events` takes `{ kind: 'message' | 'interaction', payload: <raw Gateway d field>, eventId? }`. The `eventId` defaults to `payload.id`; the API deduplicates event ids in Redis, so mint a fresh message id per injection unless the dedup path is what you are testing.

```bash
# DM task entry (channel type 1 = DM; no mention needed)
curl -s -X POST http://127.0.0.1:3014/mock/events \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "message",
    "payload": {
      "id": "600000000000000101",
      "channel_id": "500000000000000001",
      "content": "fix the flaky login test in apps/web",
      "author": { "id": "111000111000111001", "username": "grace_mock" },
      "mentions": [],
      "attachments": [],
      "channel": { "id": "500000000000000001", "type": 1 }
    }
  }'

# Guild root-channel task entry requires mentioning the bot
curl -s -X POST http://127.0.0.1:3014/mock/events \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "message",
    "payload": {
      "id": "600000000000000102",
      "channel_id": "400000000000000001",
      "guild_id": "300000000000000001",
      "content": "<@100000000000000001> summarize open PRs",
      "author": { "id": "111000111000111001", "username": "grace_mock" },
      "mentions": [{ "id": "100000000000000001", "username": "RoomoteBot", "bot": true }],
      "attachments": [],
      "channel": { "id": "400000000000000001", "type": 0, "guild_id": "300000000000000001" }
    }
  }'

# Button interaction (e.g. cancel); interactions carry an id + token + custom_id
curl -s -X POST http://127.0.0.1:3014/mock/events \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "interaction",
    "payload": {
      "id": "700000000000000001",
      "application_id": "200000000000000001",
      "type": 3,
      "token": "mock-interaction-token",
      "channel_id": "500000000000000001",
      "user": { "id": "111000111000111001", "username": "grace_mock" },
      "data": { "custom_id": "discord:cancel:<runId>", "component_type": 2 }
    }
  }'
```

## Step 6: Inspect results

Always check the mock state after replay — do not declare success just because the harness returned 200:

```bash
# Full state dump
curl -s http://127.0.0.1:3014/mock/state | jq .

# Outbound bot messages per channel
curl -s http://127.0.0.1:3014/mock/state | jq '.messages'

# Threads/forum posts the bot created (channels beyond the seeded ones)
curl -s http://127.0.0.1:3014/mock/state | jq '.channels'

# Ack reactions the bot added (eyes = picked up)
curl -s http://127.0.0.1:3014/mock/state | jq '.reactions'

# Raw request log (every REST call Roomote made)
curl -s http://127.0.0.1:3014/mock/state | jq '.requests | map({method, path})'
```

## Scenario Selection

See `references/scenarios.md` for the full user-journey catalog. Common picks:

- **`dm-task-entry`** — DM task kickoff that creates a cloud job and a task reply
- **`guild-mention-task-entry`** — root-channel @mention creates a task thread
- **`followup-in-task-thread`** — message in the task thread queues to the running job instead of launching a new task
- **`slash-new-command`** — `/new request:<...>` interaction forces a fresh task
- **`slash-link-dm-only`** — `/link code:<...>` refused outside DMs, links inside a DM
- **`unlinked-sender`** — task entry from an unmapped Discord user gets a link nudge and is dropped
- **`duplicate-delivery`** — same `eventId` twice → exactly-once handling (409 duplicate)
- **`long-reply-chunking`** — worker reply over 2000 chars splits into multiple messages
- **`cancel-button`** — component interaction cancels the running job

LLM-judged eval scenarios live in `packages/communication/evals/scenarios/` and run via `pnpm --filter @roomote/communication eval:discord-scenario`.

## Guardrails

- Do not create a second mock Discord server. Use the harness in `packages/communication/`.
- Do not use a real Discord bot unless the user explicitly asks for that.
- Do not run the real Gateway service against the harness — `/mock/events` IS the Gateway stand-in.
- Do not declare success because the harness started. Always inspect `/mock/state`.
- Do not mutate the committed example scenario — copy it to `/tmp/` first.
- Do not assume the example events target port is correct. The sandbox API runs on 3001.
- Do not reuse message/event ids across runs — the API deduplicates event ids in Redis, silently rejecting your event (409). Mint fresh ids unless the dedup path is what you are testing.
- Do not claim continuity behavior is covered unless you observed the second message being queued to the existing job (no second task-start reply) in `/mock/state` and the tasks tables.

## Output Standard

End each use of this skill with:

- the scenario used and the events target
- the inbound envelopes injected (if any)
- the key messages, channels/threads, or reactions observed in `/mock/state`
- a pass or fail judgment
- the next debugging lead if the behavior failed
