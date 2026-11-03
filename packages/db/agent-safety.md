# Agent safety admission and operational limits

The task row is the durable admission authority. `inference_request_limit`
defaults to 1,000; `inference_requests` counts admitted attempts, not successful
responses or accounting events. `safety_stopped_at` and `safety_stop_reason`
are an irreversible application-level latch for the task. No resume, new run,
provider fallback, or ordinary message clears these fields. There is no UI or
public API to grant more allowance in this release; explicit continuation is a
new task after inspecting the retained work. Operators should not clear a latch
while an old runtime is alive.

## Admission guarantees

- PostgreSQL transactions serialize admissions on the task row, across API
  processes, concurrent children, helper calls, retries, and resumed runs.
- Every allowed inference-gateway POST reserves one request before upstream
  fetch, including retries, Jevgrep evaluations, and POST token-count endpoints.
  GET model/catalog metadata does not consume allowance. Failed attempts are
  not refunded. Failure to read/write admission state fails closed.
- Task-associated SDK OpenCode helpers receive a dedicated gateway-backed
  lease. Their internal model steps and retries therefore use the same task
  counter, rather than one reservation per helper prompt. An unsupported
  gateway provider fails closed. Typed decision calls with task context also
  reserve before direct dispatch (including optional shadow evaluations).
- A rejected admission beyond the ceiling atomically latches the task and
  inserts a task notice plus an owning-session notice, if present. Worker pass
  limits call the same durable stop mutation. Concurrent/late stop events do
  not insert another notice. These history rows need no LLM, Redis job, or
  outbound chat success. Existing open views may need refresh. Standalone chat
  delivery uses the existing terminal-error notification path, best effort.
- Admission is not a dollar budget. Existing post-response usage records are
  unchanged and are not reservations. No price or usage data is required to
  enforce the request count; in-flight admitted requests may still be billed.

## Pass guarantees

The worker and control-plane OpenCode prompt runner share `AgentSafetyPass`.
SHA-256 hashes cover tool name, recursively key-sorted arguments, and terminal
result/error. Only hashes and unique invocation/step IDs are retained by the
guard; arguments and results are not written to safety logs/notices. Five
consecutive identical completed invocations stop a pass, including empty
results. Changed arguments/results reset that streak. Duplicate/out-of-order
updates for the same invocation are ignored. The exact read-only
`manage_tasks`/`roomote_manage_tasks` action `get_updates` gets 20 identical
completions; it is not an unlimited polling exception.

Each live child gets its own 100 unique assistant-message starts, 200 unique
terminal tool completions, and 20-minute wall deadline, independent of progress
and siblings. A pending task-tool spawn is time-bounded even before its child ID
arrives. The worker checks wall deadlines every second. Root tool completions
are guarded too. Control-plane prompts retain their normal shorter deadlines
(120 seconds by default); `timeoutMs: null` and larger timeouts cannot disable
the 20-minute maximum. Their root prompt and recursive children are guarded.

A pass breach stops the **whole task**, retains partial work, clears local
retry/fallback queues, aborts the root and discovered descendants with bounded
abort requests, emits the terminal task event to release worker/parent waits,
and refuses late local commands/events. This intentionally does not let the
parent spawn a replacement pass. The durable task latch refuses all subsequent
managed provider dispatch even if the worker restarts. The existing parent
settle/error relays do not wake parent inference for a safety-stopped task.

## Boundaries to keep in mind

- Tool/step detection observes OpenCode events, not a synchronous upstream tool
  interceptor. Work or requests already in flight when the fifth completion is
  observed may finish. Missing events degrade detection to wall/request limits.
- Pass clocks/fingerprints are in-memory and restart with a runtime; the task
  request counter and stop latch survive runtime/API restart and resume. Old
  tasks begin counting after this additive migration; historical provider calls
  cannot be reconstructed as admissions.
- If the stop mutation cannot reach the API/database, the worker still stops
  locally; durable notices/latching cannot be promised during that outage. The
  gateway independently fails closed while its database is unavailable, and
  its lifetime request ceiling still applies after recovery.
- Independent session orchestration without task context is outside a task's
  lifetime counter (its prompt passes still have finite guards). User scripts,
  arbitrary integration tools, external MCP servers, and independently billed
  services are not an inference egress firewall. These bounds do not replace
  provider-side financial limits.
- Rollback is additive/N-1 safe. Rolling application code back removes these
  enforcement checks; the four columns remain readable by the newer release.
