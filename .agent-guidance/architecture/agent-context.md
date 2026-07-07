---
title: Roomote Agent Context
status: active
last_reviewed: 2026-07-06
owner: engineering
summary: Current OpenCode server prompt and runtime assembly for Roomote agents, including model env translation, workflow instructions, skills, MCP injection, and Slack hooks.
---

# Roomote Agent Context

Roomote runs tasks through a single coding harness: `opencode-server`. The
worker starts OpenCode with `opencode serve`, writes an owned config under a
task-scoped sandbox home, and translates OpenCode server events into Roomote
runtime task history.

Roomote behavior is still layered. Do not treat the harness as the whole
product contract.

## Runtime Path

Fresh task launch:

1. A producer creates a cloud task from the web app, API, Slack, Linear, GitHub,
   or an MCP launch.
2. `enqueueCloudTask()` defaults the task harness to `opencode-server`.
3. `dequeueCloudJob()` resolves org guidance, tone guidance, job settings, and
   workflow-specific prompt text.
4. Workflow builders return two text surfaces:
   - `prompt`: the first task request sent to OpenCode
   - `harnessInstructions`: workflow policy later written as OpenCode
     instructions
5. `runTask()` merges `harnessInstructions` with formatted
   `<environment-instructions>...</environment-instructions>`.
6. `generateOpenCodeConfig()` writes `~/.config/opencode/opencode.json`,
   generated instruction files, MCP config, Slack hook files, and the local
   Roomote OpenAI proxy provider config under the task-scoped runtime home.
7. `startOpenCodeServerHarness()` starts `opencode serve`, subscribes to server
   events, and normalizes OpenCode messages, tools, questions, and task status
   into Roomote task state.

Snapshot resume does not rerun prompt builders. It reuses the source job's
persisted `harnessInstructions`, restores the saved OpenCode session id when
available, starts with an empty startup prompt, and queues any deferred
follow-up onto the resumed session.

## Transcript Event Identity

OpenCode live events use synthetic transport IDs, while persisted task-message
rows use database IDs. The OpenCode runtime emitter therefore stamps
`logicalEventId` into the top-level event, `metadata`, and `payload` whenever it
has stable source identity. The current format is
`<sessionId>:<turnId-or-no-turn>:<toolCallId-or-no-tool>:<eventType>`.

Web transcript merge code reconciles live events with refreshed database
history by `logicalEventId`, with `clientMessageId` covering optimistic user
prompts (the client cannot know the server's turn id at send time) and
`toolCallId` covering tool-call streams. Streaming chunk events carry
chunk-typed logical ids (`...:assistant_message_chunk`); the web client
canonicalizes them to the consolidated event type via
`canonicalizeAcpLogicalEventId` so a chunk-built live message matches the
persisted final row, which is never re-emitted on the live socket once chunks
streamed. The legacy assistant-text dedupe fallback was removed after all
pre-`logicalEventId` tasks (before 2026-07-01) reached terminal states. Do not
depend on the live `opencode-server:N` IDs matching the later
`task_messages.id` UUID.

## Control Layers

| Layer               | Owner                                                                                               | Delivered as                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| System prompt       | `ROOMOTE_SYSTEM_PROMPT` in `packages/cloud-agents/src/system-prompt.ts`                             | Generated Markdown file referenced by OpenCode `instructions`      |
| Compaction prompt   | `ROOMOTE_COMPACT_PROMPT` in `packages/cloud-agents/src/compact-prompt.ts`                           | Generated instruction content consumed by the runtime              |
| Workflow envelope   | Builders in `packages/cloud-agents/src/server/workflows/`                                           | `harnessInstructions`, merged into generated OpenCode instructions |
| Startup task prompt | `generatePrompt()` and task-specific builders                                                       | Initial OpenCode prompt                                            |
| Skills              | `packages/cloud-agents/src/server/workflows/skills/standard/`, manual skills, and repo-local skills | Runtime skill directory under `$HOME/.agents/skills`               |
| MCP tools           | `resolveBuiltInMcpServers()` plus integration and environment MCP config                            | `mcp` entries in `opencode.json`                                   |

The strict `implement / plan / explain` pathway for normal Generalist work is a
Roomote workflow contract. It is not a separate OpenCode text channel.

## Key Files

| File                                                            | Purpose                                            |
| --------------------------------------------------------------- | -------------------------------------------------- |
| `packages/cloud-agents/src/system-prompt.ts`                    | Global Roomote system prompt                       |
| `packages/cloud-agents/src/compact-prompt.ts`                   | Roomote compaction prompt                          |
| `packages/cloud-agents/src/server/cloud-agent-workflow.ts`      | Prompt-builder dispatch                            |
| `packages/cloud-agents/src/server/workflows/standardTask.ts`    | Generalist workflow envelope and first-hop routing |
| `packages/cloud-agents/src/server/workflows/skills/standard/`   | Shipped standard skill catalog                     |
| `apps/worker/src/run-task/run-task.ts`                          | Worker-side prompt assembly and runtime setup      |
| `apps/worker/src/run-task/agent-home.ts`                        | Skill activation and OpenCode config generation    |
| `apps/worker/src/run-task/create-harness.ts`                    | OpenCode harness startup                           |
| `apps/worker/src/sandbox-server/lib/harnesses/opencode-server/` | OpenCode server adapter                            |
| `apps/worker/src/commands/setup/setup-mcps.ts`                  | Built-in and integration MCP resolution            |

## OpenCode Config

`generateOpenCodeConfig()` materializes the deployment model env vars into an
OpenCode config under the task-scoped sandbox `HOME`. `ROOMOTE_MODEL`
supplies the main task model, and `ROOMOTE_SMALL_MODEL` supplies the small
model used by routing and lightweight server-side calls. `ROOMOTE_VISION_MODEL`
supplies the model for visual information extraction. `ROOMOTE_CODE_REVIEW_MODEL`
overrides the coding model for GitHub PR and GitLab MR initial review and
review-sync tasks when set, falling back to the default coding model when unset
(PR review follow-ups use the default coding model). `ROOMOTE_EXPLORE_MODEL`
optionally overrides the built-in OpenCode `explore` subagent used for
read-only codebase investigation; when unset, explore runs fall back to the
effective coding model for the task. The worker always adds a hidden OpenCode
`judge` subagent for post-implementation compare passes against a plan,
checklist, or explicit requested outcome. That judge uses
`ROOMOTE_CODE_REVIEW_MODEL` when configured and otherwise falls back to the
effective coding model for the run. The judge is intentionally scoped as a
diff-vs-plan completion and sanity check rather than a broad repository review,
and its instructions tell the parent to keep any judge repo reads minimal and
targeted. The worker also always adds a Roomote-owned `architect` primary
agent for plan-mode turns: a read-mostly planning agent whose permission map
denies `edit` as the single hard guard while keeping full bash, webfetch,
subagents, skills, and the complete MCP toolset available.
`ROOMOTE_PLANNING_MODEL` and `ROOMOTE_PLANNING_MODEL_REASONING_EFFORT`
override the architect agent's model and reasoning options when configured;
otherwise architect turns inherit the config's top-level model. See
[Workflow System](./workflow-system.md#plan-mode-enforcement) for the
plan-mode selection and exit-continuation behavior.
When the configured vision model differs
from the effective coding model for the OpenCode run (prompt-level task
override first, otherwise `ROOMOTE_MODEL`), the worker adds a hidden OpenCode
`visual` subagent with that model and writes conditional instructions telling
the parent agent to delegate image, screenshot, chart, diagram, and rendered
document inspection through OpenCode's Task tool. When the vision model is the
same as the effective coding model, no extra visual subagent or delegation
instruction is generated.
For image-bearing prompts submitted while the visual subagent is present, the
OpenCode server harness materializes inline `data:` or raw base64 image payloads
into task-local temp files and appends a targeted parent-agent reminder with
exact `@/tmp/...` file references to pass through the Task tool. OpenCode's Task
tool resolves those `@file` references into child-session file parts, so the
visual subagent receives the image through the normal prompt-part path instead
of relying on attachment inheritance from the parent agent. Non-inline image
strings, such as URLs or filesystem paths, are left as normal prompt image parts
and do not trigger the visual delegation reminder. Materialized temp files stay
available for the active harness lifetime so transcript `@/tmp/...` references
remain usable across follow-up turns and snapshot resumes, then are cleaned up
on harness disposal and terminal error paths.
The worker keeps the packaged-skill source catalog on the worker-owned home,
but each task gets its own runtime home so stale OpenCode auth or config state
from another run does not leak into the active session. The worker then layers
Roomote's task-specific overlay into the generated OpenCode config.

The task overlay includes:

- `share: "disabled"` and `autoupdate: false`
- an allow-all permission map for task execution
- `skills.paths` pointing at `$HOME/.agents/skills`
- generated instruction file paths
- normalized `mcp` entries for built-in, integration, user OAuth, and
  environment MCP servers

Provider selection is encoded in the models.dev-style `provider/model` ids.
Roomote forwards common provider API key env vars plus any keys named in
`ROOMOTE_MODEL_ENV_KEYS` into worker harness env. When `ROOMOTE_MODEL_ENV_KEYS`
is not explicit, Roomote infers provider keys from configured coding, helper,
and vision model ids. Roomote adds the runtime overlay for instructions, MCP
servers, permissions, and skills; non-task helper object calls such as routing
use the OpenCode SDK structured-output path with `ROOMOTE_SMALL_MODEL`, falling
back to `ROOMOTE_MODEL`. SDK structured-output failures surface to the caller so
integration entry points can use their normal fallback UX, such as the Slack
environment picker. Text-only non-task helper calls still use
`opencode run --model`.

OpenRouter variant models (`openrouter/<model>:nitro`, `:free`, `:floor`, ...)
are not catalog model IDs, so OpenCode would reject them with
`ProviderModelNotFoundError`. Both config generators (worker
`generateOpenCodeConfig()` and the host-side OpenCode SDK runtime in
`packages/cloud-agents/src/server/opencode-runtime.ts`) rewrite variant models
in every role — including per-task overrides — to their catalog base model
plus a per-model entry under `provider.openrouter.models.<base>` (helpers in
`packages/types/src/opencode-openrouter-variants.ts`). Routing variants
(`:nitro`, `:floor`) become the exactly-equivalent `provider.sort` request
option in the entry's `options`, leaving catalog cost and limit metadata
intact so OpenCode cost reporting and context management keep working.
Endpoint variants (`:free`, `:extended`, ...) are selectable only by wire ID,
so the entry overrides `id` with the suffixed model; OpenCode then misses its
catalog metadata lookup and reports zero cost and limits for those variants —
an upstream OpenCode limitation. Per-model reasoning options are keyed on the
base model so they land on the same entry. The rewrite redefines the base
model for the whole config: roles configured with the plain base model share
the variant routing, and when roles configure different variants of one base
model the highest-precedence role wins (per-task override first, then the
coding model, then helper roles).

## OpenCode Inference Usage

OpenCode assistant message finalization emits hidden `runtimeInferenceUsage`
events from the message `info.tokens`, provider/model IDs, message timestamps,
and message `cost`. These usage events are not transcript messages.

The worker persists them through `sdk.cloudJobs.recordInferenceUsage`, keyed by
`(harnessSessionId, messageId)`, into `taskInferenceUsageEvents`. Treat those
raw events as the durable accounting source for per-task OpenCode cost and
token totals; the runtime `taskCompleted.totalCost` field is only a completion
event summary. Roomote does not maintain an inference-usage rollup table unless
a future read path needs cached task aggregates.

## Slack Hooks

Slack-started tasks get worker-owned OpenCode hook files in the same config
directory:

- `plugins/roomote-slack-hooks.js`
- `roomote-opencode-slack-silence-hook.cjs`
- `roomote-opencode-slack-stop-hook.cjs`

The plugin maps OpenCode `tool.execute.before` and `tool.execute.after` events
onto Roomote's Slack reply-satisfaction rules. The hooks are advisory with one
exception: a blocked decision is appended to the tool result as a reminder in
`tool.execute.after` (not thrown), so tool calls are not failed by Slack
discipline reminders. The harness also runs the stop hook before task
completion; when it blocks, the harness re-prompts with a closeout reminder up
to `MAX_OPENCODE_STOP_HOOK_REMINDERS` times and then completes the turn
without a Slack closeout (logging a warning) instead of aborting the task.

### Subagent Slack-Posting Exclusion

Only the parent session may post to Slack. The Slack-posting tools
(`send_chat_reply`, `send_chat_reaction_emoji`, `post_to_slack_channel`,
`reply_to_slack_thread`) are defined once in
`apps/worker/src/run-task/slack-posting-tools.ts` and enforced in two layers:

1. **Config exclusion (primary).** `agent-home.ts` disables the tools
   (`tools: { <name>: false }`, the deprecated-but-supported alias OpenCode
   normalizes into per-tool `permission` rules) on every generated subagent
   config (`visual`, `judge`, `explore`, `proof-runner`) and on OpenCode's
   built-in `general` agent — the default subagent type for background Task
   launches. A named config entry for a built-in agent merges onto it in
   place rather than redefining it as a custom agent, so the `general` entry
   only strips the Slack-posting tools. Subagent sessions therefore never see
   the tools. The `architect` agent deliberately keeps them: it is a primary
   (parent-session) agent that owns plan-mode turns and replies to Slack
   itself.
2. **Hook deny (backstop).** The silence hook records the first thread it
   sees as the parent thread; non-parent (subagent) sessions skip
   Slack-discipline enforcement but are hard-denied the same tool set. On
   `PreToolUse` only, the hook returns `permissionDecision: 'deny'` with
   reason `subagent_slack_post`, and the plugin throws in
   `tool.execute.before` to fail that tool call. This stays default-closed
   for sessions whose agent config does not carry the exclusions (e.g.
   user-defined custom agents), so subagents return their report to the
   parent agent instead of posting duplicate thread messages.

OpenCode auto-discovers local plugin files with `.ts` or `.js` extensions from
`plugins/`, so the generated plugin must use `roomote-slack-hooks.js`, not
`.mjs`. The plugin runs the CJS hook scripts with the worker-provided
`ROOMOTE_NODE_EXECUTABLE` because `process.execPath` inside OpenCode points at
the OpenCode/Bun runtime, not necessarily Node.

The state file lives under the OpenCode config directory as
`roomote-slack-reply-satisfaction.json` and is initialized by `runTask()` for
Slack-backed tasks.

## Skills

Packaged skills are copied into the worker release archive from
`packages/cloud-agents/src/server/workflows/skills/` and activated into the
task runtime's `$HOME/.agents/skills` for each run.

Skill sources:

- packaged Roomote skills from `.packaged-skills/<catalog>/`
- environment-provided manual skills
- repo-local `.agents/skills`
- repo-local `.claude/skills`

Packaged Roomote skills remain authoritative on name collisions. Repo-local
skills are helper context after a Roomote workflow is active; they do not
override the surrounding system prompt, workflow contract, tool policy, proof
rules, or delivery rules.

Another is the hidden [`agent-browser`](../../packages/cloud-agents/src/server/workflows/skills/standard/agent-browser/SKILL.md) discovery stub.
Roomote keeps that checked-in stub aligned with the upstream `vercel-labs/agent-browser` discovery file rather than maintaining a separate local browser-command summary.
The stub is still not part of the three-workflow StandardTask bootstrap for ordinary natural-language requests, so browser automation stays contained inside delegated proof children unless a workflow explicitly asks for browser work.
Direct `/agent-browser` or `$agent-browser` invocation is still honored so the packaged stub can hand the agent back to the installed CLI guidance when the user asks for that browser entrypoint explicitly.

## Workflow Boundaries

`standardTask()` routes ordinary Generalist work into exactly one initial
pathway:

- `implement-changes`
- `plan-repo-implementation`
- `explain-repo-code`

Explicit Roomote packaged-skill invocations bypass that initial routing and
start the named skill directly. Task Tools send stable action IDs from the web
UI, and the worker resolves those IDs into runtime-specific skill invocation
text after the request reaches the sandbox boundary.

Repository-changing `implement-changes` runs own implementation, validation,
proof handoff, and delivery. The final delivery action is delegated to `push`,
`create-draft-pr`, or `create-pr`.

## Proof Runtime

Under the OpenCode worker runtime, `capture-visual-proof` owns proof
classification and proof-policy decisions, and capture runs inside a hidden
OpenCode `proof-runner` subagent modeled on the `visual` subagent.

The worker registers the `proof-runner` subagent in
[`agent-home.ts`](../../apps/worker/src/run-task/agent-home.ts) only when the
task's environment exposes a browser surface: `runTask()` sets
`ROOMOTE_PROOF_BROWSER_TARGET` from `environmentConfig.initialUrl`, and
`generateOpenCodeConfig()` consumes that env var, bakes the browser target into
the worker-owned subagent prompt
([`proof-runner-prompt.ts`](../../apps/worker/src/run-task/proof-runner-prompt.ts)),
and appends a parent-facing instructions file announcing the subagent. That
instructions file is the capability signal: when the harness instructions do
not mention the `proof-runner` subagent, the skill must report
`proof runtime unavailable` instead of inventing a fallback browser path.

The subagent loads only the packaged `agent-browser` skill or CLI-served
`agent-browser skills get core --full` guidance before browser work, then
drives `agent-browser` as a command-line executable against the baked-in target.
It self-reviews captures when its model can inspect images, and uploads
approved artifacts through the `manage_artifacts` MCP tool so artifact URLs
come from authoritative tool results rather than a scratch file. When the
subagent cannot inspect images, the parent skill validates the reported local
capture paths with the `visual` subagent before presenting them as proof. There
is no staged runtime handoff file; the former
`/tmp/proof-capture-config.json` and
`/tmp/capture-visual-proof/artifact-urls.json` contracts are retired.

Parent workflows must not issue browser commands directly as a substitute for
the proof skill. Browser proof remains contained in the delegated
`proof-runner` subagent run.

Proof capture is budgeted and visible. The proof-runner reaches product
state only through the brief's setup notes and normal product flows; when
unanticipated app behavior blocks the planned state, it makes at most two
focused attempts and then reports blocked instead of diagnosing application
source or touching database state beyond the brief. The parent also posts one
short user-visible status line immediately before delegating so the
transcript is not silent during the capture window.

## Prompt Editing Policy

When behavior is now fully owned by runtime code, remove prompt instructions for
it instead of preserving historical warnings. Prompt text should describe the
current contract only.

Use this priority order when changing agent behavior:

1. Put global identity and cross-surface communication rules in the system
   prompt.
2. Put task-type policy in the owning workflow builder.
3. Put reusable execution steps in the owning packaged skill.
4. Put MCP/tool mechanics in the tool implementation or tool description.
5. Update this guidance when the runtime assembly changes.
