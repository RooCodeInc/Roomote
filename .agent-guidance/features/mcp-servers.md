---
title: MCP Server Configuration
status: active
last_reviewed: 2026-07-06
owner: engineering
summary: Technical documentation of MCP server setup covering built-in servers, conditional integrations, router-facing proxies, fast-agent shared-route usage, environment MCPs, worker-side auth bypass propagation, worker deployment, and Slack delivery guardrails.
---

# MCP Server Configuration

Roomote workers execute AI tasks with access to Model Context Protocol (MCP) servers that extend the agent's capabilities. This document covers how MCP servers are configured, packaged, and deployed to worker environments.

## Overview

MCP servers are resolved inside the worker and injected directly into the active harness runtime. The configuration combines:

1. **Built-in MCP servers** — Always enabled for all Roomote tasks
2. **Curated integration MCPs** — Enabled when the deployment has an allowed curated integration and the acting user or deployment has the required linked account or shared token
3. **Environment-specific MCPs** — Declared in environment config YAML
4. **User OAuth-connected MCPs** — Dynamically fetched from user's curated MCP connections
5. **Admin-managed native integration MCPs** — Deployment-scoped MCP surfaces such as Snowflake, Asana, Grafana, and Vercel that are hosted directly in the API app while keeping credentials server-side
6. **Router-facing MCP proxies** — Small auth-checked MCP surfaces used before a cloud job exists, including the first-party Roomote platform endpoint

At task startup, `resolveBuiltInMcpServers()` builds one merged server map. `createHarness()` hands that map to the `opencode-server` runtime, which rewrites the task-owned `~/.config/opencode/opencode.json`.

For live multi-user tasks, Roomote also treats the MCP set as actor-scoped. Before each follow-up turn it synchronizes `cloud_jobs.actingUserId`, re-resolves OAuth-backed user MCP config, and logs whether the snapshot changed. That refresh check runs even when the speaking user did not change, so the next turn can pick up newly linked or revoked MCP connections for the same actor. If the snapshot change lands while a runtime turn is already running, the worker defers the harness restart until the current turn settles, then reconnects with the refreshed MCP config and replays any queued follow-ups onto the reloaded session.

## Built-in MCP Servers

Built-in MCPs are defined in `BUILT_IN_MCPS` in `apps/worker/src/commands/setup/setup-mcps.ts`.

### Browser automation runtime

Roomote's worker image installs [`agent-browser`](../../apps/worker/Dockerfile) for the delegated visual-proof runner and related internal browser wrappers. Environment-backed workspaces now rely on ordinary preview URLs plus task-scoped `agent-browser` sessions instead of a separate desktop runtime.

The shared installer at [`.docker/sandbox/install-browser-agent.sh`](../../.docker/sandbox/install-browser-agent.sh) is the source of truth for both the prebaked worker image and the Linux compatibility fallback in [`legacy-runtime-tools.ts`](../../apps/worker/src/commands/setup/legacy-runtime-tools.ts). That script:

- resolves the installed `agent-browser` Node entrypoint at runtime
- uses task-scoped `--session` values as the cache key for browser-cookie seeding
- extracts preview URLs from `ROOMOTE_*_HOST` env vars
- seeds preview-auth cookies from `ROOMOTE_AUTH_BYPASS_VALUE` / `ROOMOTE_AUTH_BYPASS_HEADER_NAME` before `open`, `goto`, and `navigate`
- also seeds `roomote_hide_preview_widget=1` so captures hide the preview widget by default
- clears the per-session seed cache when the browser session is closed

This browser automation path is intentionally adjacent to MCP setup: the worker consumes the same preview and auth-bypass env vars that [`injectEnvVars()`](../../apps/worker/src/commands/utils/env-vars.ts#L262-L277) and [`runTask()`](../../apps/worker/src/run-task/run-task.ts#L212-L256) propagate into the runtime for proof-oriented tasks.

- **Preview-first runtime**: For environment-backed workspaces, the worker now publishes preview URLs only through named preview ports. Visual proof and browser-oriented workflows use `agent-browser` with preview-cookie seeding against those preview URLs instead of a separate in-sandbox desktop surface.

The packaged visual-proof workflow in [`capture-visual-proof/SKILL.md`](../../packages/cloud-agents/src/server/workflows/skills/standard/capture-visual-proof/SKILL.md) owns proof classification and blocker reporting, and delegates capture to the hidden OpenCode `proof-runner` subagent that the worker registers when the environment exposes a browser surface (see the Proof Runtime section of [`agent-context.md`](../architecture/agent-context.md)). The subagent uploads approved artifacts through the `roomote` MCP server's `manage_artifacts` tool, so proof links come from authoritative tool results. If browser proof is required and the `proof-runner` subagent is not configured for the run, the workflow reports `proof runtime unavailable` instead of inventing another browser path. The standard catalog also carries a hidden [`agent-browser`](../../packages/cloud-agents/src/server/workflows/skills/standard/agent-browser/SKILL.md) discovery stub that mirrors the upstream `vercel-labs/agent-browser` file and points back to CLI-served guidance. StandardTask does not route ordinary work into `agent-browser` as a general packaged workflow, but explicit `/agent-browser` or `$agent-browser` invocation lands on that stub so it can redirect into the installed CLI guidance. Browser automation for proof stays contained inside the delegated proof-runner run.

The controller no longer reserves a separate browser-only sandbox port. Preview access is driven by environment-defined named ports and the existing preview-proxy auth path.

### roomote

Internal MCP server providing Roomote platform integration. Bundled with the worker at build time.

```typescript
{
  type: 'stdio',
  command: 'node',
  args: ['/path/to/worker/dist/mcp/roomote-mcp-server/index.js'],
}
```

**Available tools:**

**Key references:**

- Parent-session Slack hook ownership context: [Agent Context & Prompts](../architecture/agent-context.md#opencode-prompt-layers)
- OpenCode config generation: [`agent-home.ts`](../../apps/worker/src/run-task/agent-home.ts)
- OpenCode server harness: [`opencode-server`](../../apps/worker/src/sandbox-server/lib/harnesses/opencode-server/)

#### `manage_artifacts`

Create, upload, download, and list task artifacts.

- **create_plan**: Create markdown plan artifact (requires `title`, `content`). Returns `viewUrl` for sharing.
- **upload**: Upload workspace file by relative path. Requires `type: "general"` for ordinary task-generated files. Use `type: "visual-proof"` for uploaded proof screenshots or proof artifacts that should auto-post into the originating Slack thread when Slack thread runtime context is present. Optionally deletes the source file after upload with `deleteAfterUpload: true`.
- **download**: Retrieve artifact by `taskId` and full path (e.g., `plans/my-plan.md`). Supports versioning.
- **list**: List the artifacts already uploaded for a task (defaults to the current task; `taskId` may reference another visible task). Returns each artifact's stored path with category prefix, `artifactType`, `viewUrl`, and a signed `rawUrl` for images, with the same URL semantics as the upload response, so previously uploaded links (for example visual-proof links) can be reused without re-uploading. Supports an optional `artifactType` filter. Backed by `GET /api/tasks/:taskId/artifacts` in the API app, which uses the same cloud-job token auth and cross-task read access as artifact metadata reads and returns only the latest uploaded version per path.

#### `manage_tasks`

Manage Roomote cloud tasks programmatically.

- **Prompt reference style**: When workflow prompt text needs to tell the model how to call this MCP surface through the current OpenCode developer-tool wrapper, refer to the surfaced tool id `mcp__roomote__manage_tasks` and keep the operation in the payload via `action: "..."`. Avoid dotted pseudo-method wording such as `manage_tasks.send_message`, which looks like a separate callable tool instead of one tool plus an action parameter.
- **Existing task URLs**: When a user provides a Roomote task URL or asks about an existing Roomote task, extract the task ID and prefer `get_summary` for current status or `get_messages` for transcript details before falling back to browser or task-UI navigation.
- **search**: Find tasks by query, status, or pull request. Supports pagination via `cursor`, and accepts `pullRequest: "__has_pr__"` for any linked PR or `pullRequest: "owner/repo#123"` for a specific PR. Pull-request matching uses the durable task↔PR linkage in `task_pull_requests`, so resumed tasks still match even when the latest `SnapshotResume` job has no copied `pr*` fields.
- **get_summary**: Retrieve the latest status for a specific task ID, including the latest persisted cloud job error when sandbox startup or runtime fails before the transcript becomes useful.
- **get_compute_logs**: Retrieve the compute/runtime logs tied to a task. For jobs whose compute provider supports command-output lookup and that have both `machineId` and `sandboxCmdId`, Roomote fetches stored command output through the provider adapter. Jobs that cannot be queried still appear in the response with a `skippedReason` or `error`.
- **get_messages**: Retrieve the latest task message history (up to 1000 messages, newest first when `limit` is provided).
- **launch**: Create and start a new Standard Task using Roomote's default Generalist flow (requires `prompt` and `environmentId` from `list_environments`).
- **cancel**: Cancel an active task.
- **send_message**: Send a follow-up message to a task. If the latest cloud job is sleeping but has a resumable snapshot, the API creates a `SnapshotResume` job automatically and returns `resumed: true` plus the new `cloudJobId` instead of a 409.
- **list_environments**: List launch targets, including the all-repositories target and named environments. Call this immediately before `launch` and choose the environment by its name/description rather than repository mappings.
- **Failure visibility**: `search` and `get_summary` both include the latest persisted cloud job error so MCP-driven follow-up tasks can detect sandbox startup failures even when the task never emitted transcript messages.

#### `send_chat_reply`

Send a direct conversational reply back to the originating Slack thread for the current cloud job.

- **Availability**: Registered only when the current job has Slack reply context. Today that means `SlackAppMention` jobs plus Slack-backed `SnapshotResume` jobs that still carry both channel and thread metadata.
- **Role in Slack-started tasks**: This is the default post-kickoff path for conversational Slack lifecycle replies: `ack`, `progress`, `closeout`, and lightweight `clarification`. Only `closeout` is terminal for task completion; `ack`, `progress`, and `clarification` keep the Slack turn open for the stop hook. Worker callbacks no longer mirror runtime activity into Slack automatically.
- **Inputs**:
  - `purpose`: Required lifecycle purpose. Use `ack` for the first visible response before non-visible work, `progress` for new useful state or timed silence prevention, `closeout` for the final answer/result/blocker/handoff, and `clarification` for lightweight questions that do not end the task. Use `closeout` before final task completion.
  - `message`: Required Markdown text to post into the thread. Slack replies from `send_chat_reply`, `post_to_slack_channel`, and fast-agent final answers render in Slack `markdown` blocks, not legacy-limited `mrkdwn`. Use modern Markdown as a readability tool when it improves scanability; headings, horizontal dividers, blockquotes, fenced code blocks with optional language labels, Markdown tables, bold, italic, strikethrough, inline code, Markdown links, and inline formatting inside table cells are all supported. Prefer richer Markdown for status summaries, comparisons, pass/fail reports, grouped findings, command or code explanations, and anything with several related facts. Do not avoid tables or code fences just because the target is Slack.
  - `imagePaths?`: Workspace-relative or `/tmp` image files to upload first
  - `imageArtifactIds?`: Already-uploaded image artifact IDs to attach
- **Behavior**:
  - `message` is posted into Slack as the lead paragraph.
  - If the agent needs to ask the user a follow-up question and work can continue afterward, it should write that naturally in `message` instead of relying on a separate structured field. If the input blocks completion or should be structured/private, use `request_user_input` instead.
  - The worker uploads local image paths through the existing Roomote artifact flow, then calls `POST /api/mcp/slack/thread_reply` with artifact IDs only.
  - Already-uploaded image artifacts work the same way: pass the returned `artifactId` values via `imageArtifactIds` to attach task-generated images without re-uploading them.
  - The API endpoint resolves the target channel/thread from the authenticated cloud job rather than trusting caller-supplied Slack identifiers.
  - Image delivery uses signed Roomote artifact raw URLs rendered as Slack image blocks. The worker never receives the deployment's Slack bot token.
- **Constraints**:
  - `message` is required.
  - Only image attachments are allowed.
  - The tool is intentionally narrow; it cannot choose arbitrary channels, thread IDs, or Slack API methods.
- Agents are expected to batch meaningful updates and avoid using it for routine logs or noisy heartbeat messages.

#### `get_slack_thread`

Look up a Slack message by timestamp and return the full thread that contains it.

- **Availability**: Registered for every cloud-job run that exposes the built-in Roomote MCP.
- **Inputs**:
  - `messageTs`: Required Slack message timestamp to resolve inside the originating or provided channel
  - `channel?`: Optional Slack channel ID, channel name, or channel mention. Required when the current job did not start from Slack.
- **Behavior**:
  - The worker calls `POST /api/mcp/slack/thread_lookup` with the requested timestamp.
  - For Slack-originated jobs, callers can omit `channel`; the API resolves the source channel from the authenticated cloud job rather than trusting caller-supplied Slack identifiers.
  - For non-Slack-origin jobs, callers must pass `channel`; the API resolves channel names and mentions, verifies that the Slack app is already a member of the target channel, and then checks the current task actor. Explicit lookups require a linked acting Slack user who is a member of the channel, while bot-started Slack jobs with no linked acting user are limited to public channels the app has already joined.
  - Roomote looks up the requested message in that channel, derives the containing thread root (`thread_ts` when present, otherwise the message timestamp itself), then returns the full thread in chronological order.
  - When the authenticated cloud job has no Slack reply context and no `channel` input, the API rejects the lookup instead of guessing a channel.
- **Response shape**:
  - `channelId`: Slack channel ID used for the lookup
  - `requestedMessageTs`: The requested message timestamp
  - `threadTs`: The resolved thread root timestamp
  - `matchedMessageIndex`: Index of the requested message inside the returned `messages` array
  - `messageCount`: Total number of returned messages
  - `messages`: Chronological thread messages with `ts`, `user`, optional `username`, `text`, and summarized file metadata
- **Constraints**:
  - The lookup is scoped to either the originating Slack channel for the current job or an explicit channel the Slack app can already access under the current actor's Slack visibility.
  - The tool is read-only, cannot join channels, and cannot inspect direct messages.

#### `get_slack_channel_messages`

Fetch history from the originating Slack channel or an explicitly provided Slack channel, but only when that channel is public and the Slack app has already joined it.

- **Availability**: Registered for every cloud-job run that exposes the built-in Roomote MCP, and also exposed by the auth-checked `roomote-router-mcp` proxy before a cloud job exists.
- **Inputs**:
  - `channel?`: Optional Slack channel ID, channel name, or channel mention. Required when the current job did not start from Slack.
  - `oldest?`: Optional inclusive lower bound as either a Slack timestamp like `1777486147.585109` or an ISO 8601 date string like `2026-04-01T00:00:00Z`
  - `latest?`: Optional inclusive upper bound using the same timestamp formats as `oldest`
- **Behavior**:
  - The worker calls `POST /api/mcp/slack/channel_messages` with the requested bounds.
  - For Slack-originated jobs, callers can omit `channel`; the API resolves the source channel from the authenticated cloud job rather than trusting caller-supplied Slack identifiers, then rejects the request unless that source channel is public.
  - For non-Slack-origin jobs, callers must pass `channel`; the API resolves channel names and mentions, verifies that the Slack app is already a member of the target channel, rejects private channels, and then checks the current task actor. Explicit lookups still require a linked acting Slack user who is a member of the public channel when the current context has one.
  - The API normalizes `oldest` and `latest` into Slack-compatible timestamps, rejects reversed bounds, reads paginated `conversations.history` results, and then expands only thread roots that can still overlap the requested window so replies are included in the returned message stream.
  - When `oldest` is present, the Slack reader enforces a fixed safety cap on history pagination instead of silently walking the entire channel backlog. If Slack would require scanning past that cap to answer the request, the MCP call fails so callers can narrow the window or switch to a thread-specific lookup.
  - The final payload is returned in chronological order and annotates replies with `threadTs` so callers can reconstruct thread groupings.
- **Response shape**:
  - `channelId`: Slack channel ID used for the lookup
  - `requestedOldest?`: The caller-supplied lower bound after trimming
  - `requestedLatest?`: The caller-supplied upper bound after trimming
  - `messageCount`: Total number of returned messages
  - `messages`: Chronological channel messages with `ts`, `user`, optional `username`, optional `botId`, optional `threadTs`, `text`, and summarized file metadata
- **Constraints**:
  - The lookup is scoped to either the originating public Slack channel for the current job or an explicit public channel the Slack app has already joined under the current actor's Slack visibility.
  - The tool is read-only, cannot join channels, and cannot inspect direct messages.

#### `post_to_slack_channel`

Post to a Slack channel that the Roomote Slack app is already a member of.

- **Availability**: Registered for cloud-job runs that expose the built-in Roomote MCP and have a task ID. The API endpoint still enforces real-user job tokens and task ownership before any Slack call is made.
- **Role**: Reserved for explicit off-thread delivery. The default human-visible Slack path stays in the originating thread through `send_chat_reply`.
- **Inputs**:
  - `channel`: Slack channel ID like `C123ABC456`, channel name like `#eng` or `eng`, or a Slack channel mention like `<#C123ABC456>`
  - `threadTs?`: Optional Slack thread timestamp for replying inside an existing thread
  - `text?`: Markdown text to post. Slack replies from `send_chat_reply`, `post_to_slack_channel`, and fast-agent final answers render in Slack `markdown` blocks, not legacy-limited `mrkdwn`. Use modern Markdown as a readability tool when it improves scanability; headings, horizontal dividers, blockquotes, fenced code blocks with optional language labels, Markdown tables, bold, italic, strikethrough, inline code, Markdown links, and inline formatting inside table cells are all supported. Prefer richer Markdown for status summaries, comparisons, pass/fail reports, grouped findings, command or code explanations, and anything with several related facts. Do not avoid tables or code fences just because the target is Slack.
  - `imagePaths?`: Workspace-relative or `/tmp` image files to upload first
  - `imageArtifactIds?`: Already-uploaded image artifact IDs to attach
- **Behavior**:
  - The worker uses the same artifact upload flow as the Slack thread-reply tool, then calls `POST /api/mcp/slack/channel_post` with the requested channel, optional thread timestamp, and artifact IDs.
  - Already-uploaded image artifacts can be attached directly by passing their `artifactId` values via `imageArtifactIds`.
  - The API endpoint accepts channel IDs directly, unwraps Slack channel mentions to their underlying channel IDs, and normalizes channel-name inputs to a concrete `#channel-name` before resolving and verifying access.
  - After resolution, the API verifies that the Slack app is already in the target channel and rejects requests for channels it cannot access.
  - Slack tokens remain server-side; the worker never receives or stores the deployment's bot token.
- **Constraints**:
  - At least one of `text`, `imagePaths`, or `imageArtifactIds` is required.
  - Only image attachments are allowed.
  - Direct-message IDs are not supported.
  - Use it only when the current user explicitly asks for delivery into another Slack channel or thread.
  - Do not use it to answer customers, third parties, or linked Slack conversations just because they appear in task context.
  - The tool will not join channels automatically; callers must target channels the app is already a member of.

**Environment variables:**

- `ROOMOTE_CLOUD_TOKEN` (required) — Job auth token for API calls
- `ROOMOTE_APP_URL` — User-facing app URL used for task links plus artifact `viewUrl` and `rawUrl` responses
- `ROOMOTE_PLATFORM_API_URL` — Platform API URL used for built-in Roomote MCP API calls, including artifact create/download operations (falls back to `TRPC_URL`, then `http://localhost:13001`; see `resolvePlatformApiUrl()` in `apps/worker/src/mcp/roomote-mcp-server/config.ts`)
- `ROOMOTE_WORKSPACE_PATH` — Workspace path for artifact uploads
- `ROOMOTE_TASK_ID` — Default task ID when not explicitly provided
- `ROOMOTE_SLACK_CHANNEL` — Present only for Slack-capable jobs so `send_chat_reply` can be registered
- `ROOMOTE_SLACK_THREAD_TS` — Present only for Slack-capable jobs so the built-in Roomote MCP can detect the originating thread for the Slack reply tool

## Conditional Integration MCPs

Integration MCPs are added when the deployment has connected external services. The worker now resolves those integrations from the shared MCP connection inventory returned by `sdk.mcpConnections.getMcpServerConfigs()`, then normalizes any Roomote-hosted proxy paths inside `resolveBuiltInMcpServers()`.

### Linear

Linear is modeled as a deployment-scoped curated MCP in the shared MCP catalog, but it still reuses the dedicated Linear OAuth install plus webhook surface. The Linear OAuth callback mirrors the successful workspace install into `mcp_connections` (`mcpId = 'linear'`, `userId = NULL`) and `deployment_mcp_enablements`, so worker task startup and router-side discovery can treat Linear like the other curated MCPs while the API proxy continues to source the real refreshable token from `linear_installations`.

```typescript
{
  type: 'streamable-http',
  url: '{TRPC_URL}/api/mcp/linear',
  headers: {
    Authorization: 'Bearer {ROOMOTE_CLOUD_TOKEN}',
  },
}
```

**Proxy configuration:**

The Linear MCP endpoint (`/apps/api/src/handlers/mcp/linear.ts`) proxies to `https://mcp.linear.app/mcp` with automatic OAuth token refresh. The proxy:

1. Validates job token or user auth token (when `allowAuthTokens: true` for router use)
2. Fetches the active Linear installation for the deployment
3. Refreshes Linear OAuth token if expired
4. Applies any deployment-level disabled-tool policy from `deployment_mcp_enablements`
5. Proxies request to upstream with Linear access token

**Tool allowlist (router context):**

When used by the LLM router (pre-job context gathering), only specific tools are allowed via `getAllowedRouterMcpToolNames('linear')`.

### Snowflake

Snowflake is an admin-managed native MCP surface rather than an OAuth-backed proxy to a third-party MCP server. The admin UI stores the deployment-scoped Snowflake connection in `mcp_connections` with `userId = NULL`, and the worker reaches it through the same integration-proxy `streamable-http` path as the other curated integrations.

The current admin flow uses a single Snowflake auth path:

- **Programmatic Access Token**: Admins enter a PAT generated in Snowsight, and Roomote stores it in the encrypted password slot that the Snowflake SDK already accepts for token-based authentication.

Edits keep secrets server-side. The admin query only returns non-secret metadata for the saved connection, and leaving the token field blank preserves the existing stored Snowflake credential, including legacy key-pair-backed connections. `warehouse` remains optional so Snowflake can fall back to the account's default warehouse when one is configured on the user.

### Asana

Asana is also an admin-managed native MCP surface instead of an OAuth-backed proxy. The admin UI stores the deployment-scoped Asana connection in `mcp_connections` with `userId = NULL`, and the worker reaches it through the same integration-proxy `streamable-http` path as the rest of the curated integrations.

The current Asana admin flow uses a single bearer token credential:

- **Personal Access Token or Service Account token**: Operators paste an Asana bearer token from the workspace, and Roomote stores it encrypted in `auth_config`.

The native Asana surface is read-only and talks directly to `https://app.asana.com/api/1.0/...` with that stored bearer token. The admin query only returns non-secret metadata for the saved connection, and leaving the token field blank during an edit keeps the existing stored credential in place.

### Grafana

Grafana is an admin-managed native MCP surface because Roomote needs to support shared workspace monitoring data via a Grafana instance URL plus service account token, not per-user OAuth. The admin UI stores the deployment-scoped Grafana connection in `mcp_connections` with `userId = NULL`, and the worker reaches it through the same integration-proxy `streamable-http` path as the other curated integrations.

The current Grafana admin flow uses two workspace-scoped fields:

- **Grafana base URL**: Admins paste the shared Grafana instance URL. Roomote normalizes it before persistence so API requests can reuse the stored base path safely.
- **Grafana service account token**: Admins paste a shared service account bearer token, and Roomote stores it encrypted in `auth_config`.

Grafana is deployment-scoped because dashboards, alerting state, annotations, and data sources are shared operational context rather than personal user data. The native Grafana surface is intentionally read-only and talks directly to the Grafana HTTP API. The current read-only tool policy exposes dashboard listing and fetch, dashboard search, alert rule reads, current alert instance reads, data source listing, and annotation listing. The admin query only returns non-secret metadata for the saved connection, and leaving the token field blank during an edit keeps the existing stored credential in place.

### Vercel

Vercel is an admin-managed native MCP surface for the same reason Asana and Snowflake are native: the hosted Vercel MCP supports OAuth only for approved clients, so Roomote uses a shared workspace access token instead of routing users through the hosted MCP auth flow. The admin UI stores the deployment-scoped Vercel connection in `mcp_connections` with `userId = NULL`, and the worker reaches it through the same integration-proxy `streamable-http` path as the rest of the curated integrations.

The current Vercel admin flow uses a single bearer token credential:

- **Vercel access token**: Admins paste a Vercel access token from the shared team or account, and Roomote stores it encrypted in `auth_config`.
- **Optional default team ID or slug**: Admins can also save a default Vercel team scope so project and deployment tools stay pinned to the shared workspace unless a tool call overrides it.

The native Vercel surface is intentionally read-only. It talks directly to the Vercel REST API and currently exposes team, project, deployment, build-log, runtime-log, and domain-availability reads. Because the official hosted MCP also includes mutating and billing-affecting capabilities such as deploy and domain purchase, Roomote keeps the first-party native surface narrower and read-only for now.

## Router-Facing MCP Endpoints

The router can call a small allowlisted set of MCP servers before launching a worker. These endpoints live under `apps/api/src/handlers/mcp/` and are mounted via `/api/mcp-routing/*`. They accept both Roomote user auth tokens and cloud-job tokens so the same code path works during routing and during worker execution.

### Roomote

`/api/mcp-routing/roomote` is a first-party JSON-RPC MCP server implemented locally rather than proxied to an upstream service. Its router-visible allowlist currently exposes two read-only tools:

- `get_about_me`
- `get_slack_thread`

`get_about_me` returns deployment-scoped platform context for the active user, including:

- product metadata such as the Roomote name and web app URL
- the canonical public docs URL for the current app environment
- environments, their repository mappings, and declared environment MCP servers
- integration status for GitHub, Linear, and Slack
- enabled deployment MCPs plus user MCP connections
- Roomote capabilities and getting-started guidance for Slack, Linear, GitHub, and the web app, including the guidance that Slack users usually do not need to name the repo up front

The LLM router uses `get_about_me` for the meta-question path. When the routing model marks a request as a generic Roomote platform question, the router calls `get_about_me` and first looks for a preferred platform-answer string to return verbatim. If no preferred string is present, it falls back to the concise first-person self-introduction prompt path and returns that answer to Slack, Linear, or Home without launching a cloud worker. If the answer prompt cannot answer from the provided context, it emits a sentinel and the router falls back to normal task routing.

During the router's external-reference precheck, Roomote stays excluded by default so the lookup surface remains focused on third-party issue and repository context. The one exception is Slack permalinks: when the router detects a Slack message URL such as `...slack.com/archives/.../p...`, it also exposes `get_slack_thread` so the model can inspect the linked thread before finalizing the workspace selection.

### GitHub (Router + Fast Agent)

GitHub MCP is exposed today through router-facing API proxies rather than worker MCP auto-injection:

- `/api/mcp-routing/github` is used by both the LLM router and the Slack fast agent. It forwards a read-only GitHub MCP session with the `repos,pull_requests` toolsets that the upstream GitHub MCP server exposes for that scope.

The shared route authenticates with a user-scoped Roomote auth token, resolves the deployment's active GitHub installation through [`createGithubMcp()`](../../apps/api/src/handlers/mcp/github.ts), and mints the upstream GitHub installation token on demand. The router narrows tools in its own client logic, while the fast-agent client is consumed inline by [`answerFastAgentQuestion()`](../../packages/cloud-agents/src/server/fast-agent/fast-agent-service.ts), which merges those GitHub MCP tools with inline `send_ack` and `send_final_answer` tools supplied by the Slack handler. Both inline fast-agent reply tools share the same Slack-posting callback, but `answerFastAgentQuestion()` tags each call with `type: "ack"` or `type: "final_answer"` so the Slack handler can record whether the final answer actually posted. The webhook falls back to posting returned text only when Slack delivery failed or `send_final_answer` never posted successfully. That lets Slack `!fast` questions inspect configured repositories and pull requests and still surface a visible acknowledgement or answer in the originating thread without launching a worker VM while avoiding duplicate near-identical replies when the tool path already delivered the final answer.

## Environment-Specific MCPs

Environments can declare custom MCP servers in their YAML config via the `mcpServers` field (type: `EnvironmentMcpServers` from `@roomote/types`).

**Example environment config:**

```yaml
name: My Environment
repositories:
  - repository: owner/repo

mcpServers:
  slack:
    url: https://mcp.slack.com/mcp
    headers:
      Authorization: Bearer xoxb-...

  custom-tool:
    command: npx
    args: ['-y', 'my-custom-mcp']
    env:
      TOOL_API_KEY: secret123
```

**Schema:**

Environment MCPs support two transports:

**Streamable HTTP:**

```typescript
{
  url: string;
  headers?: Record<string, string>;
}
```

**Stdio:**

```typescript
{
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
```

For environment-declared MCPs, values under `mcpServers.<name>.env` and
`mcpServers.<name>.headers` support `$VAR` and `${VAR}` interpolation against
the task runtime environment, including values defined in the environment
config's top-level `env` block. Unresolved references are left intact.

When a multi-repo environment needs stdio MCPs to resolve tools at the shared
workspace root, prefer the environment config's top-level `tool_versions`
field over duplicating the same versions into each repository. Roomote writes
that shared `.tool-versions` file at the workspace root and runs `mise install`
there before the MCP-capable harness starts, while repo-local tool config still
wins for tools a repo already pins.

**Name conflict resolution:**

Environment MCPs are added last. If an environment declares an MCP with a name that conflicts with a built-in or integration MCP, the environment MCP is **skipped** and a warning is logged:

```
[resolveBuiltInMcpServers] Skipping custom MCP 'linear': name conflicts with an existing MCP server
```

This prevents environments from shadowing built-in servers.

## Curated OAuth MCPs

Curated OAuth-backed MCP servers are connected from the platform UI and fetched at runtime via `sdk.mcpConnections.getMcpServerConfigs()`, then merged into `integrations.userMcpServers`.

Deployment operators control which curated MCP integrations are available from Settings > Integrations in the web dashboard. That page reads from the shared `MCP_INTEGRATIONS` catalog in `packages/types/src/mcp-oauth.ts`, so new deployment-scoped curated integrations appear automatically when that list is rendered. Slack and Linear remain separate in Settings because they use custom deployment connection flows instead of the curated OAuth catalog.

Most curated OAuth MCPs are still user-scoped: each user links their own account from Personal Settings, and actor-scoped task refresh continues to swap those MCP credentials when `cloud_jobs.actingUserId` changes.

Jira, Sentry, Pylon, Better Stack, Railway, PostHog, and Supermemory are the current curated OAuth exceptions. Their shared connections are deployment-scoped:

- a deployment operator starts setup from Settings > Integrations
- the OAuth callback turns the integration on only after the shared connection succeeds
- Roomote stores the curated MCP connection with `userId = null`
- every user in the deployment can use that MCP after the single operator-managed connection exists

Slack kickoff now reuses the same readiness surface before routing starts. When a fresh Slack app mention contains a URL for one of the services in the built-in setup-detection catalog, the Slack-specific pre-routing detector checks deployment enablement plus readiness semantics for that service. User-scoped integrations still prompt the acting user to link their own account. Deployment-scoped integrations such as Jira, Sentry, Pylon, Better Stack, Railway, PostHog, Supermemory, Asana, Grafana, and Vercel instead prompt for operator setup when the deployment-level connection is missing. Sentry now uses the curated OAuth readiness path only: `sentry.io` links route operators to `/settings/integrations?highlight=sentry-mcp`, and setup is complete when the deployment has a connected Sentry MCP connection. If the deployment has a shared Manager Channel configured, those deployment-level setup blockers also post a one-time manager-channel nudge with `Configure` and `No, thanks` buttons; dismissals are stored so the original message can lose its buttons without treating user account-linking blockers as manager work.

At the time of writing, the curated OAuth-backed catalog includes Notion, Jira, Sentry, Pylon, PostHog, Neon, Supabase, Better Stack, Railway, Braintrust, and Supermemory. Sentry setup is MCP-only: the Sentry MCP proxy gives tasks read-only Sentry context and also powers scheduled Sentry triage automation.

Jira uses Atlassian's remote MCP endpoint at `https://mcp.atlassian.com/v1/mcp/authv2`. Atlassian publishes protected-resource metadata for that endpoint plus an authorization server with a dynamic client registration endpoint, so Roomote treats Jira as a standard upstream OAuth proxy. Jira is deployment-scoped in Roomote: a deployment operator connects Jira once from Settings > Integrations, Roomote stores the shared connection with `userId = null`, and every task uses that shared Atlassian account. Roomote requests only Jira read/search scopes for that flow. Atlassian's upstream tool surface also includes Jira write tools plus Confluence and Compass operations, so Roomote constrains the proxy to Jira's read-only/search-only allowlist while preserving Atlassian's shared platform helpers: `atlassianUserInfo`, `getAccessibleAtlassianResources`, `getJiraIssue`, `getJiraIssueRemoteIssueLinks`, `getJiraIssueTypeMetaWithFields`, `getJiraProjectIssueTypesMetadata`, `getIssueLinkTypes`, `getTransitionsForJiraIssue`, `getVisibleJiraProjects`, `lookupJiraAccountId`, and `searchJiraIssuesUsingJql`. Atlassian admins may also need to add the Roomote app domain to the Rovo MCP Server external-domain allowlist before users can finish OAuth from the web app.

Pylon uses the upstream MCP endpoint at `https://mcp.usepylon.com` and advertises OAuth discovery plus dynamic client registration from its protected-resource metadata. The upstream tool surface includes both read and write operations for issues and accounts, so Roomote keeps the connection deployment-scoped and constrains the proxy to the read-only tool subset we currently expose: `search_issues`, `get_issue`, `get_issue_messages`, `search_accounts`, and `get_account`.

Supabase is currently wired to `https://mcp.supabase.com/mcp?read_only=true&features=database`, so Roomote exposes its read-only database toolset only.

Sentry uses the remote MCP endpoint at `https://mcp.sentry.dev/mcp`. Roomote keeps the Sentry MCP connection deployment-scoped so one operator-managed OAuth connection can provide issue and project context, but constrains that proxy to the read-only Sentry tool subset. The allowlist includes account, organization, team, project, release, issue/event search, issue detail, trace, replay, profile, docs, resource, attachment, and DSN reads while blocking mutating upstream tools such as `update_issue`, `create_project`, `update_project`, and `create_dsn`.

Better Stack's upstream MCP server exposes every available tool by default, including mutating ones. Roomote now constrains the Better Stack proxy to a read-only allowlist at the proxy layer by filtering `tools/list` responses and rejecting disallowed `tools/call` requests before they reach the upstream server. The shipped allowlist keeps documentation search, read-only Uptime queries, and read-only Telemetry query/build tools, while blocking create, update, delete, acknowledge, resolve, and other state-changing operations.

For enabled MCP integrations, operators can also save a deployment-level disabled-tools blocklist from Settings > Integrations > Manage tools. Roomote stores the raw upstream tool ids on the deployment enablement row, hides blocked tools from `tools/list`, and rejects direct `tools/call` requests for those ids before the upstream MCP server sees them. User-scoped OAuth connections, such as Notion, may still require the operator to link their own account first so Roomote can call the upstream MCP server's authenticated `tools/list` method and discover the current catalog.

Railway uses the remote MCP endpoint `https://mcp.railway.com`. Railway supports OAuth plus MCP dynamic client registration, so Roomote uses the standard upstream-proxy flow for the shared connection: the deployment operator completes one OAuth handshake, Roomote discovers the provider metadata, dynamically registers the client, stores the deployment-owned connection with `userId = null`, and then exposes the Railway MCP to every task. Roomote constrains the built-in Railway proxy to a small read-only allowlist (`whoami`, `list-projects`, and `list-services`), and the shipped Railway copy is intentionally limited to those account, project, and service inventory capabilities. Slack URL detection matches Railway app links on `railway.app` plus authenticated `railway.com/project/...` app paths, while public docs and marketing pages on `railway.com` stay out of the OAuth interruption flow.

Supermemory uses the remote MCP endpoint at `https://mcp.supermemory.ai/mcp`. Supermemory publishes protected-resource metadata pointing at its authorization server, which supports OAuth dynamic client registration plus PKCE, so Roomote treats it as a standard upstream OAuth proxy. The connection is deployment-scoped: a deployment operator connects one Supermemory account from Settings > Integrations, Roomote stores the shared connection with `userId = null`, and every task shares that account's memory store. Supermemory intentionally has no read-only tool allowlist: the upstream tool surface is `memory` (save/forget), `recall`, and `whoAmI`, and saving memories is the point of the integration. Writes only affect the connected Supermemory account's memory store, so the proxy passes the full tool surface through like Notion does; operators can still trim tools with the per-deployment disabled-tools blocklist. The integration is off by default and a deployment operator must connect it before the Supermemory MCP tools are available to tasks.

Curated integrations can also declare an optional agent-facing `instructions` field on their `McpIntegration` catalog entry in `packages/types/src/mcp-oauth.ts`. When a task's MCP config includes a server whose name matches a catalog integration with `instructions`, the worker composes those sections into a `roomote-opencode-integration-instructions.md` file and registers it in the generated OpenCode `instructions` list (`createIntegrationMcpInstructions()` in `apps/worker/src/run-task/agent-home.ts`). This gives connected integrations a prompt-level channel to say when their tools should be used instead of relying on upstream tool descriptions alone. Supermemory is the first user: its guidance tells agents to run one cheap `recall` pass near the start of substantive work and to treat `memory` saves as rare and criteria-gated (durable cross-task knowledge only, never task status, code contents, secrets, or repo-derivable facts).

Slack's pre-routing interruption metadata intentionally lives in a separate shared catalog (`packages/types/src/mcp-service-detection.ts`) because the detection problem is based on user-facing service URLs like `linear.app` and `notion.so`, not on MCP transport endpoints like `mcp.notion.com/mcp`.

### OAuth client registration

Roomote uses OAuth discovery plus dynamic client registration for curated MCP integrations. Discovery first checks same-origin `/.well-known/oauth-authorization-server`. If the MCP resource instead publishes OAuth 2 protected-resource metadata, Roomote follows `/.well-known/oauth-protected-resource...` or the `resource_metadata` hint from `WWW-Authenticate`, then resolves the advertised `authorization_servers` issuer metadata. For dynamically registered integrations, when an MCP server advertises `token_endpoint_auth_methods_supported`, Roomote prefers `client_secret_post` when available and falls back to `none` for public-client-only servers. For consent scopes, Roomote first applies any integration-specific `oauthScopes`, then prefers the MCP protected resource's `scopes_supported` list when present and falls back to the authorization server catalog otherwise, then applies the curated integration policy from `packages/types/src/mcp-oauth.ts` instead of blindly inheriting the provider default. PostHog is currently configured to use the unscoped upstream endpoint `https://mcp.posthog.com/mcp` and request only read-oriented scopes plus the standard identity scopes during OAuth initiation. If the server omits `token_endpoint_auth_methods_supported`, Roomote keeps the legacy `client_secret_post` default.

**Fetch logic** (`runTask()` and actor-scoped refresh fetch the platform configs before handing them to `resolveBuiltInMcpServers()`):

```typescript
if (taskEnv?.ROOMOTE_CLOUD_TOKEN) {
  try {
    const { servers } = await sdk.mcpConnections.getMcpServerConfigs();
    mergedIntegrations.userMcpServers = {
      ...(mergedIntegrations.userMcpServers ?? {}),
      ...servers,
    };
  } catch (error) {
    console.warn('Failed to fetch user MCP configs');
  }
}
```

These curated OAuth MCPs are treated as streamable-http servers with optional headers.

## Admin-Managed Native MCPs

Some curated integrations are neither worker-bundled stdio servers nor upstream OAuth proxies. Snowflake, Asana, Grafana, and Vercel are the current examples: Roomote registers them in the shared `MCP_INTEGRATIONS` catalog, but marks them as admin-managed native integrations instead of self-serve OAuth connections.

Workers still receive Snowflake, Asana, Grafana, and Vercel as normal `streamable-http` MCP entries from `sdk.mcpConnections.getMcpServerConfigs()`. The difference is entirely on the API side:

- the worker talks to `/api/mcp/snowflake`, `/api/mcp/asana`, `/api/mcp/grafana`, or `/api/mcp/vercel` through the standard MCP proxy path
- the API app implements the MCP JSON-RPC surface locally instead of forwarding to an upstream MCP server
- the API resolves the deployment-owned `mcp_connections` row with `userId = null`
- connection credentials stay in `mcp_connections.auth_config` on the server, with encrypted secrets decrypted only inside the API process

The native Snowflake surface currently exposes these tools:

- `execute_sql`
- `list_databases`
- `list_schemas`
- `list_tables`
- `describe_table`

`execute_sql` supports an allowlist of statement types through `auth_config.allowedStatementTypes`. The current implementation reads that field directly from the stored connection config and leaves the admin UI for managing the restriction as follow-up work.

Unlike the curated OAuth catalog, Snowflake does not use the self-serve OAuth connect flow. Settings > Integrations now renders Snowflake alongside the other curated MCP cards, but operators configure it through a credential dialog instead of an OAuth redirect. Saving the form:

- encrypts a newly entered Snowflake password before persistence
- keeps stored Snowflake secrets server-side; the edit flow never returns the decrypted password to the browser
- upserts the deployment-scoped `mcp_connections` row with `mcp_id = 'snowflake'` and `user_id = null`
- preserves existing statement restrictions, schema defaults, and key-pair auth fields when operators update the connection
- marks the connection authenticated and enables Snowflake for the deployment in `deployment_mcp_enablements`

The same Settings card also surfaces the connected account and role metadata, allows operators to reopen the form with the editable non-secret fields prefilled, leaves the password blank unless an operator is rotating it, and reuses the existing deployment-scoped disconnect path to delete the stored connection and turn the integration off.

Asana follows the same server-side credential pattern, but the native surface stays read-only and fetch-based rather than using an SDK. The current Asana tool set includes:

- `list_workspaces`
- `get_project`
- `list_projects`
- `get_task`
- `list_tasks_for_project`
- `search_tasks`
- `get_task_comments`
- `list_teams`
- `get_user`

Saving the Asana form encrypts the pasted bearer token before persistence, upserts the deployment-scoped `mcp_connections` row with `mcp_id = 'asana'` and `user_id = null`, and enables the integration for the deployment in `deployment_mcp_enablements`. Because the dialog exposes only the token field, edits leave the token blank to keep the existing stored credential unless the operator is rotating it.

Grafana follows the same server-side credential pattern as Asana, and the native surface also stays read-only. The current Grafana tool set includes:

- `list_dashboards`
- `search_dashboards`
- `get_dashboard`
- `list_alert_rules`
- `get_alert_rule`
- `list_alert_instances`
- `list_data_sources`
- `list_annotations`

Saving the Grafana form stores the normalized base URL plus an encrypted service account token, upserts the deployment-scoped `mcp_connections` row with `mcp_id = 'grafana'` and `user_id = null`, and enables the integration for the deployment in `deployment_mcp_enablements`. The dialog keeps the service account token blank during edits unless the operator is rotating it.

Vercel follows the same server-side credential pattern as Asana, and the native surface also stays read-only. The current Vercel tool set includes:

- `list_teams`
- `list_projects`
- `get_project`
- `list_deployments`
- `get_deployment`
- `get_deployment_build_logs`
- `get_runtime_logs`
- `check_domain_availability_and_price`

Saving the Vercel form encrypts the pasted bearer token before persistence, upserts the deployment-scoped `mcp_connections` row with `mcp_id = 'vercel'` and `user_id = null`, and enables the integration for the deployment in `deployment_mcp_enablements`. The dialog also stores an optional default team id or slug so the native tools can stay scoped to the shared Vercel workspace by default.

## MCP Configuration Packaging

The built-in Roomote MCP server ships inside the worker bundle at `apps/worker/src/mcp/roomote-mcp-server/index.ts`, and the worker resolves all other MCP definitions at runtime from integration state plus environment YAML. `scripts/build-worker-release.sh` still contains a defensive `cp -r .docker/config/mcp "$TAG/.agents/"` branch, but this repository does not ship that directory and task startup does not read MCP config from a packaged `.agents/mcp` tree. The worker no longer relies on a VS Code global-storage MCP file.

## Harness Injection Paths

`resolveBuiltInMcpServers()` returns one merged record keyed by MCP name. That record is consumed differently depending on the selected harness:

- **`opencode-server`**: `startOpenCodeServerHarness()` normalizes each server with `parseDirectMcpConfig()`, then `prepareOpenCodeCommandEnv()` rewrites the task-owned `~/.config/opencode/opencode.json` through `generateOpenCodeConfig()`. Streamable HTTP servers are normalized into OpenCode `remote` MCP entries, bearer headers are moved into dedicated env vars when needed, and stdio servers are written as OpenCode `local` MCP entries.

The important boundary is that MCP wiring now happens inside the worker/harness stack itself, not via an editor shim.

## Stdio Environment Variable Injection

Stdio MCP servers inherit a minimal environment from the extension's `StdioClientTransport.getDefaultEnvironment()` (HOME, PATH, SHELL, TERM, USER). Additional variables are injected:

**For all stdio servers:**

```typescript
const stdioEnvExtras: Record<string, string> = {};

for (const key of ['MISE_DATA_DIR', 'MISE_CACHE_DIR']) {
  if (process.env[key]) {
    stdioEnvExtras[key] = process.env[key];
  }
}
```

This ensures `npx` and `node` shims can locate mise-managed runtimes.

**For Roomote MCP:**

Task-specific environment variables are injected:

```typescript
const roomoteEnvKeys = [
  'ROOMOTE_CLOUD_TOKEN',
  'ROOMOTE_APP_URL',
  'ROOMOTE_PLATFORM_API_URL',
  'ROOMOTE_WORKSPACE_PATH',
  'ROOMOTE_TASK_ID',
  'ROOMOTE_TASK_TYPE',
  'ROOMOTE_SLACK_CHANNEL',
  'ROOMOTE_SLACK_THREAD_TS',
] as const;
```

## Configuration Flow

1. **Task initialization**: `runTask()` gathers `taskEnv`, integration state, and `environmentConfig.mcpServers`, and fetches any user-scoped OAuth MCP configs through `sdk.mcpConnections.getMcpServerConfigs()`.
2. **MCP resolution**: `resolveBuiltInMcpServers()` merges built-in MCPs, integration MCPs, user OAuth MCPs, and non-conflicting environment MCPs into one record.
3. **Harness injection**: `createHarness()` passes that record into the selected harness.
   - Roomote rewrites the task-scoped OpenCode config in one owned pass so the direct subprocess starts with the full MCP set already present.
4. **Runtime execution**: the Roomote stdio server runs inside the worker bundle, while `streamable-http` integrations continue to flow through the API-layer MCP handlers or explicit external URLs.

## Worker-side auth bypass and browser automation

The worker now passes preview-auth bypass values through two layers:

1. [`injectEnvVars()`](../../apps/worker/src/commands/utils/env-vars.ts#L262-L277) injects `ROOMOTE_AUTH_BYPASS_VALUE` and `ROOMOTE_AUTH_BYPASS_HEADER_NAME` into the task environment from the active cloud-job metadata.
2. [`runTask()`](../../apps/worker/src/run-task/run-task.ts#L212-L256) copies those values into `mcpTaskEnv`, then [`createHarness()`](../../apps/worker/src/run-task/create-harness.ts#L64-L129) passes the same env through [`resolveBuiltInMcpServers()`](../../apps/worker/src/commands/setup/setup-mcps.ts#L239-L449) for built-in MCPs and environment MCPs.

That keeps preview auth available both to the internal Roomote MCP server and to the worker-level `agent-browser` wrapper used by visual-proof tooling.

## MCP Proxy Architecture (API Handlers)

Worker-facing integration MCP routes are exposed at `/api/mcp/*`. Most of them are upstream proxies, including Linear and curated OAuth-backed integrations such as Notion, Sentry, PostHog, Neon, Supabase, Better Stack, Braintrust, and Supermemory, and they reuse the shared `createMcpProxy()` layer in `proxy-utils.ts`. Snowflake, Asana, Grafana, and Vercel are the current native exceptions: `/api/mcp/snowflake`, `/api/mcp/asana`, `/api/mcp/grafana`, and `/api/mcp/vercel` are implemented locally in `apps/api/src/handlers/mcp/snowflake/`, `apps/api/src/handlers/mcp/asana/`, `apps/api/src/handlers/mcp/grafana/`, and `apps/api/src/handlers/mcp/vercel/` and answer MCP JSON-RPC requests directly instead of delegating to the generic proxy. Router-facing MCP proxies (Linear and GitHub) are exposed at `/api/mcp-routing/*`.

The Slack thread-reply capability is intentionally **not** a generic MCP proxy. It lives at `POST /api/mcp/slack/thread_reply` and only accepts a Roomote job token plus Roomote-managed artifact IDs. The handler resolves the Slack channel/thread from the current cloud job, validates that each artifact belongs to the same task (and, when present, the same `cloudJobId`), signs public raw URLs, and posts a threaded reply through `SlackNotifier`.

Slack quote tracking for worker-originated web replies uses the same MCP auth surface rather than sandbox-local Redis. After the worker confirms that the current cloud job has Slack thread context, it calls `POST /api/mcp/slack/track_reply_quote` with the job token, `cloudJobId`, user-authored text, and display name so the API writes the pending quote into the shared Redis instance that `thread_reply` later reads. `POST /api/mcp/slack/clear_reply_quote` is the paired cleanup endpoint for explicit quote removal when a worker-side path needs it.

**Features:**

1. **Token validation**: Accepts job tokens (`t: 'cj'`) or user auth tokens (`t: 'auth'` when `allowAuthTokens: true`)
2. **Credential resolution**: Calls provider-specific `resolveCredentials()` to fetch access tokens or static deployment-scoped connection config
3. **Request handling**: Either forwards JSON-RPC requests to an upstream MCP service or answers them locally for native integrations
4. **Tool filtering**: When `allowedToolNames` is set, filters `tools/list` responses and blocks unauthorized `tools/call` requests
5. **Error mapping**: Converts MCP proxy and native-handler failures to JSON-RPC error responses

### Acting-User Credential Resolution

For worker-facing integration MCPs, job tokens identify the cloud job owner,
but OAuth credential lookup can also use `cloud_jobs.actingUserId` when a
follow-up path records a different human actor before prompt delivery.

That acting-user override is now refreshed for:

- web task follow-ups that reach the shared sandbox prompt procedures
- Slack follow-ups that drain through the worker poller
- Linear follow-ups that drain through the worker poller

In those paths, Roomote resolves user-scoped integration credentials from
`cloud_jobs.actingUserId`, falling back to the job token `userId` only when no
override exists. Deployment-scoped curated MCPs such as Pylon instead
resolve credentials from the deployment-owned connection row. This keeps multiplayer
flows aligned with the human who most recently replied without forcing every
integration to be user-bound.

Roomote also refreshes the mounted actor-scoped MCP config before the next turn
is delivered. The worker re-fetches `integrations.userMcpServers` for the
current actor, compares them with the
already-mounted actor-scoped config, and reconnects the harness onto the same
runtime session only when the effective tool inventory changed. Roomote does not
force that reconnect while another runtime turn is still running just because a new
follow-up was queued; in that case it still records the acting user
immediately, but it waits for a reconnect-safe boundary before refreshing the
mounted actor-scoped MCP state.

Roomote updates `actingUserId` and mounted actor-scoped MCP state before prompt
delivery rather than inferring either from the latest `task_messages` row.
Transcript persistence is asynchronous, so the newest user message may not be
durably written yet when the same turn makes an MCP call.

**Upstream constraints (GitHub example):**

```typescript
const constraints = getRouterMcpUpstreamConstraints('github');
headers['X-MCP-Readonly'] = 'true';
headers['X-MCP-Toolsets'] = 'files,issues';
```

This ensures the LLM router (pre-job context) has limited read-only access.

## Environment Variables Reference

### Task Environment (`mcpTaskEnv`)

Passed into MCP resolution from `runTask()`:

- `ROOMOTE_CLOUD_TOKEN` — Job auth token
- `ROOMOTE_APP_URL` — User-facing app URL
- `ROOMOTE_PLATFORM_API_URL` — Platform API URL for built-in Roomote MCP API calls
- `ROOMOTE_WORKSPACE_PATH` — Workspace root
- `ROOMOTE_TASK_ID` — Current task ID
- `ROOMOTE_TASK_TYPE` — Current cloud task type (used for conditional Roomote MCP tools)
- `ROOMOTE_SLACK_CHANNEL` — Present only for Slack-capable jobs so `send_chat_reply` can be registered
- `ROOMOTE_SLACK_THREAD_TS` — Present only for Slack-capable jobs so the built-in Roomote MCP can detect the originating thread
- `ROOMOTE_*_HOST` — Preview URLs (consumed by worker-side browser automation for cookie scoping)
- `ROOMOTE_AUTH_BYPASS_VALUE` — Auth bypass secret for preview URLs
- `ROOMOTE_AUTH_BYPASS_HEADER_NAME` — Cookie name for auth bypass (default: `x-bypass-roomote-auth`)

### Worker Environment

- `MISE_DATA_DIR` — Mise runtime directory (injected into stdio MCPs)
- `MISE_CACHE_DIR` — Mise cache directory
- `HOME` — User home directory for config paths
- `TRPC_URL` — API origin for Linear MCP proxy (fallback to `ROOMOTE_APP_URL`)
- `GITHUB_MCP_SERVER_URL` — Override GitHub MCP upstream (default: `https://api.githubcopilot.com/mcp/`)

## Key Files Reference

| File                                                              | Purpose                                                                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker/src/commands/setup/setup-mcps.ts`                    | MCP resolution logic, config writing, integration proxy normalization, and env injection                                                                   |
| `apps/worker/src/mcp/roomote-mcp-server/index.ts`                 | Roomote MCP server implementation (artifact management, task operations, Slack thread replies)                                                             |
| `apps/worker/src/mcp/roomote-mcp-server/reply-to-slack-thread.ts` | Slack-only Roomote MCP tool; uploads local images as artifacts and calls the internal Slack reply endpoint                                                 |
| `apps/api/src/handlers/mcp/routing.ts`                            | Router-facing MCP proxy routes                                                                                                                             |
| `apps/api/src/handlers/mcp/slack.ts`                              | Internal Slack thread reply endpoint for Roomote MCP jobs                                                                                                  |
| `apps/api/src/handlers/mcp/linear.ts`                             | Linear MCP proxy with OAuth token refresh                                                                                                                  |
| `apps/api/src/handlers/mcp/asana/`                                | Native Asana MCP server hosted in the API app, including bearer-token credential resolution and read-only Asana REST tool registration                     |
| `apps/api/src/handlers/mcp/grafana/`                              | Native Grafana MCP server hosted in the API app, including instance URL plus service-account-token resolution and read-only Grafana REST tool registration |
| `apps/api/src/handlers/mcp/snowflake/`                            | Native Snowflake MCP server hosted in the API app, including tool registration, JSON-RPC handling, and Snowflake SDK connection helpers                    |
| `apps/api/src/handlers/mcp/vercel/`                               | Native Vercel MCP server hosted in the API app, including encrypted token resolution and read-only Vercel REST tool registration                           |
| `apps/api/src/handlers/mcp/github.ts`                             | GitHub MCP proxy with installation token generation (used by `mcp-routing`)                                                                                |
| `apps/api/src/handlers/mcp/proxy-utils.ts`                        | Shared MCP proxy infrastructure (auth, tool filtering, error handling)                                                                                     |
| `apps/worker/Dockerfile`                                          | Canonical worker image; bakes `agent-browser`, Chromium, and the preview-cookie wrapper into the durable worker OS/tooling layer                           |
| `.docker/sandbox/install-worker.sh`                               | Refreshes the shipped worker archive in `/sandbox` and installs the `worker` launcher                                                                      |
| `apps/worker/src/run-task/create-harness.ts`                      | Harness creation with MCP config injection                                                                                                                 |
| `apps/worker/tsup.config.ts`                                      | Worker bundling config (includes roomote-mcp-server build)                                                                                                 |
| `packages/types/src/environment-config.ts`                        | EnvironmentMcpServers schema definition                                                                                                                    |
| `scripts/build-worker-release.sh`                                 | Worker release packaging for `dist/` and packaged skills                                                                                                   |

## Best Practices

### Adding a New Built-in MCP

1. Add entry to `BUILT_IN_MCPS` in setup-mcps.ts
2. If stdio: inject required env vars in `resolveBuiltInMcpServers()`
3. If remote HTTP: ensure CORS headers allow streamable-http transport
4. Update this documentation

### Adding an Integration MCP

1. Decide whether the integration is an upstream proxy or a native API-hosted MCP surface
2. Create the handler in `apps/api/src/handlers/mcp/<provider>.ts` or `apps/api/src/handlers/mcp/<provider>/`
3. For upstream proxies, implement `resolveCredentials()` and wire `createMcpProxy()`
4. For native integrations, implement the MCP JSON-RPC server locally and keep secrets on the API side
5. Register the worker-facing route in `apps/api/src/handlers/mcp/index.ts`
6. Add catalog metadata and worker config generation so `sdk.mcpConnections.getMcpServerConfigs()` can surface it
7. Update this documentation

### Configuring Environment MCPs

1. Add `mcpServers` section to environment YAML
2. Choose transport: `url` + optional `headers` for HTTP, or `command` + `args` + `env` for stdio
3. Avoid name conflicts with reserved MCP names (roomote, linear, plus any enabled curated integration ids)
4. For stdio servers, ensure command is available in worker PATH or use `npx -y <package>`

### Debugging MCP Issues

1. Check worker logs for `resolveBuiltInMcpServers`, `getMcpServerConfigs`, and harness-start messages.
2. For `opencode-server`, inspect the generated `~/.config/opencode/opencode.json` and the `[opencode-server]` startup logs to confirm the expected MCP entries were normalized into the owned config.
3. For browser automation: verify `command -v agent-browser` resolves to the wrapper (normally `~/.local/bin/agent-browser`), confirm the worker browser cache path is present, and inspect whether preview cookies were seeded for the active `--session`.
4. For integration MCPs: check API proxy logs such as `[MCP Proxy:Linear]` / `[MCP Proxy:GitHub]`.
5. For auth issues: verify `ROOMOTE_CLOUD_TOKEN` is present and valid.
6. For stdio MCPs: ensure `MISE_DATA_DIR` / `MISE_CACHE_DIR` are present when required and that the referenced runtime binaries are available in PATH.

## Security Considerations

### OAuth Token Handling

- Linear tokens are refreshed automatically when expired
- GitHub tokens are scoped to installation permissions
- All MCP proxy endpoints require valid job token or user auth token

### Tool Filtering (Router Context)

When MCPs are used by the LLM router (pre-job context gathering):

- `allowAuthTokens: true` permits user auth tokens
- `allowedToolNames` restricts which tools can be invoked
- Batch JSON-RPC requests are blocked to prevent bypass
- Tool filtering applies to both `tools/list` (filters response) and `tools/call` (rejects unauthorized)

### Auth Bypass

The `ROOMOTE_AUTH_BYPASS_VALUE` mechanism allows worker-side browser automation to access authenticated previews:

- Value is generated per-task (random or user-defined in environment config)
- Scoped to preview domains only (never sent to external services)
- Cookie-based (not headers) to avoid CORS preflight issues on cross-origin requests
- Propagated through both worker env injection and the `agent-browser` wrapper so the same bypass works for fresh launches and resumed tasks

### Environment MCP Isolation

- Custom environment MCPs cannot override built-in servers (name collision prevention)
- Stdio MCPs inherit minimal environment + explicitly injected vars only
- No shell expansion in command/args (executed directly via spawn)
