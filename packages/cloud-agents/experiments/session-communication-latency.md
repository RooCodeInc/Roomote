# Session Communication Latency Experiment

Generated: 2026-09-22T17:02:25.181Z
Git revision: 8e7db7e6fbf038bf646278b56c477131130d81af

## Status

**Eligible paired platform comparison.** Both arms used fresh real web Sessions, durable parent-event admission, the same synthetic task-report scenarios, and persisted Session-visible outcomes. Explicit human steering was not sent through either model arm; it remains a deterministic path and is covered by the focused harness test.

## Production Trace

- Task reports enter `reportToParentSession` / `enqueueFastAgentParentEvent`, are persisted before BullMQ wakeup, and are delivered by the Fast parent event worker.
- The regular arm calls the existing `answerFastAgentQuestion` path. Worker diagnostics provide OpenCode setup, inference, and action timing.
- The Jev arm is active only when the event carries `communicationExperiment: "jev"`; it uses the existing control-plane judgment resolver with an explicit OpenRouter selection override, then persists the assistant result through the same web Session transcript path.

## Methodology

- Scenarios: important_milestone, blocked_user_input, routine_redundant_progress, completion_adequate_evidence; repetitions per arm/scenario: 2.
- Each sample uses a fresh Session to avoid warm transcript contamination. Pair order is regular LLM, then Jev.
- `eventToAction` is durable event admission to the parent event row delivery completion. `inference` and `orchestration` come from the regular Fast diagnostics or Jev experiment diagnostics.
- The Jev branch is opt-in per event and does not affect ordinary task reports or human steering.
- p50/p95 use linear interpolation over valid completed samples; no failed sample is included in aggregates or the recommendation.

## Aggregate Results

| Mechanism | Accuracy | Event-to-action p50 / p95 | Inference p50 / p95 | Orchestration p50 / p95 | Samples |
| --- | ---: | --- | --- | --- | ---: |
| regular-llm | 100.0% | p50 4072.5 / p95 10771.8 ms (n=8) | p50 3908.5 / p95 10610.1 ms (n=8) | p50 94.0 / p95 106.0 ms (n=8) | 8 |
| jev | 100.0% | p50 316.5 / p95 389.6 ms (n=8) | p50 297.3 / p95 367.3 ms (n=8) | p50 6.2 / p95 9.2 ms (n=8) | 8 |

## Decision Correctness

| Mechanism | Scenario | Expected | Actions observed | Accuracy |
| --- | --- | --- | --- | ---: |
| regular-llm | important_milestone | report | report x2 | 100.0% |
| regular-llm | blocked_user_input | request_input | request_input x2 | 100.0% |
| regular-llm | routine_redundant_progress | quiet | quiet x2 | 100.0% |
| regular-llm | completion_adequate_evidence | report | report x2 | 100.0% |
| jev | important_milestone | report | report x2 | 100.0% |
| jev | blocked_user_input | request_input | request_input x2 | 100.0% |
| jev | routine_redundant_progress | quiet | quiet x2 | 100.0% |
| jev | completion_adequate_evidence | report | report x2 | 100.0% |

## Raw Samples

| Rep | Arm | Scenario | Status | Actual | Correct | Event-to-action ms | Inference ms | Orchestration ms |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: |
| 1 | regular-llm | important_milestone | completed | report | yes | 3840.0 | 3659.0 | 107.0 |
| 1 | jev | important_milestone | completed | report | yes | 328.0 | 303.6 | 6.2 |
| 1 | regular-llm | blocked_user_input | completed | request_input | yes | 5538.0 | 5386.0 | 95.0 |
| 1 | jev | blocked_user_input | completed | request_input | yes | 284.0 | 266.1 | 6.0 |
| 1 | regular-llm | routine_redundant_progress | completed | quiet | yes | 3292.0 | 3198.0 | 50.0 |
| 1 | jev | routine_redundant_progress | completed | quiet | yes | 261.0 | 246.2 | 0.9 |
| 1 | regular-llm | completion_adequate_evidence | completed | report | yes | 11407.0 | 11237.0 | 104.0 |
| 1 | jev | completion_adequate_evidence | completed | report | yes | 337.0 | 315.3 | 7.1 |
| 2 | regular-llm | important_milestone | completed | report | yes | 4305.0 | 4158.0 | 102.0 |
| 2 | jev | important_milestone | completed | report | yes | 413.0 | 389.6 | 9.5 |
| 2 | regular-llm | blocked_user_input | completed | request_input | yes | 3464.0 | 3323.0 | 88.0 |
| 2 | jev | blocked_user_input | completed | request_input | yes | 248.0 | 229.7 | 6.1 |
| 2 | regular-llm | routine_redundant_progress | completed | quiet | yes | 3443.0 | 3340.0 | 51.0 |
| 2 | jev | routine_redundant_progress | completed | quiet | yes | 305.0 | 291.0 | 0.8 |
| 2 | regular-llm | completion_adequate_evidence | completed | report | yes | 9592.0 | 9446.0 | 93.0 |
| 2 | jev | completion_adequate_evidence | completed | report | yes | 346.0 | 325.9 | 8.6 |

## Recommendation

**No-go for production action control.** The platform comparison is valid and shows a Jev latency candidate, but the Jev branch is still an opt-in experiment and has not been validated on the full inspection/steering surface or real production traffic. Keep deterministic lifecycle, permissions, cancellation, queueing, and human steering outside Jev.

## Reproduction

```bash
pnpm exec dotenvx run --quiet -f .env.local -- pnpm --filter @roomote/cloud-agents benchmark:session-communication-latency -- --reps 2 --bullmq-log /tmp/roomote-bullmq.log --output experiments/session-communication-latency.json
```
