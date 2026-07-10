---
title: Webhook Handlers
status: active
last_reviewed: 2026-07-10
owner: engineering
summary: Technical documentation of webhook handlers for GitHub, GitLab, Azure DevOps, Slack, Teams, Telegram, and Linear covering endpoints, event types, verification, and processing patterns.
---

# Webhook Handlers

Roomote processes webhooks from GitHub, GitLab, Azure DevOps, Slack, Teams, Telegram, and Linear to trigger automated agent tasks and handle real-time events. All canonical webhook handlers are implemented in `apps/api/src/handlers/` using Hono routers.

Local Roomote runs expose a single public web URL through `ROOMOTE_PUBLIC_URL`.
The web catch-all route at
`apps/web/src/app/api/webhooks/[...path]/route.ts` forwards `/api/webhooks/*`
requests from that public URL to the API service at `Env.TRPC_URL`, preserving
the raw request body for provider signature verification. Production self-host
Caddy routes `/_roomote-api/api/webhooks/*` on `ROOMOTE_APP_DOMAIN` directly to
`apps/api` after stripping `/_roomote-api`. Provider app settings should use
those explicit API-prefixed webhook paths even though the canonical handlers
live in `apps/api`.

## Architecture Overview

All webhook handlers follow common patterns:

1. **Request verification** — HMAC signature validation with timing-safe comparison
2. **Idempotency** — Atomic deduplication using database INSERT ... ON CONFLICT or Redis SET NX
3. **Error handling** — Structured logging; GitHub/Linear persist webhook audit rows, Slack relies on Redis deduplication without webhook-row persistence
4. **Provider-specific execution** — some branches acknowledge immediately and continue asynchronously, while others complete handler logic before returning

## GitHub Webhooks

### Endpoint

**Route:** `POST /api/webhooks/github`
**Handler:** `apps/api/src/handlers/github/index.ts`

### Signature Verification

Uses `@octokit/webhooks` for automatic verification:

- **Header:** `x-hub-signature-256`
- **Algorithm:** HMAC-SHA256
- **Secret:** `Env.GITHUB_WEBHOOK_SECRET`
- **Delivery ID:** `x-github-delivery` (for idempotency)
- **Event type:** `x-github-event`

The Webhooks SDK automatically validates signatures via `webhooks.verifyAndReceive()`. Invalid signatures return 401.

### Event Types Handled

All events are registered via `.on(event, handler)` and wrapped in `recordWebhook()` for idempotency:

| Event                                 | Handler                      | Purpose                                                                                                                                                                                                  |
| ------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `installation.created`                | `handleInstallationCreated`  | Onboard new GitHub App installation                                                                                                                                                                      |
| `issue_comment.created`               | `handlePrComment`            | Start or continue PR-comment driven GitHub tasks, but only when the issue is actually a pull request; Roomote review-summary comments with terminal results also schedule a review-feedback notification |
| `issue_comment.edited`                | (inline handler)             | Detect Roomote review-summary comments whose status was patched to terminal results and schedule a review-feedback notification to the owning task's originating conversation                            |
| `pull_request.opened`                 | `handlePrOpen`               | Trigger PR review agents and update PR facts                                                                                                                                                             |
| `pull_request.reopened`               | `handlePrReopen`             | Re-trigger PR review on reopen and refresh PR facts                                                                                                                                                      |
| `pull_request.synchronize`            | `handlePrSynchronize`        | Review new commits in an existing PR and refresh PR facts                                                                                                                                                |
| `pull_request.ready_for_review`       | `handlePrReadyForReview`     | Review a draft PR when it is marked ready and sync it back to open status                                                                                                                                |
| `pull_request.converted_to_draft`     | (inline handler)             | Update synced PR status to `draft` without starting review work                                                                                                                                          |
| `pull_request_review_comment.created` | `handlePrComment`            | Start or continue GitHub review-comment driven tasks on PR diffs; non-mention comments also schedule a review-feedback notification to the owning task's originating conversation                        |
| `pull_request_review.submitted`       | `handlePrComment`            | Handle explicit `@roomote` review follow-ups; non-mention reviews also schedule a review-feedback notification to the owning task's originating conversation                                             |
| `pull_request.closed`                 | `handlePrMerge`              | Update PR status and notify linked Slack, Teams, Telegram, and Linear conversations when a PR is merged                                                                                                  |
| `push`                                | `handlePushConflictCheck`    | Detect merge conflicts after pushes to branches used as PR bases, then enqueue conflict resolution only for idle labeled PRs that actually conflict                                                      |
| `workflow_run.completed`              | `handleWorkflowRunCompleted` | Launch an immediate CI failure triage scan when a workflow run fails on a default branch (beta `ci_failure_triage` automation; debounced per org/repo, records `triggerKind: 'webhook'`)                 |

### Key Handler Files

**Code Review Flow:**

- `handlePrOpen.ts` — Initial PR review (checks `reviewOnCommit` and `reviewDraftPrs` settings)
- `handlePrSynchronize.ts` — Re-review on new commits
- `handlePrReadyForReview.ts` — Review when draft becomes ready
- `handlePrReopen.ts` — Re-review on PR reopen
- `handlePrComment.ts` — Handle both `issue_comment.created` and `pull_request_review_comment.created` task entry paths

**Merged PR Flow:**

- `handlePrMerge.ts` — Update merge status and notify Slack, Teams, Telegram, and Linear conversations linked to the merged PR. `notifySlackPrMerge` and `notifyTeamsPrMerge` are GitHub-scoped (they link the PR via `taskPullRequests` filtered to the `github` provider and the GitHub installation gate). `notifyTelegramAndLinearPrMerge` is provider-neutral: it links the merged PR to cloud jobs across every source control provider (GitHub, GitLab, Gitea, Azure DevOps) by repository name and PR number, then posts the merge message to each Telegram chat via `postTelegramMessageBestEffort` and each Linear agent session via a closing `LinearClient.emitResponse` activity. The GitLab, Gitea, and Azure DevOps merge handlers mirror the same fire-and-forget notifier set after verifying the repository is an active synced row.

**Review-Feedback Slack Notifications:**

- `notifyPrReviewActivity.ts` — Classify non-mention `pull_request_review.submitted` and `pull_request_review_comment.created` events (skipping `@roomote` mentions, synthetic empty `commented` review wrappers, and Roomote-authored replies to existing threads) and schedule a debounced, notification-only message to the originating conversation (Slack, Teams, or Telegram) of the task that owns the PR via `enqueuePrReviewNotification()` with a 1-minute debounce window; delivery waits until the task is idle and asks the user whether they want follow-up action (see the PR Review Notification Queue in [`redis-queues.md`](../architecture/redis-queues.md)). Also classifies `issue_comment.created`/`issue_comment.edited` events on PRs that are Roomote `roomote-review-summary` comments with a terminal status (reviews post the summary in "in progress" form and patch in the results, so the terminal content usually arrives via the edit) into `review_summary` notification events, deduplicated per comment and review head SHA so later checklist edits do not re-notify

**Conflict Resolution:**

- `handlePushConflictCheck.ts` — Detect labeled PRs whose base branch just changed and enqueue conflict resolution when the PR is idle and genuinely conflicting
- `conflict-resolution/` — Conflict detection, candidate discovery, mergeability checks, and idle-branch gating

**Utilities:**

- `getGitHubAutomationTargets.ts` — Resolve active repository automation targets
- `recordWebhook.ts` — Idempotent webhook processing wrapper

### Idempotency Pattern

`recordWebhook()` uses `INSERT ... ON CONFLICT DO NOTHING` on the `webhooks` table. It defaults the audit provider to `github` and accepts a provider override for future source-control webhook handlers such as GitLab:

```typescript
// Atomically claim deliveryId before executing handler
const [result] = await db
  .insert(webhooksTable)
  .values({ deliveryId, provider: 'github', event, payload })
  .onConflictDoNothing()
  .returning({ id: webhooksTable.id });

if (result === undefined) {
  return; // Already processed by another request
}

// Execute handler and update status
const response = await handler();
await db.update(webhooksTable).set({
  succeededAt: response.status === 'ok' ? new Date() : null,
  failedAt: response.status === 'error' ? new Date() : null,
});
```

This gives exactly-once handler execution for duplicate deliveries when the delivery-row claim succeeds.

GitLab and Azure DevOps webhook ingestion reuse this idempotency wrapper with
provider overrides (`{ provider: 'gitlab' }` / `{ provider: 'ado' }`) so
duplicate deliveries share the same webhook audit semantics as GitHub.

### Repository Filtering

`isRepoSkipped()` from `@roomote/github` checks if a repository should be ignored (e.g., internal test repos).

### PR Status Sync

The `syncPrStatus()` helper updates task metadata when PR state changes:

- `open` — PR opened or marked ready
- `draft` — PR converted to draft
- `merged` — PR merged
- `closed` — PR closed without merge

This is a fire-and-forget operation that logs errors but never throws.

## GitLab Webhooks

### Endpoint

**Route:** `POST /api/webhooks/gitlab`
**Handler:** `apps/api/src/handlers/gitlab/index.ts`

### Request Verification

GitLab verification is implemented in `apps/api/src/handlers/gitlab/verifyWebhook.ts`.

- **Signed webhook headers:** `webhook-id`, `webhook-timestamp`, `webhook-signature`
- **Signed webhook secret:** `GITLAB_WEBHOOK_SIGNING_TOKEN`
- **Signed webhook algorithm:** HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{rawBody}`
- **Timestamp tolerance:** 300 seconds (5 minutes)
- **Legacy token header:** `x-gitlab-token`
- **Legacy token secret:** `GITLAB_WEBHOOK_SECRET`

Both secrets resolve through `resolveDeploymentEnvVar`: process env values win, and encrypted `environment_variables` rows (saved by `/setup`, Settings, or GitLab webhook auto-setup during repository sync) are the fallback. When `GITLAB_WEBHOOK_SIGNING_TOKEN` is configured, signed webhook verification is preferred. When it is not configured, Roomote accepts the GitLab secret-token header. Invalid signatures or tokens return 401.

### Event Types Handled

| Event                                                 | Handler              | Purpose                                                                              |
| ----------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `Merge Request Hook` with `open` / `reopen`           | `handleMergeRequest` | Enqueue initial GitLab MR review when Review Code automation targets the repository. |
| `Merge Request Hook` with `update` and `oldrev`       | `handleMergeRequest` | Enqueue a delta MR review for new commits.                                           |
| `Merge Request Hook` with `close` / `merge`           | `handleMergeRequest` | Update linked PR/MR task status.                                                     |
| `Note Hook` on a `MergeRequest` mentioning `@roomote` | `handleNote`         | Route the MR comment into the active MR task or start a new MR review task.          |
| Other events                                          | inline router branch | Record and acknowledge as unsupported without launching work.                        |

GitLab MR review tasks use the existing PR review cloud task types with `sourceControlProvider: 'gitlab'`, GitLab MR URLs, source branch, target branch, and SHA. The payload also fills the shared checkout `branch` and `sha` fields from GitLab's `source_branch` and `last_commit.id` so worker workspace preparation inspects the MR source branch rather than the repository default branch. The cloud-agent workflow branches before GitHub API usage and instructs the harness to use git diff commands rather than GitHub-only CLI commands.

### Merge Request Note Mentions

`Note Hook` deliveries are the GitLab mirror of GitHub's `handlePrComment` path. The handler in `apps/api/src/handlers/gitlab/handleNote.ts` only acts on merge-request notes (`object_attributes.noteable_type === 'MergeRequest'`) whose body contains a case-insensitive `@roomote` mention, and it ignores anything but `create` note actions.

Loop protection: notes are skipped when the author username is Roomote-prefixed, matches a `project_<id>_bot` / `group_<id>_bot` project-access-token identity, or matches the deployment token identity. The deployment identity is resolved once through `getGitLabDeploymentUser()` (a cached `GET /user` call keyed by token value in `packages/gitlab/src/api.ts`) so repeated deliveries do not re-hit the GitLab API.

Routing reuses the provider-neutral `findReusableGitHubPrFollowUpOwner()` lookup keyed on repository full name and MR `iid`. When a reusable owner task exists, the note is delivered with `steerMessageToTask()` if the task is actively running and `sendMessageToTask()` (which resumes from snapshot when needed) otherwise, both with `senderMode: 'github_pr_follow_up'`. When there is no reusable owner (or delivery fails), the handler checks `findActiveGitHubPrReviewTask()` (keyed on repo + MR `iid` + head SHA) and links to the existing review instead of enqueuing a duplicate — the same dedup GitHub's `handlePrComment` applies. Only when no review is already running for the head SHA does it enqueue a `GithubPrReview` cloud task with `sourceControlProvider: 'gitlab'`, the same way `handleMergeRequest` does. Because a mention is an explicit request, target resolution passes `ignoreAuthorPolicy: true` to `getGitLabAutomationTargets()` so the MR-author allowlist does not block the mention. Explicit PR/MR comment mentions now also require the commenter to have a linked source-control account: GitHub comments require a `github_user_mappings` match for the webhook sender's stable numeric id, and GitLab notes require a Better Auth `auth_accounts` row with `provider_id = 'gitlab'` whose `account_id` matches the note author's stable numeric GitLab user id from the webhook. When the sender is not linked, Roomote replies on the PR/MR with a link-account instruction instead of starting work.

The handler always posts an acknowledgement note back on the MR through `createGitLabMergeRequestNote()` (deployment token, `POST /projects/:id/merge_requests/:iid/notes`): a task link on success, or a short "could not start" message when target resolution or task startup fails.

### Repository And Automation Targeting

GitLab webhooks resolve active repositories through `repositories.source_control_provider = 'gitlab'`, matching by GitLab project ID (`externalRepoId`) first and `path_with_namespace` second. Automatic MR review still attributes to the repository row's `linkedByUserId`, while explicit MR comment mentions attribute to the linked GitLab user who triggered the note. Roomote-authored GitLab MRs are allowed by username prefix. The Review Code `reviewAllPullRequestAuthors` setting widens automatic review to MRs opened by authors outside Roomote.

## Azure DevOps Webhooks

### Endpoint

**Route:** `POST /api/webhooks/ado`
**Handler:** `apps/api/src/handlers/ado/index.ts`

### Request Verification

Azure DevOps verification is implemented in
`apps/api/src/handlers/ado/verifyWebhook.ts`.

- **Secret:** `ADO_WEBHOOK_SECRET`
- **Accepted custom header:** `x-roomote-webhook-secret`
- **Accepted Basic auth:** username `roomote`, password `ADO_WEBHOOK_SECRET`

The repository sync path creates web-hook consumer subscriptions with both the
custom header and Basic-auth credentials. Invalid secrets return 401.

### Event Types Handled

| Event                                                                      | Handler                | Purpose                                                                                            |
| -------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| `git.pullrequest.created`                                                  | `handleAdoPullRequest` | Enqueue initial Azure DevOps PR review when Review Code automation targets the repository.         |
| `git.pullrequest.updated` with `notificationType=PushNotification`         | `handleAdoPullRequest` | Enqueue a delta PR review for source-branch updates.                                               |
| `git.pullrequest.updated` with `notificationType=StatusUpdateNotification` | `handleAdoPullRequest` | Update tracked task PR status for abandoned or completed PRs and notify connected conversations.   |
| `ms.vss-code.git-pullrequest-comment-event`                                | `handleAdoComment`     | Route `@roomote` PR comment mentions into reusable PR tasks or start a new Azure DevOps PR review. |
| `git.pullrequest.merged` and other events                                  | inline router branch   | Record and acknowledge as unsupported without launching work.                                      |

Azure DevOps exposes both source-branch updates and status updates through the
same `git.pullrequest.updated` event ID. Roomote's service-hook setup adds the
`notificationType` query parameter to the webhook URL so the handler can
distinguish source updates from status updates. Merge-attempted
`git.pullrequest.merged` hooks are deliberately not configured for automation
because Azure DevOps also emits completed status updates.

### Pull Request Comment Mentions

`ms.vss-code.git-pullrequest-comment-event` deliveries are the ADO mirror of
GitLab/Gitea PR comment mention handling. The handler only acts on text
comments whose content contains a case-insensitive `@roomote` mention. It skips
comments authored by Roomote-prefixed ADO identities or by the current
deployment token identity resolved from ADO connection data.

Routing first resolves the active synced ADO repository and environment mapping
with `ignoreAuthorPolicy: true`, because the mention is an explicit request.
The same target resolution also requires a Better Auth `auth_accounts` row with
`provider_id = 'ado'` whose `account_id` matches the webhook comment author's
stable ADO identity id, resolved during linked-account auth from
`connectionData.authenticatedUser.id`. If the commenter is not linked, Roomote
replies with a Linked Accounts instruction and does not start work. When the
commenter is linked, the handler reuses the provider-neutral
`findReusableGitHubPrFollowUpOwner()` lookup to deliver follow-up text into an
existing PR task through `steerMessageToTask()` or `sendMessageToTask()`. If
there is no reusable owner, it checks `findActiveGitHubPrReviewTask()` for the
same PR/head SHA and posts an ADO comment linking to that review rather than
enqueuing a duplicate. Only when no review is already running does it enqueue
`TaskPayloadKind.GithubPrReview` with `sourceControlProvider: 'ado'`.

Acknowledgement comments are posted through
`createAdoPullRequestComment()` in `packages/ado/src/api.ts`. When the webhook
payload includes a thread link, Roomote replies to the existing ADO comment
thread; otherwise it creates a new active pull request thread. Explicit ADO
comment mentions are attributed to the linked ADO commenter account; automatic
PR-created and source-update reviews still attribute to the synced repository
row owner.

### Repository And Automation Targeting

ADO webhooks resolve active repositories through
`repositories.source_control_provider = 'ado'`, matching by Azure DevOps
repository UUID (`externalRepoId`) first and `<organization>/<project>/<repo>`
second. Review Code automation still requires an active environment mapping for
the synced repository. The cloud-agent PR review workflow branches on
`sourceControlProvider = 'ado'` and avoids GitHub-only commands in generated
review instructions.

## Slack Webhooks

### Endpoint

**Route:** `POST /api/webhooks/slack`
**Handler:** `apps/api/src/handlers/slack/index.ts`

### Request Verification

**Verification function:** `verifySlackRequest()` in `apps/api/src/handlers/slack/verifySlackRequest.ts`

- **Signature header:** `x-slack-signature`
- **Timestamp header:** `x-slack-request-timestamp`
- **Algorithm:** HMAC-SHA256
- **Secret:** `Env.SLACK_SIGNING_SECRET`
- **Timestamp tolerance:** 300 seconds (5 minutes)

Verification steps:

1. Extract signature version and hex value from header (`v0=<hex>`)
2. Parse and validate timestamp (must be within 5 minutes)
3. Compute `basestring = "v0:{timestamp}:{rawBody}"`
4. Calculate expected signature via HMAC-SHA256
5. Compare signatures using `timingSafeEqual()` to prevent timing attacks

Invalid signatures return 401.

### Event Types

#### Events API (`event_callback`)

**URL verification:** Returns `challenge` parameter for initial endpoint verification

**Message events:**

| Event Type    | Channel Type          | Handler                         |
| ------------- | --------------------- | ------------------------------- |
| `app_mention` | Any                   | Create or resume task in thread |
| `message`     | Direct message (`im`) | Create or resume task in thread |

**Reaction events:**

| Event Type       | Purpose                                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reaction_added` | Handle tracked setup-suggestion launches and coach recommendation launches from `:+1:` / `:thumbsup:` reactions first, then optionally treat the org-configured summon emoji as a new Slack task start from the reacted source message |

**Membership events:**

| Event Type              | Purpose                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `member_joined_channel` | Detect the first time Roomote's bot user is added to a channel and post the capped in-channel welcome |

**Link unfurling:**

| Event Type                 | Purpose                                     |
| -------------------------- | ------------------------------------------- |
| `link_shared`              | Unfurl Roomote task URLs with rich metadata |
| `entity_details_requested` | Provide entity details for unfurled tasks   |

**Workflow Builder custom steps:**

| Event Type          | Purpose                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `function_executed` | Acknowledge Slack immediately, then start a Roomote task from a workflow-provided prompt when `callback_id` is `start_roomote_task`, optionally attach it to an existing Slack thread, and complete the step in the background |

#### Interactive Payloads (`block_actions`)

Sent as `application/x-www-form-urlencoded` with JSON in `payload` field:

| Action ID                                       | Handler                                      | Purpose                                                            |
| ----------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `submit_task`                                   | `handleTaskConfiguration`                    | Start task with selected agent/workspace                           |
| `cancel_task`                                   | `handleTaskCancellation`                     | Cancel a pending or running task from the started-message controls |
| `retry_failed_task`                             | `handleRetryFailedTask`                      | Restart a failed task from the Slack thread                        |
| `connect_account`                               | `handleConnectAccount`                       | Link a Slack user to a Roomote account                             |
| `routing_confirm_ok`                            | `handleRoutingConfirmOk`                     | Accept an LLM routing suggestion                                   |
| `routing_confirm_no`                            | `handleRoutingRejectNo`                      | Reject an LLM routing suggestion                                   |
| `mcp_setup_configure`                           | `handleSlackMcpSetupConfigure`               | Open the in-thread MCP setup interruption flow                     |
| `mcp_setup_ignore`                              | `handleSlackMcpSetupIgnore`                  | Dismiss the in-thread MCP setup interruption                       |
| `manager_mcp_setup_configure`                   | `handleManagerMcpSetupConfigure`             | Accept the manager-driven MCP setup prompt                         |
| `manager_mcp_setup_no_thanks`                   | `handleManagerMcpSetupNoThanks`              | Dismiss the manager-driven MCP setup prompt                        |
| `bg_agent_onboarding_configure`                 | background-agent onboarding handler          | Accept the background-agent onboarding DM prompt                   |
| `bg_agent_onboarding_nevermind`                 | background-agent onboarding handler          | Dismiss the background-agent onboarding DM prompt                  |
| `suggested_tasks_onboarding_followup_configure` | suggested-tasks onboarding follow-up handler | Accept the suggested-tasks DM follow-up prompt                     |
| `suggested_tasks_onboarding_followup_ignore`    | suggested-tasks onboarding follow-up handler | Dismiss the suggested-tasks DM follow-up prompt                    |
| `toggle_roomote_reply_details`                  | `handleThreadReplyDetailsToggle`             | Expand or collapse structured reply details in-thread              |
| `nevermind_task`                                | `handleNevermind`                            | Abandon routing confirmation                                       |
| `followup_answer_*`                             | `handleFollowupAnswer`                       | Answer legacy elicitation questions                                |
| `request_user_input_answer_*`                   | `handleFollowupAnswer`                       | Answer modern structured `request_user_input` prompts              |
| `request_user_input_cancel`                     | `handleFollowupAnswer`                       | Cancel a structured `request_user_input` prompt                    |
| `agent_selection`                               | (no-op)                                      | Agent picker interaction                                           |
| `workspace_selection`                           | (no-op)                                      | Workspace picker interaction                                       |
| `follow_task`                                   | (no-op)                                      | Task subscription toggle                                           |

### Event Deduplication

Slack retries events if response takes >3 seconds. The Slack handler uses Redis at two levels:

```typescript
const dedupKey = `slack:event:${eventId}`;
const claimed = await redis.set(
  dedupKey,
  '1',
  'EX',
  3600, // 1 hour TTL
  'NX', // Only set if not exists
);

if (!claimed) {
  return c.json({ ok: true }); // Already processed
}
```

For fresh task routing, the handler also claims `slack:routing-lock:{threadId}` with `SET ... NX EX 60` immediately before `processNewTaskConfiguration()` is kicked off. That thread-scoped lock prevents duplicate `app_mention` events with different `event_id` values, such as message-edit replays, from starting parallel routing flows on the same Slack thread, and the summon-reaction path reuses that same lock once it has resolved the reacted message back to a Slack thread root.

### Message Processing Flow

1. **Workflow-step start** — `function_executed` custom-step events claim event dedupe, acknowledge Slack with `{ ok: true }`, then continue in the background: parse the workflow `prompt` plus required `channel_id` and optional `message_ts` / `prompt_author_id` inputs, use `slack_installations.installed_by_user_id` as the job-token owner while leaving the initial `task_runs.acting_user_id` unset, auto-route and start the routed workspace without Slack confirmation UI, then finish the step with `task_id` / `task_url` outputs or a workflow-step error. If `message_ts` is omitted, Roomote first posts a top-level kickoff message and uses that new message as the thread root for later replies. Function completion uses the per-execution workflow token first and falls back to the installed bot token; if both attempts fail, the failure is logged without releasing the event dedupe claim. Successful completions are cached by `function_execution_id` so a later duplicate delivery can re-complete the workflow step without starting another Roomote task.
2. **Automated app mention start** — `app_mention` events authored by another Slack app now auto-route for every org unless they were authored by Roomote itself. The handler uses `slack_installations.installed_by_user_id` as the launch user, uses the installer Slack mapping or bot user as the Slack sender, acquires the thread routing lock, and auto-routes without the interactive account-linking/configuration UI. Because that surface has no in-thread human `Configure` / `Ignore` affordance, it bypasses the Slack MCP setup interruption gate that still applies to the normal human-authored Slack routing flow.
3. **Summon reaction start** — `reaction_added` events first give tracked setup-suggestion launches and coach recommendation launches (`:+1:` / `:thumbsup:`) priority. Otherwise, when the reaction name matches the org-configured summon emoji, the handler fetches the reacted source message, ignores inaccessible, bot-authored, or self-reacted sources, synthesizes a Slack-style entry event, and reuses the standard task-entry path against the source message's thread root.
4. **Active job check** — If a non-terminal job already exists in the resolved thread, queue the message for the worker without adding the temporary acknowledgement reaction; this includes jobs that are still booting, so follow-up thread replies do not wait for the worker machine to finish starting.
5. **Routing/start acknowledgment** — Otherwise add the org-configured acknowledgement reaction while routing or task startup is still pending. The default remains `:eyes:`.
6. **Pending confirmation check** — If routing confirmation exists, process correction.
7. **Snapshot resume** — If a completed job has a snapshot, create a `SnapshotResume` job.
8. **New task** — Acquire the thread-scoped routing lock, then show task configuration UI or auto-route via LLM.

The `app_mention`, DM message, and workflow-step branches acknowledge quickly and continue follow-up work asynchronously. Interactive payloads and unfurl/entity-detail requests are handled inline in the webhook request.

`member_joined_channel` is handled inline because it is a short, self-contained path: the handler records the channel in `slack_installation_channels`, ignores re-adds of previously seen channels, and posts the workspace welcome only for the first three distinct channels that Roomote joins.

### Background Processors

**`processActiveJobMessage()`** — Queue message for running worker

**`processNewTaskConfiguration()`** — Route task via LLM or show UI, schedule auto-confirm timer

**`processRoutingCorrection()`** — Re-route when user corrects LLM suggestion

**`processSnapshotResume()`** — Resume from completed job's snapshot using `withContention()` for leader election

### Auto-Confirmation

When LLM routing posts a confirmation message, a timer schedules auto-confirm after `SLACK_AUTO_CONFIRM_TIMEOUT_MS` (30 seconds). If the user replies with a correction, a new confirmation is posted with a fresh nonce, invalidating the old timer.

## Teams Webhooks

### Endpoint

**Route:** `POST /api/webhooks/teams`
**Handler:** `apps/api/src/handlers/teams/index.ts`

### Request Verification

The Teams endpoint is a direct Microsoft Bot Framework callback endpoint. It requires a Bot Framework `Authorization: Bearer ...` JWT and validates it before any queueing or task launch:

- The Bot Framework OpenID metadata is loaded from `https://login.botframework.com/v1/.well-known/openidconfiguration`.
- The JWT signature is verified against the published JWKS with `RS256`.
- The issuer must be `https://api.botframework.com`.
- The audience must match `Env.TEAMS_BOT_APP_ID`.
- The token must be within its validity window, allowing the Bot Framework clock-skew tolerance.
- The token `serviceUrl` claim must match the incoming Activity `serviceUrl`.
- When the selected JWK advertises endorsements and the Activity has a `channelId`, the key must be endorsed for that channel.

If `TEAMS_BOT_APP_ID` is not configured, the route returns 503. Invalid or missing Bot Framework JWTs return 401.

### Event Types Handled

| Activity Type | Purpose                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `message`     | Normalize Teams text into a provider-neutral message, then queue it to an active job, resume a snapshot, or start a task. |
| Other types   | Acknowledge without queueing until Teams onboarding or non-message behavior is implemented.                               |

### Processing Flow

1. Parse the activity with `packages/communication/src/teams-activity.ts`.
2. Verify the direct Bot Framework JWT against the parsed Activity.
3. Upsert the Teams installation in `teams_installations` using tenant/team identity and the latest service URL, bot identity, conversation, channel, and activity timestamp.
4. Resolve a Roomote user mapping from `teams_user_mappings` using tenant plus Teams user ID or AAD object ID; when no mapping exists, seed one from an indexed `microsoft_auth_user_mappings` Microsoft Entra match if the Teams activity carries an AAD object ID.
5. Strip Teams `<at>...</at>` mention markup from message text and extract
   prompt-safe image attachments from direct `contentUrl`/`thumbnailUrl`
   fields or Teams file-card `content.downloadUrl` fields.
6. Deduplicate by Redis key `teams:activity:{activityId}` for 5 minutes.
7. Find the latest active cloud job whose payload has `communicationProvider: "teams"` or Teams aliases and whose conversation/thread identifiers match the activity.
8. If an active job exists, download extracted image attachments with the Bot
   Framework bearer token, convert them to `data:image/...;base64,...` prompt
   images, and queue the message with
   `queueCommunicationMessage("teams", cloudJobId, message)`. The queued
   message includes the mapped Roomote `userId` when present.
9. If no active job exists and the activity is a personal chat or bot mention, require a resolved Roomote user mapping before starting or resuming work. Unlinked users receive a Microsoft Teams DM with a short-lived `/api/teams/auth?state=...` link that stores the original Teams activity under `teams:auth:{token}` in Redis for 15 minutes. Channel/group threads receive a short public reply that the DM was sent. If the Bot Framework DM cannot be created from the activity service URL, tenant ID, and Teams user ID, Roomote posts non-resumable public instructions to open a personal chat instead of exposing the state-bearing link in the original thread.
10. For linked users, check for a completed matching job with a fresh snapshot.
    If one exists, download extracted image attachments and enqueue a
    `SnapshotResume` with the Teams message embedded in
    `queuedCommunicationMessages`.
11. If no resumable job exists, download extracted image attachments, route
    the Teams request with `buildTeamsRoutingContext()`, then enqueue a
    provider-neutral `StandardTask` with Teams communication metadata and
    `payload.images` when screenshots/images were present. If routing returns
    a platform answer, post that answer back to Teams without creating a task.

Teams payload matching uses provider-neutral fields (`communicationChannelId`, `communicationThreadId`, `communicationMessageId`) and Teams aliases (`teamsConversationId`, `teamsChannelId`, `teamsThreadId`, `teamsMessageId`). This lets Teams replies attach to active or resumed jobs without adding Teams-specific database columns.

Teams attachment URLs are not passed through to tasks directly because Bot
Framework attachment views often require connector bearer auth. The webhook
downloads them while handling the activity and passes only prompt-safe data
URLs into the task/queue payload.

Teams DMs use Bot Framework proactive messaging: `TeamsCommunicationProvider.postDirectMessage()` creates or gets a one-on-one conversation with the Teams user from the inbound activity's `serviceUrl`, tenant ID, and Teams user ID, then posts a normal message activity to that conversation.

The Teams auth callback lives in the web app at `GET /api/teams/auth`. It starts Microsoft Entra sign-in when no Roomote session exists, starts Better Auth account linking when the signed-in user still lacks a matching Microsoft Teams mapping, and then calls `POST /api/webhooks/teams/auth/resume`. The API resume endpoint reads the pending Redis token, verifies that the Teams sender now maps to a Roomote user, atomically consumes the token, and continues the saved activity through the same active-job, snapshot-resume, and fresh-task branches as the original webhook. If the mapping is still missing, the resume endpoint returns `account_link_required` without consuming the token.

## Telegram Webhooks

### Endpoint

**Route:** `POST /api/webhooks/telegram`
**Handler:** `apps/api/src/handlers/telegram/index.ts`

### Request Verification

The Telegram endpoint is a direct Bot API webhook endpoint. It requires the `X-Telegram-Bot-Api-Secret-Token` header and validates it with a timing-safe comparison before parsing or queueing update payloads:

- **Secret header:** `x-telegram-bot-api-secret-token`
- **Secret env var:** `Env.TELEGRAM_WEBHOOK_SECRET`
- **Outbound bot token:** `Env.TELEGRAM_BOT_TOKEN`

If `TELEGRAM_WEBHOOK_SECRET` is not configured, the route returns 503. Invalid or missing secret-token headers return 401.

### Event Types Handled

| Update Shape | Purpose                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `message`    | Normalize Telegram text into a provider-neutral message, then queue it to an active job, resume a snapshot, or start a task. |
| Other shapes | Acknowledge without queueing until non-message Telegram update behavior is implemented.                                      |

### Processing Flow

1. Verify the Telegram secret-token header.
2. Parse the update with `packages/communication/src/telegram-update.ts`.
3. Deduplicate by Redis key `telegram:update:{updateId}` for 5 minutes.
4. Resolve the sender's Roomote user from their Telegram account link (`resolveTelegramSenderUserId`). Attribution requires a link: unlinked senders never act as another user. A bare private-chat `/start` is welcomed (with the account-linking nudge for unlinked senders) even before the sender links, though primary-chat capture is skipped without a linked user. For every other message shape from an unlinked sender, post a best-effort "link your account" nudge in private chats, acknowledge the webhook with `reason: "telegram_sender_not_linked"`, and do not find active jobs, resume snapshots, start tasks, queue messages, or post further replies. If the linked auth user exists but the product `users` row does not, create it idempotently before launching or queueing.
5. Strip Telegram bot mentions or commands that only invoked the bot from the message text.
6. Find the latest active cloud job whose payload has `communicationProvider: "telegram"` and whose chat/thread identifiers match the update.
7. If an active job exists, queue the message with `queueCommunicationMessage("telegram", cloudJobId, message)`. The queued message includes the linked sender's `userId`.
8. If no active job exists and the update is a private chat message or a group message that mentions the bot, check for a completed matching job with a fresh snapshot. If one exists, enqueue a `SnapshotResume` with the Telegram message embedded in `queuedCommunicationMessages`.
9. If no resumable job exists, route the Telegram request with `buildTelegramRoutingContext()`, then enqueue a provider-neutral `StandardTask` with Telegram communication metadata. If routing returns a platform answer, post that answer back to Telegram without creating a task.

Telegram payload matching uses provider-neutral fields only: `communicationProvider`, `communicationChannelId`, `communicationThreadId`, and `communicationMessageId`. `communicationChannelId` maps to Telegram `chat.id`, `communicationThreadId` maps to Telegram forum `message_thread_id`, and `communicationMessageId` maps to the Telegram `message_id`.

## Linear Webhooks

### Endpoint

**Route:** `POST /api/webhooks/linear`
**Handler:** `apps/api/src/handlers/linear/index.ts`

### Signature Verification

**Verification function:** `verifyLinearWebhookSignature()` in `packages/linear/src/verify-webhook.ts`

- **Signature header:** `linear-signature`
- **Delivery ID header:** `linear-delivery` (for idempotency)
- **Algorithm:** HMAC-SHA256
- **Secret:** `Env.LINEAR_WEBHOOK_SECRET`

Verification uses timing-safe comparison (`timingSafeEqual()`).

**Timestamp validation:** `isWebhookTimestampValid()` checks webhook age:

- **Max age:** 5 minutes (default)
- **Future drift tolerance:** 60 seconds (clock skew)

Expired webhooks return 400.

### Event Types

**Only `AgentSessionEvent` webhooks are processed:**

| Action     | Description                         | Handler Behavior                                                                              |
| ---------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `created`  | Agent delegated to issue            | Route and create a new job (or start elicitation fallback)                                    |
| `create`   | Alternate create action from Linear | Same behavior as `created`                                                                    |
| `prompted` | Follow-up prompt in session         | Continue active jobs, process routing/elicitation responses, or route/resume/create as needed |

Other webhook types are logged and ignored.

### Agent Session Handling

The `handleAgentSessionEvent()` function:

1. **Installation/token checks** — Resolve active Linear installation and valid access token
2. **Signal check** — If `agentActivity.signal === 'stop'`, cancel the job
3. **User-link check** — Verify the Linear user is linked; emit auth elicitation when missing
4. **Prompted-branch checks** — For `prompted`, handle active jobs first, then routing confirmation responses, elicitation responses, and snapshot resume
5. **Routing** — Use LLM to select agent and workspace, then ask for confirmation
6. **Job creation** — Create cloud job on confirmation, or use elicitation fallback when routing is unavailable

### Webhook Idempotency

`recordLinearWebhook()` in `apps/api/src/handlers/linear/recordWebhook.ts` uses the same delivery-claim insert pattern, with an availability fallback:

```typescript
let insertedRecord: { id: string } | undefined;
let hadInsertError = false;

try {
  const [result] = await db
    .insert(webhooksTable)
    .values({
      deliveryId: webhookId,
      provider: 'linear',
      event: `agent_session.${action}`,
      payload,
    })
    .onConflictDoNothing()
    .returning({ id: webhooksTable.id });

  insertedRecord = result;
} catch {
  hadInsertError = true;
}

if (!hadInsertError && insertedRecord === undefined) {
  return; // Duplicate delivery
}

// Handler runs even when insert failed; DB status update only happens when
// insertedRecord exists.
```

The `linear-delivery` header guarantees unique identifiers across retries.

### Routing Confirmation Flow

Similar to Slack, Linear webhooks use Redis-backed routing confirmations:

**Storage:** `linear_routing_confirm:{sessionId}` (TTL: 180 seconds)

**Auto-confirmation:** Timer fires after `LINEAR_AUTO_CONFIRM_TIMEOUT_MS` (2 minutes)

**Lua script for atomic claim:**

```lua
-- CLAIM_CONFIRM_LUA: GET + DEL only if nonce matches
local val = redis.call('get', KEYS[1])
if not val then return nil end
local ok, data = pcall(cjson.decode, val)
if not ok then return nil end
if data.confirmNonce ~= ARGV[1] then return nil end
redis.call('del', KEYS[1])
return val
```

This prevents stale timers from consuming data from newer confirmation rounds.

## Common Patterns

### Request Verification Middleware

All webhooks verify requests before processing:

- **GitHub:** `@octokit/webhooks` SDK verifies `x-hub-signature-256`
- **Slack:** Custom `verifySlackRequest()` verifies `x-slack-signature` + timestamp
- **Teams:** Direct Bot Framework JWT validation verifies the bearer token, service URL, audience, issuer, and channel endorsement when present
- **Telegram:** Secret-token header validation verifies `x-telegram-bot-api-secret-token`
- **Linear:** Custom `verifyLinearWebhookSignature()` verifies `linear-signature` + timestamp

HMAC-based webhooks use SHA-256 signatures with `timingSafeEqual()` to prevent timing attacks. Token-based webhooks use provider-specific signature/JWT/header checks before payload processing.

### Idempotency Guarantees

Two deduplication strategies are used:

**Database-backed (GitHub, Linear):**

- Uses `INSERT ... ON CONFLICT DO NOTHING` with unique delivery IDs
- First request to insert wins and duplicate deliveries are skipped
- GitHub handlers are gated on a successful delivery-row claim
- Linear may still run handlers when DB insert fails (availability over strict dedup)
- Audit rows include status timestamps (`succeededAt`, `failedAt`) when persistence succeeds

**Redis-backed (Slack and Teams events):**

- Uses `SET key 1 EX <ttl> NX` with event/activity IDs
- First request to set wins, concurrent requests skip
- Slack event dedupe TTL expires after 1 hour; Teams activity dedupe TTL expires after 5 minutes for message delivery and task-entry activities

### Error Handling

Provider-specific handler functions (for example `handlePrOpen()` and `handleAgentSessionEvent()`) return a structured internal shape:

**Success response:**

```typescript
{ status: 'ok', message?: string, metadata?: Record<string, unknown> }
```

**Error response:**

```typescript
{ status: 'error', message: string }
```

Top-level HTTP webhook responses vary by provider (`{ ok: true }`, `{ message: 'webhook_processed' }`, or `{ error: ... }`).

Persistence and failure behavior differ by provider:

- **GitHub:** `recordWebhook()` must successfully claim a delivery row before the handler runs.
- **Linear:** `recordLinearWebhook()` can continue processing even if webhook audit persistence fails.
- **Slack:** deduplication is Redis-backed, so there is no pre-handler database insert to gate execution.

### Background Processing

Response timing depends on provider and event type:

1. **Slack `app_mention` / DM message flows** acknowledge quickly and hand off longer work asynchronously.
2. **Slack interactive payloads and unfurls** are handled inline.
3. **Teams message delivery and task entry** verifies the shared gateway secret, deduplicates by activity ID, then queues active-job replies, resumes snapshots, posts platform answers, or launches new tasks inline.
4. **GitHub and Linear** run their main handler pipelines inline after verification and idempotency checks.

This means webhook timeouts matter most for the Slack message-entry paths, where the code explicitly optimizes for early acknowledgment.

## Key Files Reference

### GitHub Handlers

- **Main router:** `apps/api/src/handlers/github/index.ts`
- **Verification:** `@octokit/webhooks` SDK (automatic)
- **Idempotency:** `apps/api/src/handlers/github/recordWebhook.ts`
- **Event handlers:** `apps/api/src/handlers/github/handle*.ts`
- **Utilities:** `apps/api/src/handlers/github/getGitHubAutomationTargets.ts`, `apps/api/src/handlers/github/recordWebhook.ts`

### Slack Handlers

- **Main router:** `apps/api/src/handlers/slack/index.ts`
- **Verification:** `apps/api/src/handlers/slack/verifySlackRequest.ts`
- **Event processors:** Inline functions in main router
- **Utilities:** `@roomote/slack` package (`SlackNotifier`, routing helpers)

### Linear Handlers

- **Main router:** `apps/api/src/handlers/linear/index.ts`
- **Verification:** `packages/linear/src/verify-webhook.ts`
- **Idempotency:** `apps/api/src/handlers/linear/recordWebhook.ts`
- **Event handler:** `handleAgentSessionEvent()` function in main router
- **Utilities:** `@roomote/linear` package (client, parsing, auth)

### Teams Handlers

- **Main router:** `apps/api/src/handlers/teams/index.ts`
- **Verification:** Direct Microsoft Bot Framework JWT verification against OpenID metadata/JWKS, issuer, audience, validity, service URL, and JWK channel endorsement when present
- **Idempotency:** Redis `teams:activity:{activityId}`
- **Utilities:** `@roomote/communication` package (`teams-activity`, `messages`, `TeamsCommunicationProvider`)

## Webhook Registration

Webhooks are registered in `apps/api/src/server.ts`:

```typescript
app.route('/api/webhooks/github', github);
app.route('/api/webhooks/slack', slack);
app.route('/api/webhooks/teams', teams);
app.route('/api/webhooks/telegram', telegram);
app.route('/api/webhooks/linear', linear);
```

External configuration:

- **GitHub:** Configure in GitHub App settings (webhook URL, secret); production self-host webhook URLs use `<public-url>/_roomote-api/api/webhooks/github`
- **Slack:** Configure in Slack App settings (event subscriptions, request URL); production self-host webhook URLs use `<public-url>/_roomote-api/api/webhooks/slack`
- **Teams:** Configure the Microsoft Bot Framework messaging endpoint to `POST <public-url>/_roomote-api/api/webhooks/teams`; requests must include Bot Framework bearer JWTs and `TEAMS_BOT_APP_ID` must be configured for audience validation
- **Telegram:** Configure the Bot API webhook endpoint to `POST <public-url>/_roomote-api/api/webhooks/telegram`; requests must include the configured secret-token header
- **Linear:** Configure per Linear organization (webhook URL, secret); production self-host webhook URLs use `<public-url>/_roomote-api/api/webhooks/linear`
