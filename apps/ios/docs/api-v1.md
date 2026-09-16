# Roomote JSON API v1 (mobile contract)

Base URL: the deployment's app URL (`R_APP_URL`), for example `https://roo.roomote.ai`.
All endpoints below are relative to it. Responses are plain JSON: ISO-8601 strings
for dates, numbers for epoch-millisecond `ts` fields, `null` for absent values.
There is no superjson envelope. Numeric timestamps are epoch milliseconds
except Session/task `activityAt`, which is epoch seconds (the Swift decoder
treats values below 1e11 as seconds).

Every `/api/v1/*` request needs `Authorization: Bearer <session token>`.
Errors are `{ "error": "<message>" }` with a 4xx/5xx status.

The handlers call the same command functions the web tRPC routers call, so the
object shapes are the tRPC procedure outputs serialized as JSON. Field lists
below are the subset the iOS app relies on; other fields may be present.

## Auth

### Native email/password sign-in

```
POST /api/auth/sign-in/email
Content-Type: application/json
{ "email": "...", "password": "..." }
```

The response carries a `set-auth-token` header. Store that value in the Keychain and
send it as the bearer token. It is a 30-day sliding session; the server renews it on
use. Sign out with `POST /api/auth/sign-out` (bearer).

### Browser sign-in handoff (Slack, Microsoft, any provider)

1. Open `GET /api/auth/mobile-handoff?redirect=roomote%3A%2F%2Fauth` in
   `ASWebAuthenticationSession` with callback scheme `roomote`.
2. If the browser session is not signed in, the web app shows its normal sign-in and
   comes back to the same URL afterwards.
3. Once signed in, the route stores the browser's session token under a one-time
   code (60 s TTL) and redirects to `roomote://auth?code=<code>`.
4. Exchange it, no auth header needed:

```
POST /api/v1/auth/exchange
{ "code": "<code>" }
→ { "token": "<session token>" }
```

## Me

```
GET /api/v1/me
→ {
  "user": { "id", "name", "email", "imageUrl", "isAdmin": bool },
  "deployment": {
    "appUrl": string,
    "features": { "voice": bool, "push": bool }
  }
}
```

## Inbox

Everything waiting on a human across Sessions the caller can read.

```
GET /api/v1/inbox
→ { "items": InboxItem[] }

InboxItem = {
  "id": string,                         // stable per item, e.g. "user_input:<requestId>"
  "kind": "user_input" | "capability_offer",
  "sessionId": string | null,           // unified session id (for /sessions/:id)
  "fastConversationId": string,         // for the SSE stream
  "sessionTitle": string,
  "createdAt": string,
  "request": {                          // kind == user_input
    "requestId": string,
    "questions": Question[]
  } | null,
  "offer": {                            // kind == capability_offer
    "offerId": string,
    "capability": string,
    "message": string
  } | null
}

Question = {
  "id": string, "header": string, "question": string,
  "isOther": bool, "isSecret": bool, "multiple": bool | null,
  "options": [{ "id": string | null, "label": string, "description": string }] | null
}
```

## Sessions

```
GET /api/v1/sessions?scope=all|tasks|reviews|automations&status=&q=&before=<cursor>&limit=50
→ { "sessions": Session[], "nextCursor": string | null }

Session = {
  "id": string,                  // unified session id
  "fastConversationId": string | null,
  "title": string | null,
  "ownerName": string | null, "ownerImageUrl": string | null,
  "sourceSurface": string, "sourceTrigger": string | null,
  "activityAt": number /* epoch seconds */, "createdAt": string,
  "cachedStatus": string | null,
  "respondingUntil": string | null,
  "archivedAt": string | null,
  "unread": bool,
  "pinned": bool,
  "tasks": [{ "taskId", "title", "state", "repositoryName", "workflow" }],
  "pullRequests": [{ "url", "number", "repository", "status" }]
}

GET /api/v1/sessions/:id                 → Session (with the same fields)
GET /api/v1/sessions/:id/messages        → {
  "sessionId": string,                   // fast conversation id
  "title": string | null,
  "model": string | null,
  "messages": Message[],
  "hasOlderMessages": bool
}

Message = {
  "id": string, "eventId": string, "turnId": string, "turnSeq": number,
  "ts": number,                          // epoch ms
  "eventType": string,                   // see ACP event types below
  "role": "user" | "assistant" | "tool" | null,
  "contentBlocks": [{ "type": "text", "text": string } | { "type": "image", ... }] | null,
  "payload": object | null,              // request_user_input, capability_offer, tool calls
  "userName": string | null, "userImageUrl": string | null,
  "createdAt": string
}
```

`:id` accepts either the unified session id or the fast conversation id.

ACP event types the app renders (everything else is collapsed into a tool row):

- `roomote_runtime.user_prompt` — text from `contentBlocks`
- `roomote_runtime.assistant_message` — text from `contentBlocks`
- `roomote_runtime.request_user_input` — `payload` = `{ requestId, status, questions }`
- `roomote_runtime.request_user_input_response` — `payload.requestId` marks the request answered
- `roomote_runtime.capability_offer` / `..._response` — same pattern with `offerId`
- `roomote_runtime.tool_call`, `tool_call_update`, `tool_result` — collapsed
- `roomote_runtime.task_cancelled`

### Writing to a Session

```
POST /api/v1/sessions
{ "text": string, "model"?: string, "images"?: [dataUrl] }
→ 201 { "sessionId": string /* fast conversation id */, "unifiedSessionId"?: string }

POST /api/v1/sessions/:id/reply
{ "text": string, "clientMessageId"?: string, "images"?: [dataUrl] }
→ { "success": true }

POST /api/v1/sessions/:id/answer
{ "requestId": string, "answers": { [questionId]: { "answers": string[] } },
  "resolution"?: "submitted" | "cancelled" }
→ { "success": true }

POST /api/v1/sessions/:id/capability-offer
{ "offerId": string, "capability": string, "resolution": "completed" | "dismissed",
  "selectedIds"?: string[] }
→ { "success": true }

POST /api/v1/sessions/:id/read
→ { "success": true }
```

### Live stream (existing route)

```
GET /api/sessions/<fastConversationId>/stream?since=<epoch ms>
Accept: text/event-stream
```

SSE events:

- `messages` — `{ "messages": Message[], "conversationResponding": bool | null }`;
  upsert by `id`.
- `session` — `{ "title"?, "conversationResponding"?, "goal"? }`
- `chunk` — `{ "event": Message-like }` where `event.eventType` is
  `roomote_runtime.assistant_message_chunk`, `event.contentBlocks[0].text` (also
  `event.text`) is a **delta** to append, and `event.id` is the `eventId` of the
  persisted assistant message that will replace the streamed text. Key the live
  bubble by `event.id`; when a `messages` event arrives with a message whose
  `eventId` equals that id, replace the streamed text with the persisted row.
- `disconnect` — reconnect with the last cursor.

The server closes the stream after 60 minutes; reconnect with `since`.

## Tasks

```
GET /api/v1/tasks?limit=50&cursor=<cursor>&user=me|all
→ { "tasks": Task[], "nextCursor": string | number | null }

Task = {
  "id": string, "title": string | null, "workflow": string,
  "state": string,                       // pending | active | completed | failed | cancelled ...
  "repositoryName": string | null,
  "activityAt": number /* epoch seconds */, "createdAt": string | null,
  "model": string | null,
  "taskRun": {
    "id": number, "status": string, "taskPhase": string | null,
    "error": string | null,
    "pullRequests": [{ "prUrl", "prNumber", "repository", "status" }] | null
  } | null
}

GET /api/v1/tasks/:id               → Task with "artifacts": Artifact[]
GET /api/v1/tasks/:id/transcript?cursor=<json-encoded nextCursor>
                                    → { "messages": Envelope[], "nextCursor": object | null }
                                       (newest page first; pass nextCursor for older)
GET /api/v1/tasks/:id/stream?since=<epoch ms>
                                    → SSE: `messages` = { "messages": Envelope[] },
                                       `task` = { "state", "title", "latestRun": { id, status, phase } | null },
                                       `disconnect`

Envelope = { "id", "ts": number, "createdAt": number /* epoch ms */, "eventType", "role",
             "contentBlocks", "payload", "metadata", "userName", "userImageUrl" }

Artifact = { "id", "artifactType": "general"|"plan"|"visual-proof", "path", "contentType",
             "size": number, "createdAt": string,
             "url": string /* path relative to the deployment, HMAC-signed, valid ~1h;
                              only allowlisted content types (images, video, text) are served */ }

POST /api/v1/tasks/:id/steer   { "prompt": string, "images"?: [dataUrl], "clientMessageId"?: string } → { "success": true }
POST /api/v1/tasks/:id/answer  { "requestId", "answers" }                   → { "success": true }
POST /api/v1/tasks/:id/cancel  { "terminate"?: bool }                       → { "success": true }
```

## Devices (push)

```
PUT /api/v1/devices/:token
{ "platform": "ios", "environment": "production" | "sandbox",
  "bundleId": string, "appVersion": string, "deviceName": string,
  "categories"?: { "user_input": bool, "capability_offer": bool,
                   "task_settled": bool, "reply": bool } }
→ { "success": true }

DELETE /api/v1/devices/:token → { "success": true }
```

## Push payloads

APNs `aps` alert with `category` and a `data` object:

```
{
  "aps": { "alert": { "title", "body" }, "category": "USER_INPUT" | "CAPABILITY_OFFER" | "TASK_SETTLED" | "REPLY",
           "thread-id": "<sessionId>", "mutable-content": 1, "sound": "default" },
  "data": {
    "kind": "user_input" | "capability_offer" | "task_settled" | "reply",
    "sessionId": string | null, "fastConversationId": string | null,
    "taskId": string | null,
    "requestId"?: string, "offerId"?: string, "capability"?: string,
    "url": "roomote://sessions/<id>" | "roomote://tasks/<id>"
  }
}
```

Notification categories and actions:

- `USER_INPUT`: `REPLY` (text input) → `POST /sessions/:id/answer` with the single
  free-text question, or `OPEN`.
- `CAPABILITY_OFFER`: `APPROVE` → resolution `completed`; `DECLINE` → `dismissed`.
- `TASK_SETTLED`, `REPLY`: open only.

## Deep links

- `roomote://sessions/<unified session id>`
- `roomote://tasks/<task id>`
- `roomote://auth?code=...` (handoff)

Universal links: `https://<deployment host>/sessions/<id>` and `/task/<id>` map to
the same screens when the build's associated domain matches.
