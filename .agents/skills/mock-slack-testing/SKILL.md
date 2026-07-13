---
name: mock-slack-testing
description: Run Roomote Slack integration flows through the existing mock Slack harness instead of a real Slack workspace. Use when testing Slack app mentions, interactive payloads, URL verification, outbound Slack posts, deleted-thread suppression, `reply_to_slack_thread`, `post_to_slack_channel`, `R_SLACK_API_BASE_URL` routing, `/mock/state`, or `/mock/events`.
---

# Mock Slack Testing

Use this skill to exercise Roomote's Slack integration against the checked-in mock Slack harness. Do not invent another fake Slack stack and do not fall back to a real Slack workspace unless the user explicitly asks for that parity test.

## Quick Reference

| What | Value |
|---|---|
| Harness port | `3012` |
| Harness base URL | `http://127.0.0.1:3012` |
| Slack API base for Roomote | `http://127.0.0.1:3012/api/` |
| API webhook endpoint | `http://localhost:3001/api/webhooks/slack` |
| Mock state endpoint | `http://127.0.0.1:3012/mock/state` |
| Mock event replay endpoint | `http://127.0.0.1:3012/mock/events` |
| Example scenario | `packages/slack/scripts/mock-slack.example.json` |
| Signing secret source | `Env.SLACK_SIGNING_SECRET` from dotenvx |

## Step 1: Seed the database

The Slack webhook handler requires a `slack_installations` row matching the mock team ID and a `slack_user_mappings` row linking the mock user to a real local user. Query existing state first, then seed only what's missing:

```bash
# Check existing state
PGPASSWORD=password psql -h localhost -U postgres -d development -c "SELECT id, team_id, organization_id, bot_user_id FROM slack_installations LIMIT 5;"
PGPASSWORD=password psql -h localhost -U postgres -d development -c "SELECT id, slack_user_id, slack_team_id, user_id FROM slack_user_mappings LIMIT 5;"

# Get a valid org and user for seeding
PGPASSWORD=password psql -h localhost -U postgres -d development -c "SELECT id FROM organizations LIMIT 1;"
PGPASSWORD=password psql -h localhost -U postgres -d development -c "SELECT id FROM users LIMIT 1;"
```

Then seed (adjust org_id and user_id from the queries above):

```sql
-- Seed slack installation for mock team TROOMOTE
INSERT INTO slack_installations (organization_id, team_id, team_name, app_id, bot_user_id, bot_token, installed_by_user_id, is_active)
VALUES ('<org_id>', 'TROOMOTE', 'roomote-mock', 'AMOCK', 'BROOMOTE', 'xoxb-mock-token', '<user_id>', true)
ON CONFLICT (team_id) DO NOTHING;

-- Seed user mapping for mock user UGRACE
INSERT INTO slack_user_mappings (slack_user_id, slack_team_id, user_id, organization_id)
VALUES ('UGRACE', 'TROOMOTE', '<user_id>', '<org_id>')
ON CONFLICT ON CONSTRAINT slack_user_mappings_unique DO NOTHING;
```

## Step 2: Create a scenario file

Copy the example and fix the webhook target to point at the sandbox API (port 3001, not 4000):

```bash
cp packages/slack/scripts/mock-slack.example.json /tmp/mock-slack-test.json
sed -i 's|localhost:4000|localhost:3001|g' /tmp/mock-slack-test.json
```

Verify the target is correct:
```bash
cat /tmp/mock-slack-test.json | grep webhookUrl
# Should show: "webhookUrl": "http://localhost:3001/api/webhooks/slack"
```

For custom scenarios, edit `/tmp/mock-slack-test.json` directly. Never mutate the committed example.

## Step 3: Start the harness

```bash
cd /sandbox/repos/Roomote
pnpm --filter @roomote/slack mock:server --state /tmp/mock-slack-test.json
```

The harness will start on port 3012, replay any events in the `replay` array, and keep listening. For one-shot replay that exits after:

```bash
pnpm --filter @roomote/slack mock:server --state /tmp/mock-slack-test.json --exit-after-replay
```

## Step 4: Wire Roomote to the harness (outbound tests only)

When testing flows where Roomote posts back to Slack (thread replies, channel posts), the API server needs to send Slack API calls to the harness instead of real Slack:

```bash
# Set in the API server's environment before it starts, or inject at runtime
R_SLACK_API_BASE_URL=http://127.0.0.1:3012/api/
```

The signing secret is read from `Env.SLACK_SIGNING_SECRET` via dotenvx. The harness uses the same secret by default, so inbound replay signatures will match without extra configuration.

## Step 5: Replay events manually (optional)

If the scenario file doesn't include a `replay` array, or you want to replay additional events after boot:

```bash
# Replay an app_mention
curl -s -X POST http://127.0.0.1:3012/mock/events \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "event_callback",
    "eventId": "evt-manual-1",
    "event": {
      "type": "app_mention",
      "channel": "C123ABC456",
      "user": "UGRACE",
      "text": "<@BROOMOTE> !fast what file handles Slack mentions?",
      "ts": "1710000000.000200",
      "channel_type": "channel"
    }
  }'

# Replay a url_verification handshake
curl -s -X POST http://127.0.0.1:3012/mock/events \
  -H 'Content-Type: application/json' \
  -d '{"kind": "url_verification", "challenge": "test-challenge-123"}'
```

## Step 6: Inspect results

Always check the mock state after replay — do not declare success just because the harness returned 200:

```bash
# Full state dump
curl -s http://127.0.0.1:3012/mock/state | jq .

# Just the messages
curl -s http://127.0.0.1:3012/mock/state | jq '.messages'

# Check if a specific thread reply was recorded
curl -s http://127.0.0.1:3012/mock/state | jq '.messages[] | select(.thread_ts != null)'
```

## Scenario Selection

See `references/scenarios.md` for the full catalog. Common picks:

- **`app-mention-fast`** — `@roomote !fast ...` inline Q&A without a cloud job
- **`app-mention-standard`** — normal Slack task kickoff that creates a cloud job
- **`url-verification`** — webhook handshake validation
- **`outbound-thread-reply`** — worker/API posts back into a Slack thread
- **`deleted-thread-suppression`** — verify replies stop after thread root is deleted

## Guardrails

- Do not create a second mock Slack server. Use the harness in `packages/slack/`.
- Do not use a real Slack workspace unless the user explicitly asks for that.
- Do not declare success because the harness started. Always inspect `/mock/state`.
- Do not mutate the committed example scenario — copy it to `/tmp/` first.
- Do not assume the example webhook target port is correct. The sandbox API runs on 3001.
- Do not claim deleted-thread behavior is covered unless you observed `thread_not_found` in the mock state.

## Output Standard

End each use of this skill with:
- the scenario used and the webhook target
- the inbound event replayed (if any)
- the key messages or thread state observed in `/mock/state`
- a pass or fail judgment
- the next debugging lead if the behavior failed
