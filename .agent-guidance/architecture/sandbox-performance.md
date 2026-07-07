---
title: Sandbox Task Performance Debugging
status: active
last_reviewed: 2026-05-14
owner: engineering
summary: React performance investigation findings for the sandbox task view, covering idle rerender reduction and subscription optimization.
---

# Sandbox Task Performance Debugging

This note captures how the sandbox task view was instrumented during a React performance investigation, what problems showed up, and which fixes actually mattered. The temporary profiler implementation was removed after the investigation, but the findings are worth keeping because the same failure modes are easy to reintroduce.

The scope here is the interactive task page under `apps/web/src/app/(sandbox)/task/[taskId]`, especially the live conversation view and the bottom sandbox panel.

## Why This Was Investigated

The original symptom was poor scroll and update performance when the task page had a large message history. The main concern was React rerender churn while:

- messages streamed in
- the keepalive countdown ticked
- the sandbox panel and sidebar sat idle in the background

The goal was to reduce idle rerenders first, then make future list optimizations easier to measure.

## Temporary Instrumentation Approach

The investigation temporarily introduced a file named `TaskPerformance.tsx` next to the task page components. That file is intentionally no longer in the tree.

It provided two things:

1. React `Profiler` boundaries around major subtrees such as:
   - task layout
   - header
   - messages
   - prompt input
   - sidebar actions
   - sandbox panel layout
2. A render-trace helper that logged when `LiveContent` rerendered and which tracked values changed.

The temporary instrumentation surfaced commit counts and durations, but it also introduced one important lesson:

- instrumentation can distort the tree you are trying to measure if its state lives too high in the component hierarchy

That happened here and had to be corrected before the profiler output became trustworthy.

## Main Problems That Showed Up

## 1. The Profiler Itself Caused Parent Rerenders

The first implementation stored profiler snapshot state inside `LiveContent`. That meant the HUD updates caused `LiveContent` to rerender even when task data had not changed.

Symptoms:

- profiler output showed `task-header` and `task-layout` committing frequently
- render trace reported rerenders with no meaningful input changes

Fix:

- move profiler snapshot state into an external store
- let the HUD subscribe with `useSyncExternalStore`
- keep measurement state out of the tree being measured

Takeaway:

- if you instrument React rendering, keep the instrumentation state outside the measured subtree whenever possible

## 2. The Worker Streamed a 1 Hz Countdown Into Global State

The worker task status stream used to send a per-second idle countdown. That created unnecessary network traffic, store writes, and rerender pressure.

Symptoms:

- `waiting_for_prompt` tasks kept waking the UI every second
- broad subscribers to sandbox task status rerendered even though nothing semantically changed

Fix:

- stop the worker-side 1 second status emission loop
- keep the wire format as a relative sleep deadline (`sleepRemainingMs`) instead of ticking timestamps through shared state
- convert that into an absolute `sleepExpiresAt` deadline on receipt in the client store
- show a coarse "Xm to sleep" label in `TaskStatus` when fresh runtime state arrives
- schedule sleep invalidation locally from the sleep expiry timestamp
- piggyback the latest normalized `taskStatus` onto live `roomote_runtime.usage_update` events so the task UI can refresh status opportunistically without reintroducing a countdown ticker
- keep queued Roomote runtime follow-up turns in an active task phase after an aborted or completed turn so opportunistic `usage_update` refreshes do not regress back to a misleading idle status mid-run

Key files:

| File                                                                       | Purpose                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/worker/src/sandbox-server/procedures/taskStatusStream.ts`            | Worker subscription that now emits stable task status without a countdown tick loop |
| `apps/web/src/app/(sandbox)/task/[taskId]/hooks/use-sandbox-store.ts`      | Converts `sleepRemainingMs` → `sleepExpiresAt` at the store boundary                |
| `apps/web/src/app/(sandbox)/task/[taskId]/prompt-input/TaskStatus.tsx`     | Displays the coarse sleep deadline without local ticking                            |
| `apps/web/src/app/(sandbox)/task/[taskId]/hooks/use-sleep-invalidation.ts` | Schedules a local one-shot invalidation at sleep expiry                             |

Takeaway:

- do not stream UI countdown ticks through shared app state unless the whole app truly needs them

## 3. Broad `useSandbox()` Subscriptions Leaked Into `LiveContent`

Several hooks and components inside the task page were using `useSandbox()`, which returns a relatively broad slice including `taskStatus`.

Symptoms:

- `LiveContent` rerendered from status changes it did not actually need
- parent components rerendered because helper hooks subscribed to more state than their callers used

Fixes:

- introduce narrower selectors such as:
  - `useSandboxClient()`
  - `useSandboxConnected()`
  - `useSandboxTaskPhase()`
  - `useSandboxKeepaliveExpiresAt()`
- update hooks that only needed the client to stop subscribing to all task status fields
- move `useSleepInvalidation()` into a null child component so its subscription does not live on `LiveContent`

Important files:

| File                                                                      | Purpose                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/web/src/app/(sandbox)/task/[taskId]/hooks/SandboxProvider.tsx`      | Source of sandbox selectors; this is where broad vs narrow subscriptions matter |
| `apps/web/src/app/(sandbox)/task/[taskId]/hooks/use-runtime-log-files.ts` | Switched to a narrower client-only subscription                                 |
| `apps/web/src/app/(sandbox)/task/[taskId]/hooks/use-diff-view.ts`         | Also narrowed to avoid unrelated task-status wakeups                            |
| `apps/web/src/app/(sandbox)/task/[taskId]/LiveContent.tsx`                | Main live task component where parent churn had to be reduced                   |

Takeaway:

- in this codepath, a helper hook using `useSandbox()` can easily be more expensive than the caller expects

## 4. Prompt Countdown Work Belonged in the Status Leaf, Not the Whole Composer

Originally the prompt subtree was doing more countdown-related work than necessary.

Fix:

- `PromptInput` now depends on stable task state such as connection and phase
- `TaskStatus` owns the visible countdown leaf and the local ticking logic

This reduced prompt-input commit cost significantly during idle countdown periods.

Takeaway:

- timer-driven UI should live at the smallest possible leaf

## 5. Page Query Churn Still Reached `LiveContent`

Even after subscription cleanup, the page-level session query could still hand a fresh `session` object to the live view.

Fix:

- keep a memoized `LiveContent` export so page/query wrapper churn does not automatically rerender the entire task view when the meaningful `session` fields are unchanged

Relevant file:

| File                                                | Purpose                                |
| --------------------------------------------------- | -------------------------------------- |
| `apps/web/src/app/(sandbox)/task/[taskId]/page.tsx` | Renders the memoized live task content |

Takeaway:

- page queries and wrapper objects can still trigger rerenders even after store subscription cleanup

## 6. Sidebar Work Was More Expensive Than Expected

Once the main task view was quieter, the sidebar became visible in profiling.

Issues that mattered:

- `FinishTaskButton` used a broad sandbox subscription
- `TaskInfoDialog` was mounted even while closed, which meant summary-related work lived in the sidebar tree all the time
- sidebar leaf buttons were not memoized
- the sandbox layout context value was recreated unnecessarily

Fixes:

- narrow `FinishTaskButton` to `useSandboxClient()` and `useSandboxTaskPhase()`
- mount `TaskInfoDialog` only while open
- memoize the sidebar shell and stable leaf buttons
- memoize the `SandboxLayoutContext` provider value

Relevant files:

| File                                                                            | Purpose                                                  |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `apps/web/src/app/(sandbox)/SandboxShell.tsx`                                   | Memoizes the layout context value for sidebar visibility |
| `apps/web/src/app/(sandbox)/task/[taskId]/sidebar-actions/SidebarActions.tsx`   | Sidebar shell, now memoized                              |
| `apps/web/src/app/(sandbox)/task/[taskId]/sidebar-actions/FinishTaskButton.tsx` | Narrowed sandbox subscription                            |
| `apps/web/src/app/(sandbox)/task/[taskId]/sidebar-actions/TaskInfoButton.tsx`   | Only mounts task info dialog when open                   |

Takeaway:

- closed dialogs and convenience controls can still dominate idle shell cost if they stay mounted with live hooks

## 7. Hidden Sandbox Panel Work Was Still Running

The last big idle issue came from the bottom sandbox panel. Even when collapsed, the panel still maintained a live multiplexed log-tail subscription.

Symptoms:

- profiler showed the panel/layout shell committing repeatedly even when the main task view was quiet
- once the sidebar and `LiveContent` were cleaned up, the sandbox panel became the obvious remaining hotspot

Fix:

- subscribe to multiplexed tail logs only when the sandbox panel is open
- narrow the tail hook to `useSandboxClient()` rather than the broad sandbox hook

Key files:

| File                                                                          | Purpose                                            |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/web/src/app/(sandbox)/task/[taskId]/panel/SandboxPanel.tsx`             | Only starts log tailing while the panel is open    |
| `apps/web/src/app/(sandbox)/task/[taskId]/hooks/use-multiplexed-tail-logs.ts` | Log-tail hook narrowed to client-only subscription |

Takeaway:

- hidden panels should not keep live subscriptions running unless there is a clear product reason

## What Was Kept

The profiler file itself was removed, but the actual code improvements from the investigation were intentionally kept:

- stable keepalive expiry contract instead of streamed countdown ticks
- narrower sandbox selectors
- memoized live-content boundary
- cheaper prompt status updates
- sidebar cleanup
- collapsed panel subscription shutdown

Those changes improve steady-state behavior even without the instrumentation.

## What Was Removed

The temporary instrumentation file was removed:

- `apps/web/src/app/(sandbox)/task/[taskId]/TaskPerformance.tsx`

The task command palette does not expose a temporary performance toggle, and the
task page does not ship React profiler wrappers or render-trace logging.

## Recommended Future Debugging Approach

If task performance regresses again, reintroduce instrumentation carefully and temporarily.

Recommended order:

1. Start with the React DevTools Profiler.
2. Add narrow selector hooks before adding memoization blindly.
3. If custom instrumentation is needed, keep its state outside the measured subtree.
4. Profile shells separately from content:
   - page/query wrapper
   - live task view
   - sidebar
   - sandbox panel
   - message list
5. Check hidden panels and closed dialogs for background subscriptions.

## Remaining Big Opportunity

This investigation mostly removed idle and incidental rerender noise. The biggest remaining scale improvement for truly large histories is still the message list itself.

The likely next step for very large conversations is:

- window or virtualize `apps/web/src/app/(sandbox)/task/[taskId]/Messages.tsx`

Secondary options:

- split stable history from the actively streaming tail
- add `content-visibility` or stronger containment on message rows if virtualization is not ready yet

## Short Version

The investigation found that the worst React costs were not the obvious message tree first. They were:

- streamed countdown ticks in shared state
- broad sandbox subscriptions
- instrumentation observer effect
- always-mounted sidebar/dialog work
- hidden sandbox panel background subscriptions

Fixing those made the idle task page much quieter and made future message-list optimization work easier to reason about.
