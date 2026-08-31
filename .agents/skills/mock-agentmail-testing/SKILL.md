---
name: mock-agentmail-testing
description: Run Roomote email (AgentMail) integration flows through the checked-in mock AgentMail API harness instead of the real AgentMail service. Use when testing email task entry, inbox provisioning, webhook registration, Svix-signed `message.received` deliveries, duplicate/oversize/auto-submitted email handling, outbound email replies, `AGENTMAIL_API_BASE_URL` routing, `/mock/state`, or `/mock/events`.
---

# Mock AgentMail Testing

Use this skill to exercise Roomote's email integration against the checked-in mock AgentMail harness. Do not invent another fake AgentMail stack and do not use the real AgentMail service unless the user explicitly asks for that parity test.

Email continuity is inferred from **thread id → conversation**. The harness mints reply headers (`in_reply_to`, `references`) the way a real mail chain would, and signs every webhook delivery exactly like Svix does, so the production verifier accepts mock deliveries unchanged. Webhook signature verification, thread continuity, and duplicate-delivery dedup are the highest-value things to test here.

## Quick Reference

| What                           | Value                                                        |
| ------------------------------ | ------------------------------------------------------------ |
| Harness port                   | `3015`                                                       |
| Harness base URL               | `http://127.0.0.1:3015`                                      |
| AgentMail API base for Roomote | `AGENTMAIL_API_BASE_URL=http://127.0.0.1:3015`               |
| API webhook endpoint           | `http://localhost:3001/api/webhooks/agentmail`               |
| Mock state endpoint            | `http://127.0.0.1:3015/mock/state`                           |
| Mock event replay endpoint     | `http://127.0.0.1:3015/mock/events`                          |
| Example scenario               | `packages/communication/scripts/mock-agentmail.example.json` |
| Mock inbox identity            | `roomote@agentmail.to`                                       |
| Seeded webhook secret          | `whsec_...` from the scenario file (or minted at register)   |

## Step 1: Wire the API server env

Set these in the API server's environment (or `.env.local`) before it starts:

```bash
R_AGENTMAIL_API_KEY=mock-agentmail-api-key            # any value; the harness accepts all bearer tokens unless acceptedApiKeys is set
AGENTMAIL_API_BASE_URL=http://127.0.0.1:3015          # reroutes ALL outbound AgentMail API calls to the harness
```

Webhook secrets need no manual wiring: when the app registers its webhook through `POST /v0/webhooks`, the harness mints the `whsec_...` secret and returns it, exactly like real AgentMail. If the app relies on a pre-provisioned secret (`R_AGENTMAIL_WEBHOOK_SECRET`), seed a webhook with that secret in the scenario file instead — deliveries are signed with whatever secret the registration holds.

## Step 2: Create a scenario file

Copy the example and fix the webhook target to point at the sandbox API (port 3001, not 4000):

```bash
cp packages/communication/scripts/mock-agentmail.example.json /tmp/mock-agentmail-test.json
sed -i '' 's|localhost:4000|localhost:3001|g' /tmp/mock-agentmail-test.json   # macOS; drop '' on Linux
grep url /tmp/mock-agentmail-test.json
# Should show: "url": "http://localhost:3001/api/webhooks/agentmail"
```

For custom scenarios, edit `/tmp/mock-agentmail-test.json` directly. Never mutate the committed example.

## Step 3: Start the harness

```bash
pnpm --filter @roomote/communication mock:agentmail --state /tmp/mock-agentmail-test.json
```

The harness starts on port 3015, replays any events in the `replay` array (delivering signed webhooks to every matching registration), and keeps listening. For one-shot replay that exits after: add `--exit-after-replay`.

## Step 4: Inject inbound emails manually (optional)

Ids (`msg_*`, `thread_*`, `evt_*`, svix delivery ids) are minted automatically and unique per run. Pass `threadId` to continue an existing thread; omit it to start a fresh one.

```bash
# New email → new thread, signed message.received delivery
curl -s -X POST http://127.0.0.1:3015/mock/events \
  -H 'Content-Type: application/json' \
  -d '{
    "inboxId": "roomote@agentmail.to",
    "from": "grace@example.com",
    "subject": "Flaky login test",
    "text": "Hi Roomote — can you look into the flaky login test?"
  }'

# Follow-up in the same thread (use threadId from the previous dispatchResult)
curl -s -X POST http://127.0.0.1:3015/mock/events \
  -H 'Content-Type: application/json' \
  -d '{
    "inboxId": "roomote@agentmail.to",
    "from": "grace@example.com",
    "text": "also check the retry logic please",
    "threadId": "<threadId>"
  }'

# Auto-generated sender (adds the Auto-Submitted header — loop-guard scenarios)
curl -s -X POST http://127.0.0.1:3015/mock/events \
  -H 'Content-Type: application/json' \
  -d '{
    "inboxId": "roomote@agentmail.to",
    "from": "noreply@example.com",
    "text": "Your build failed.",
    "autoSubmitted": true
  }'

# Oversize payload: webhook arrives WITHOUT text/html (1MB cap); the app must
# re-fetch the full message via GET /v0/inboxes/{id}/messages/{message_id}
curl -s -X POST http://127.0.0.1:3015/mock/events \
  -H 'Content-Type: application/json' \
  -d '{
    "inboxId": "roomote@agentmail.to",
    "from": "grace@example.com",
    "subject": "Huge recap",
    "text": "pretend this is 2MB of text",
    "oversize": true
  }'

# Duplicate delivery: resends the PREVIOUS event verbatim with the SAME
# svix-id → exactly-once handling
curl -s -X POST http://127.0.0.1:3015/mock/events \
  -H 'Content-Type: application/json' \
  -d '{ "inboxId": "roomote@agentmail.to", "from": "grace@example.com", "duplicate": true }'

# Redeliver any past event by id (same svix-id, fresh timestamp + signature)
curl -s -X POST http://127.0.0.1:3015/mock/events \
  -H 'Content-Type: application/json' \
  -d '{ "kind": "redeliver", "eventId": "<eventId>" }'
```

Every response carries `dispatchResult` with `eventId`, `svixId`, `messageId`, `threadId`, and per-webhook `deliveries` (status + body from the Roomote endpoint).

## Step 5: Inspect results

Always check the mock state after replay — do not declare success just because the harness returned 200:

```bash
# Full state dump
curl -s http://127.0.0.1:3015/mock/state | jq .

# Outbound emails the system under test sent (replies + fresh sends)
curl -s http://127.0.0.1:3015/mock/state | jq '.messages[] | select(.direction == "outbound")'

# Replies threaded onto the inbound email (email continuity)
curl -s http://127.0.0.1:3015/mock/state | jq '.messages[] | select(.direction == "outbound" and .in_reply_to != null)'

# Webhook registrations the app created (secret, inbox filter, event filter)
curl -s http://127.0.0.1:3015/mock/state | jq '.webhooks'

# Delivery log per event (status of every webhook POST, including retries)
curl -s http://127.0.0.1:3015/mock/state | jq '.events[] | {event_id, svix_id, deliveries}'
```

To reset between scenarios, `POST /mock/state` with a fresh state object (it replaces inboxes, webhooks, messages, and events wholesale).

## Scenario Selection

- **`email-task-entry`** — new inbound email creates a task; assert an outbound reply lands in the same thread
- **`followup-to-active-thread`** — second email with the same `threadId` queues to the running job instead of launching a new task
- **`duplicate-delivery`** — `duplicate: true` → same svix-id twice → exactly-once handling
- **`oversize-payload`** — `oversize: true` → app must re-fetch the message body by id before acting
- **`auto-submitted-loop-guard`** — `autoSubmitted: true` → automated senders must not trigger reply loops
- **`webhook-registration`** — app boots, registers its webhook via `POST /v0/webhooks` (idempotent per `client_id`), and the secret round-trips into signature verification
- **`reply-idempotency`** — app retries a reply with the same `Idempotency-Key` → exactly one outbound message in `/mock/state`

## Guardrails

- Do not create a second mock AgentMail server. Use the harness in `packages/communication/`.
- Do not use the real AgentMail service unless the user explicitly asks for that.
- Do not declare success because the harness started. Always inspect `/mock/state`.
- Do not mutate the committed example scenario — copy it to `/tmp/` first.
- Do not assume the example webhook target port is correct. The sandbox API runs on 3001.
- Do not hand-roll webhook signatures in test drivers — deliver through `/mock/events` so the svix-id bookkeeping (and duplicate semantics) stays correct.
- Do not claim duplicate handling is covered unless you observed the second delivery being dropped (exactly one task/reply) in `/mock/state` and the app's own state.

## Output Standard

End each use of this skill with:

- the scenario used and the webhook target
- the inbound emails injected (if any), including flags (`duplicate`, `oversize`, `autoSubmitted`)
- the key outbound messages, webhook registrations, or delivery statuses observed in `/mock/state`
- a pass or fail judgment
- the next debugging lead if the behavior failed
