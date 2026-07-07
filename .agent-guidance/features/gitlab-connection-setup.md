---
title: GitLab Connection Setup
status: active
last_reviewed: 2026-07-08
owner: engineering
summary: Operator-facing setup guide for connecting GitLab (gitlab.com or self-managed) to Roomote through the deployment-token-backed integration path with automatic webhook setup, job-scoped repository tokens, and a deployment-token fallback for namespaces that cannot mint project access tokens.
---

# GitLab Connection Setup

Roomote's current GitLab integration is deployment-token backed. It does not yet
have a self-serve GitLab App or OAuth installation flow like GitHub. Operators
connect GitLab by providing a `GITLAB_TOKEN` and syncing accessible projects
from `/setup` or the Settings Source Control section. Saving the token
validates it against the GitLab `/user` API and rejects tokens that fail
authentication. The sync path then configures merge-request webhooks on the
synced projects automatically, generating and persisting a
`GITLAB_WEBHOOK_SECRET` encrypted deployment env var when one is not already
configured. Both `gitlab.com` and self-managed GitLab instances are supported;
set the optional `GITLAB_BASE_URL` to point Roomote at a self-managed host (it
defaults to `https://gitlab.com`).
Worker tasks do not receive that deployment-wide token directly. For each
GitLab-backed job, Roomote mints short-lived project access tokens scoped
to the exact selected repositories and revokes them when the job finishes.
When the namespace cannot mint project access tokens (on gitlab.com they
require a Premium or Ultimate subscription, so Free-tier groups always fail),
Roomote falls back to routing the deployment token through the worker-local
git credential proxy — the same mechanism Gitea and Azure DevOps use — so
task execution still works without exposing the raw token to task shells.

Use this page when setting up or debugging a deployment's GitLab connection. For
implementation details, see [GitHub Integration](./github-integration.md) and
[Webhook Handlers](../api/webhooks.md#gitlab-webhooks).

## Current Capability

The current path supports:

- validating `GITLAB_TOKEN` on save from `/setup` and Settings (definitive
  401/403 auth failures block the save; transient errors do not)
- syncing GitLab membership projects into provider-tagged `repositories` rows
  from `/setup` or Settings > Environments > Source Control
- connecting either `gitlab.com` or a self-managed GitLab instance selected by
  the optional `GITLAB_BASE_URL`
- automatic merge-request webhook creation during sync for synced projects
  that are mapped to at least one environment, with a generated
  `GITLAB_WEBHOOK_SECRET` persisted to encrypted deployment env vars when
  none is configured (webhooks also enable note events so `@roomote`
  MR-comment mentions reach Roomote); synced projects without an environment
  mapping are not hooked, and sync best-effort removes a previously created
  Roomote webhook from them so a broad membership token (for example a
  personal PAT that can also administer unrelated work projects) does not
  leak merge-request events to the deployment URL
- cloning GitLab repositories from the configured host with per-job, repo-scoped
  project access tokens minted from the deployment token
- falling back to deployment-token credentials through the worker-local git
  proxy when the namespace cannot mint project access tokens (for example
  gitlab.com Free-tier groups)
- launching GitLab-backed manual, environment, and repository-set tasks
- resolving `all_repositories` GitLab workspaces from synced GitLab repository rows
- receiving GitLab merge-request webhooks at `/api/webhooks/gitlab`, with
  webhook secrets resolved through the deployment env resolver (process env
  first, encrypted `environment_variables` rows as fallback)
- enqueueing Review Code automation for GitLab MR open/reopen/update events
- updating linked PR/MR task status on GitLab MR close/merge events
- routing `@roomote` mentions in GitLab MR comment notes into the active MR task
  or a new MR review task, with an acknowledgement note posted back on the MR
- optionally exposing a personal GitLab linked-account row in Settings > Linked
  Accounts when `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET` are configured,
  so MR commenters can link their identity before retrying an `@roomote` note
- notifying linked Slack and Teams threads when a GitLab MR merges (same
  notification path GitHub PR merges use)

The current path does not yet include:

- a GitLab OAuth or GitLab App installation flow
- a GitLab-specific repository permission delegation UI

GitLab comment-triggered follow-up now requires the MR commenter to link a
personal GitLab account in Settings > Linked Accounts. That personal linking
path is optional at the deployment level: when admins add `GITLAB_CLIENT_ID`
and `GITLAB_CLIENT_SECRET` alongside the existing GitLab token configuration,
Roomote shows a GitLab row in Linked Accounts and uses the linked GitLab user
identity to authorize `@roomote` MR notes. Without those OAuth credentials, automatic MR
review still works, but comment-triggered follow-up replies with instructions to
link an account and notes that an admin may need to finish the OAuth setup.

## Required GitLab Access

Create a dedicated GitLab bot or service-account identity for the Roomote
deployment. Add that identity to the GitLab groups or projects Roomote should
access.

Create an access token for that identity with scopes appropriate to the intended
behavior:

| Scope              | Needed for                                       |
| ------------------ | ------------------------------------------------ |
| `api`              | project listing and repository sync through REST |
| `read_repository`  | cloning private repositories over Git-over-HTTPS |
| `write_repository` | pushing branches or commits from Roomote tasks   |

Prefer a token owned by a bot/service account rather than a human user so token
rotation, offboarding, and repository access are deployment-owned.
Roomote's worker path prefers a personal access token or equivalent bot token
that can mint project access tokens through the GitLab API. When minting is
denied (GitLab returns 400/403/404 — on gitlab.com project access tokens
require a Premium or Ultimate subscription, so Free-tier namespaces always
fail), Roomote automatically falls back to using the deployment token itself,
scoped through the worker-local git credential proxy so the raw token is not
written into task-readable credential files. Webhook auto-creation requires
the token identity to hold at least the Maintainer role on each project;
projects where that fails are reported in the sync result without failing
the sync.

GitLab reference docs:

- [Personal access tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/)
- [Project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/)
- [Webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/)

## Configure Roomote

Provide `GITLAB_TOKEN` to Roomote through one of the supported token sources:

1. Process environment variable named `GITLAB_TOKEN`.
2. Encrypted Roomote environment variable named `GITLAB_TOKEN`.

The sync path resolves the token in
[`packages/gitlab/src/api.ts`](../../packages/gitlab/src/api.ts), preferring
`process.env.GITLAB_TOKEN` and then encrypted environment variables. The worker
bootstrap path uses that deployment token server-side to mint short-lived,
project-scoped GitLab access tokens for the selected repositories and writes
only those scoped credentials into the worker-managed Git credential helper
under `~/.roomote/`. The raw deployment token is not exported into task shells.

### Self-managed instances (`GITLAB_BASE_URL`)

`GITLAB_BASE_URL` is optional and defaults to `https://gitlab.com`. Set it to
the base URL of a self-managed GitLab instance (for example
`https://gitlab.example.com`) to route every GitLab API call, minted credential
host, and repository fallback URL at that host. It is resolved the same way as
`GITLAB_TOKEN` (process environment first, then encrypted environment variables)
and mirrors Gitea's `GITEA_BASE_URL`. Roomote derives the REST API base as
`${GITLAB_BASE_URL}/api/v4`. Clone URLs come straight from GitLab's
`http_url_to_repo`, so cloning always targets the correct host regardless of the
base URL. Provide `GITLAB_BASE_URL` through one of the supported sources:

1. Process environment variable named `GITLAB_BASE_URL`.
2. Encrypted Roomote environment variable named `GITLAB_BASE_URL`.

## Sync Repositories

After `GITLAB_TOKEN` is available, run the admin-only GitLab sync path from
Settings > Environments > Source Control. The GitLab row calls the same tRPC
procedure used by tests and internal callers:

- tRPC procedure: `sourceControl.syncRepositories` with `provider: 'gitlab'`
- settings component:
  [`apps/web/src/components/settings/SourceControl.tsx`](../../apps/web/src/components/settings/SourceControl.tsx)
- command implementation:
  [`apps/web/src/trpc/commands/source-control/index.ts`](../../apps/web/src/trpc/commands/source-control/index.ts)
- package implementation:
  [`packages/gitlab/src/api.ts`](../../packages/gitlab/src/api.ts)

The sync lists GitLab membership projects from GitLab's `/projects` API and
upserts each project into `repositories` with:

- `sourceControlProvider = 'gitlab'`
- `installationId = null`
- `githubRepoId = null`
- `externalRepoId = <GitLab project id>`
- `linkedByUserId = <admin who ran sync>`

Previously active GitLab repositories missing from the latest sync are marked
inactive.

## Configure Webhooks

Webhooks are configured automatically during repository sync, scoped to the
projects the deployment actually uses: for each synced project that is mapped
to at least one environment, Roomote creates (or refreshes) a project webhook
pointing at

```text
https://<roomote-public-url>/api/webhooks/gitlab
```

with merge request events and note events enabled, SSL verification on, and
the deployment's `GITLAB_WEBHOOK_SECRET` as the secret token. When no secret
is configured yet, sync generates one and saves it as an encrypted deployment
env var. The webhook URL follows the GitHub manifest behavior: `TRPC_URL`
unless it is a loopback address, then `ROOMOTE_APP_URL`; when both are
loopback, webhook setup is skipped and reported in the sync result. Webhook
creation requires the token identity to be a Maintainer or Owner of each
project; per-project failures are reported without failing the sync.

Synced projects without an environment mapping are treated as unused: no
webhook is created for them, and an existing Roomote webhook (matched by the
deployment webhook URL) is best-effort removed during sync. Removal matches
only the current deployment webhook URL: hooks pointing at an older Roomote
URL (for example a rotated ngrok domain) are not matched and need manual
cleanup. Map the project's repository to an environment and re-run sync to
configure its webhook.

Manual setup (self-managed instances or group hooks) still works with the
same URL and env vars. Enable both **Merge request events** and **Comments**
(note events) on a manually created hook so `@roomote` mentions in MR
discussions reach Roomote.

Preferred verification uses GitLab signed webhook headers:

- set a GitLab signing token on the webhook
- set the same value in Roomote as `GITLAB_WEBHOOK_SIGNING_TOKEN`

Legacy verification is still supported and is what auto-created webhooks use:

- set a GitLab secret token on the webhook
- set the same value in Roomote as `GITLAB_WEBHOOK_SECRET`

When `GITLAB_WEBHOOK_SIGNING_TOKEN` is configured, Roomote verifies
`webhook-id`, `webhook-timestamp`, and `webhook-signature` with a five-minute
timestamp tolerance. When it is absent, Roomote falls back to the legacy
`x-gitlab-token` header. Both values resolve through the deployment env
resolver: process env wins, and encrypted `environment_variables` rows saved
by `/setup`, Settings, or webhook auto-setup are the fallback.

## Enable Review Automation

GitLab MR automation uses the same Review Code automation targeting model as
GitHub.

Before expecting GitLab MR reviews:

1. Confirm the GitLab repository exists as an active synced repository row.
2. Confirm the repository is associated with the intended environment mapping.
3. Configure Review Code automation for that repository/environment.
4. Confirm the MR author is allowed by current automation policy.

The webhook handler resolves targets in
[`apps/api/src/handlers/gitlab/getGitLabAutomationTargets.ts`](../../apps/api/src/handlers/gitlab/getGitLabAutomationTargets.ts).
Open/reopen MR events enqueue initial review tasks. Update events enqueue sync
reviews only when GitLab includes `oldrev`, which indicates a code-related
update.

## Personal Linked Accounts (OAuth Application)

`GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET` are the credentials of a GitLab
OAuth application. GitLab has no manifest or prefill flow for OAuth
applications, so an operator creates one manually:

1. Register an OAuth application on the GitLab instance — under the bot
   account's user settings (`/-/user_settings/applications`), a group, or the
   admin area for self-managed instances.
2. Set the redirect URI to `<public-url>/api/auth/oauth2/callback/gitlab`,
   enable the confidential flag, and select only the `read_user` scope.
3. Save the generated Application ID and Secret as `GITLAB_CLIENT_ID` and
   `GITLAB_CLIENT_SECRET` (process env or encrypted deployment env vars).

The `/setup` source-control step for GitLab renders a "Recommended" guided
sub-step for this in
[`apps/web/src/app/(onboarding)/setup/StepSourceControlConfig.tsx`](<../../apps/web/src/app/(onboarding)/setup/StepSourceControlConfig.tsx>):
it links to the applications page (preferring the typed `GITLAB_BASE_URL`
form value, then the server-resolved `gitlabBaseUrl` on
`SetupSourceControlStatus`, then `gitlab.com`; only absolute `http(s)` URLs
are used) and shows a copyable redirect URI computed from
`window.location.origin`.

These credentials do not grant repository access. Better Auth registers the
GitLab provider with `disableSignUp: true` in
[`apps/web/src/lib/server/auth.ts`](../../apps/web/src/lib/server/auth.ts), so
the OAuth application only powers the personal GitLab row in Settings > Linked
Accounts used to authorize `@roomote` MR comment follow-ups.

## Mention Follow-Ups In MR Comments

`@roomote` mentions in merge-request comment notes are handled in
[`apps/api/src/handlers/gitlab/handleNote.ts`](../../apps/api/src/handlers/gitlab/handleNote.ts),
mirroring GitHub's PR-comment path. When a merge-request note mentions
`@roomote` (case-insensitive), Roomote either steers or sends the comment into
the active task that already owns the MR, or starts a new MR review task when no
reusable owner exists. Either way it posts a short acknowledgement note back on
the MR with a task link.

Because a mention is an explicit request, the MR-author allowlist is bypassed for
this path. To avoid feedback loops, Roomote ignores notes it authored itself:
Roomote-prefixed usernames, `project_<id>_bot` / `group_<id>_bot`
project-access-token identities, and the deployment token identity. The
deployment identity is resolved once through a cached `GET /user` call
(`getGitLabDeploymentUser` in
[`packages/gitlab/src/api.ts`](../../packages/gitlab/src/api.ts)).

For mentions to reach Roomote, the project or group webhook must have comment
(note) events enabled in addition to merge-request events.

## Smoke Test

Use this sequence to verify a connection end to end:

1. Run the Settings > Environments > Source Control GitLab sync as an admin.
2. Confirm the target repository appears as an active `gitlab` repository row.
3. Launch a manual task with `sourceControlProvider: 'gitlab'` against that repository.
4. Confirm the worker clones from the configured host (`gitlab.com` or the `GITLAB_BASE_URL` instance) and does not require GitHub App installation metadata.
5. If the task uses a repository set, confirm `selectedRepositories` or an environment-backed repository list is present; true `all_repositories` GitLab launches are now rejected because Roomote must mint repo-scoped tokens.
6. Send a GitLab MR webhook test delivery to `/api/webhooks/gitlab`.
7. Confirm a webhook audit row is recorded with `provider = 'gitlab'`.
8. Open or update a real MR in a repository with Review Code automation enabled.
9. Confirm a `github.pr.review` or `github.pr.review.sync` cloud job is created with `payload.sourceControlProvider = 'gitlab'`, `payload.branch`, and `payload.sha`.

## Troubleshooting

| Symptom                                                 | Likely cause                                                                                                                            | Check                                                                                                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITLAB_TOKEN is required to sync GitLab repositories.` | Token is missing from both process env and encrypted env vars                                                                           | Verify `GITLAB_TOKEN` is available to the web/runtime process                                                                                                                                                      |
| Sync succeeds but repo is missing                       | Token identity cannot see the project                                                                                                   | Confirm the bot/service account is a member of the group or project                                                                                                                                                |
| Worker cannot clone GitLab repo                         | Selected repository metadata is incomplete, stale scoped credentials are loaded, or the deployment token itself lacks repository access | Confirm the GitLab repository row has `externalRepoId`, the launch includes an explicit repository scope, and the token can read the repository (minting failures fall back to the deployment token automatically) |
| Sync succeeds but no webhooks appear on projects        | The repository is not mapped to any environment, the token identity is below Maintainer on those projects, or the deployment has no publicly reachable URL | Map the repository to an environment and re-run sync, then check the sync result webhook summary, the token identity's role, and `TRPC_URL` / `ROOMOTE_APP_URL`                                                    |
| Saving `GITLAB_TOKEN` fails with a rejection message    | The token is revoked, expired, or missing the `api` scope                                                                               | Create a new token with the `api` scope and save it again                                                                                                                                                          |
| Webhook returns 401                                     | Signing token or legacy secret mismatch                                                                                                 | Compare GitLab webhook token settings with Roomote env vars                                                                                                                                                        |
| Webhook records but no review job starts                | No automation target or unsupported MR action                                                                                           | Check repository sync, environment mapping, Review Code settings, and MR action                                                                                                                                    |
| Update MR does not enqueue sync review                  | GitLab update payload did not include `oldrev`                                                                                          | Reproduce with a commit push to the MR source branch                                                                                                                                                               |
| `@roomote` MR comment does nothing                      | Webhook lacks comment (note) events, mention text missing, or note authored by a Roomote/bot/deployment identity                        | Confirm note events are enabled on the webhook and that a non-Roomote user posted a note containing `@roomote`                                                                                                     |

## Related Implementation

- [`packages/gitlab/src/api.ts`](../../packages/gitlab/src/api.ts) — token resolution, GitLab project listing, repository row mapping, sync
- [`apps/web/src/trpc/commands/source-control/index.ts`](../../apps/web/src/trpc/commands/source-control/index.ts) — admin-only sync command
- [`apps/api/src/handlers/gitlab/index.ts`](../../apps/api/src/handlers/gitlab/index.ts) — GitLab webhook router
- [`apps/api/src/handlers/gitlab/verifyWebhook.ts`](../../apps/api/src/handlers/gitlab/verifyWebhook.ts) — signed and legacy webhook verification
- [`apps/api/src/handlers/gitlab/handleMergeRequest.ts`](../../apps/api/src/handlers/gitlab/handleMergeRequest.ts) — MR event handling and review task enqueue
- [`apps/api/src/handlers/gitlab/handleNote.ts`](../../apps/api/src/handlers/gitlab/handleNote.ts) — `@roomote` MR comment mention routing and acknowledgement notes
- [`packages/cloud-agents/src/server/workflows/githubPrReview.ts`](../../packages/cloud-agents/src/server/workflows/githubPrReview.ts) — initial GitLab MR review prompt branch
- [`packages/cloud-agents/src/server/workflows/githubPrReviewSync.ts`](../../packages/cloud-agents/src/server/workflows/githubPrReviewSync.ts) — GitLab MR sync review prompt branch
