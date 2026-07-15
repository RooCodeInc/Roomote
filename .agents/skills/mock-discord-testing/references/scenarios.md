# Discord User-Journey Scenario Catalog

Each scenario lists the envelopes to inject, the expected observable behavior, and where to assert it. "State" means `GET http://127.0.0.1:3014/mock/state`; "DB" means the tasks/task_runs tables. Outbound bot messages appear in state `.messages`; threads and forum posts the bot creates appear in state `.channels`.

The core product invariant under test is: **each task owns one thread (or forum post)**, continuity comes from the active-run lookup on the thread, and root-channel messages only enter when the bot is @mentioned (DMs always enter).

## 1. dm-fast-answer

A linked user DMs `!fast <question>`.

- Inject: `message` in a DM channel (type 1), text `!fast what file handles Discord events?`.
- Expect: eyes reaction on the inbound message; one inline bot answer in the same channel; **no** cloud job created.
- Assert: state `.messages` (one bot message), `.reactions`; DB has no new task row.

## 2. dm-task-entry

A linked user DMs a work request.

- Inject: `message` in a DM channel, text `fix the flaky login test in apps/web`.
- Expect: eyes ack; a task-started reply with a follow-task link and a cancel button (`discord:cancel:<runId>`); a new task whose run payload carries `communicationProvider: 'discord'` and `communicationChannelId` of the DM channel.
- Assert: state (started message with `components`); DB payload fields.

## 3. guild-mention-task-entry

A linked user @mentions the bot in a guild root channel.

- Inject: `message` in the seeded guild text channel with `<@100000000000000001>` in content and the bot in `mentions`.
- Expect: Roomote creates a task thread (or forum post in forum channels) named after the request, posts the starter/ack there, and the run payload carries `communicationThreadId` + `discordTaskThread: true`.
- Assert: state `.channels` gains a thread child of the root channel; started message lives in the thread.

## 4. followup-in-task-thread (the continuity core case)

A second message arrives in the task thread while the run is active.

- Inject: scenario 3, then another `message` whose `channel_id` is the created thread id (no mention needed).
- Expect: the follow-up is **queued to the running job**, acked with eyes — no second task-started reply, no second task.
- Assert: state shows the reaction on the follow-up but no new task-start message; DB still has one active run for the thread.
- Regression risk: if the task-thread lookup breaks, every follow-up silently launches a parallel task — the worst UX failure this surface has.

## 5. slash-new-command

`/new request:<...>` forces a fresh task instead of a snapshot resume.

- Inject: `interaction` (type 2, `data.name: "new"`, options `[{name: "request", type: 3, value: "upgrade the login tests"}]`).
- Expect: the deferred interaction is edited with a task-started response; a fresh task launches even when a completed task in the conversation has a resumable snapshot.
- Assert: state `.requests` shows the `@original` webhook edit; DB has a new task id.

## 6. slash-link-dm-only

`/link code:<...>` is refused outside DMs and links inside a DM.

- Inject: `interaction` with `data.name: "link"` in a guild channel → expect an ephemeral refusal and the code preserved. Then the same in a DM with a valid code from the web UI → expect the mapping row to appear.
- Assert: DB `discord_user_mappings`; state interaction responses.

## 7. unlinked-sender

Task entry from an unmapped Discord user.

- Inject: `message` task entry whose `author.id` has no `discord_user_mappings` row.
- Expect: a "link your account" reply; nothing queued, no task.
- Assert: state `.messages` (nudge only); DB unchanged.

## 8. duplicate-delivery

Same durable envelope twice → exactly-once handling.

- Inject: the same `message` envelope twice with an explicit shared `eventId`.
- Expect: the first returns 200 and processes; the second returns 409 duplicate and nothing double-posts.
- Assert: dispatch results printed by `/mock/events`; state shows a single task-start reply.

## 9. long-reply-chunking

A worker reply over 2000 characters splits into multiple Discord messages.

- Drive: run a task that produces a long reply (or exercise `postMessage` directly with long markdown).
- Expect: multiple sequential messages in the thread, split on line/word boundaries, none exceeding 2000 chars.
- Assert: state `.messages` lengths.

## 10. cancel-button

A component interaction cancels the running job.

- Inject: `interaction` (type 3, `data.custom_id: "discord:cancel:<runId>"`, `component_type: 2`) from the task owner.
- Expect: the run stops; the interaction response (or channel post fallback) confirms cancellation.
- Assert: DB run status; state interaction/webhook requests.

## 11. routing-confirmation

A low-confidence route posts a workspace picker.

- Drive: task entry whose routing confidence is below 0.95 with multiple workspaces configured.
- Expect: workspace-choice buttons (`discord:route:<id>:<n|cancel>`); picking one launches into that workspace; only the requester can pick.
- Assert: state components on the routing message; DB task's repository after choosing.
