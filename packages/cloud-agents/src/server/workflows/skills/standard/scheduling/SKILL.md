---
name: scheduling
description: Schedule, inspect, edit, run, or cancel conversation reminders, bounded checks, and deployment custom automations after discovering their current schemas.
---

# Scheduling

Use this guide after scheduling capability discovery. Loading it supplies guidance only: it does not expose a tool, grant authorization, confirm a proposed change, or permit a side effect.

## Choose The Schedule Type

- Use `manage_wakeups` for reminders, delayed follow-ups, and recurring checks that return to the current conversation with its history in context.
- Use `roomote_manage_custom_automations` for recurring work outside the current conversation or reports sent to a configured channel or direct message.
- Discover the scheduling capability before each scheduling workflow and use only the returned tool names and input schemas. Do not guess fields from this guide.

## Conversation Wakeups

- An explicit request to remind or monitor authorizes creating the requested wakeup. A proactive monitoring offer does not: create nothing until the user accepts.
- Before creating a monitor, list active wakeups and reuse an equivalent one. Duplicate prompt and schedule pairs are also deduplicated by the service.
- Reminders may be one-shot. Ongoing-process monitors must always be finite: use a one-shot or a recurring schedule with `x<count>` or `until <ISO 8601>`, choose a cadence that matches how quickly the evidence can change, and use `only_when_notable` unless every report was requested.
- Stop a monitor at its agreed bound without renewal, or earlier when the condition resolves, becomes irrelevant, loses its evidence source, or the user cancels. Missing evidence and reaching the bound are not success.
- Delivery is best effort. Never poll, sleep, or wait inside a turn, and never promise exact delivery timing.
- For list and get requests, report the returned state. When the user asks to stop, remove, delete, or end a wakeup, call `manage_wakeups` with `cancel`; there is no pause. After creation or cancellation, confirm the returned state concisely.

## Deployment Automations

- The current user's deployment authorization applies. Members may manage their own custom automations; admins may manage all custom automations. Built-in automations and deployment settings remain admin-only. Reading this guide does not widen those permissions.
- List before changing an existing automation. Use `inspect` when its stored prompt is needed, `resolve_schedule` before create or schedule updates, and ask the resolver's clarification instead of guessing an ambiguous schedule.
- Before create, update, enable, disable, or delete, present the complete proposed name, work prompt, schedule, destination, and execution environment, then obtain explicit confirmation. Delete only on an explicit delete request.
- Keep cadence only in `schedule`, not in the work prompt. Use `list_models` before selecting an exact model override. Use an `enabled` update to enable or disable and `run_now` to test an enabled automation.
- A `run_now` result of `queued` means started or queued, never completed. After creating an automation, ask whether the user wants to run it now.
- When an automation should create launchable suggested tasks, encode that intent in product language only when it has both a chat report destination and an executable workspace. Otherwise keep actions in report text.

## Scheduled Events

- Automation and wakeup platform events are already authorized continuations, not new human requests. Execute only the saved prompt and use scheduling tools only when its lifecycle requires inspection or cancellation.
- A repeating wakeup with no notable change stays silent under `only_when_notable`. On resolution, cancel an active wakeup and report the result; a final run with no next run needs no cancellation.
