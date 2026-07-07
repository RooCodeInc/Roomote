---
title: Gitea Connection Setup
status: active
last_reviewed: 2026-07-06
owner: engineering
summary: Operator-facing setup guide for connecting Gitea to Roomote through the deployment-token-backed source-control, webhook, and Review Code automation path, plus optional personal Gitea linked accounts for comment attribution.
---

# Gitea Connection Setup

Roomote's Gitea integration is deployment-token backed. It does not have a
Gitea App installation flow, but it can sync repositories, configure repository
webhooks, ingest Gitea pull-request events, launch Review Code automation from
those events, and optionally let users link a personal Gitea identity for
`@roomote` PR comment attribution.

Use this page when setting up or debugging a deployment's Gitea source-control
connection. For the shared source-control boundary, see
[GitHub Integration](./github-integration.md).

## Current Capability

The current path supports:

- syncing repositories visible to the Gitea token into provider-tagged
  `repositories` rows from Settings > Environments > Source Control
- validating newly saved Gitea tokens against `<GITEA_BASE_URL>/api/v1/user`
- automatically creating or refreshing repository webhooks after sync for
  synced repositories mapped to at least one environment, when Roomote has a
  public callback URL and the token can administer repository hooks; unmapped
  repositories are not hooked, and sync best-effort removes a previously
  created Roomote webhook from them
- verifying Gitea webhook signatures with `GITEA_WEBHOOK_SECRET`
- enqueueing initial and delta Review Code tasks from Gitea pull-request events
- replying to `@roomote` Gitea pull-request comments and, when the commenter is
  linked, routing them into existing or new review tasks
- optionally exposing a personal Gitea linked-account row in Settings > Linked
  Accounts when `GITEA_CLIENT_ID` and `GITEA_CLIENT_SECRET` are configured, so
  PR commenters can link their identity before retrying an `@roomote` comment
- updating PR status and sending Slack or Teams notifications for merged Gitea
  pull requests on active synced repositories
- cloning Gitea repositories from the synced repository row's `cloneUrl`
- launching Gitea-backed manual, environment, and repository-set tasks
- resolving `all_repositories` Gitea workspaces from synced Gitea repository rows

The current path does not yet include:

- a Gitea App installation flow
- a Gitea-specific repository permission delegation UI

## Required Gitea Access

Create a dedicated Gitea bot or service-account identity for the Roomote
deployment. Add that identity to the Gitea organizations or repositories
Roomote should access.

Create an access token for that identity with repository permissions appropriate
to the intended behavior:

| Permission              | Needed for                                                         |
| ----------------------- | ------------------------------------------------------------------ |
| repository read access  | repository listing, private repository clone, and webhook lookup   |
| repository write access | pushing branches or commits from Roomote tasks                     |
| repository admin access | creating and refreshing repository webhooks during repository sync |

Prefer a token owned by a bot/service account rather than a human user so token
rotation, offboarding, and repository access are deployment-owned.

Gitea reference docs:

- [API Usage](https://docs.gitea.com/development/api-usage)
- [Repository Webhooks](https://docs.gitea.com/usage/repository/webhooks)

## Configure Roomote

Provide these values to Roomote through process env or encrypted Roomote
environment variables:

1. `GITEA_BASE_URL` such as `https://git.example.com`.
2. `GITEA_TOKEN` for the Gitea bot or service-account identity.
3. Optional `GITEA_USERNAME`. When omitted, Roomote calls
   `<GITEA_BASE_URL>/api/v1/user` with the token and uses the returned login for
   Git-over-HTTPS credentials.
4. Optional `GITEA_WEBHOOK_SECRET`. When omitted, Settings sync generates and
   persists one before creating webhooks.

The sync and worker credential paths resolve values in
[`packages/gitea/src/api.ts`](../../packages/gitea/src/api.ts), preferring
process env and then encrypted environment variables. The webhook handler
resolves `GITEA_WEBHOOK_SECRET` through the same deployment env resolver, so a
secret generated from Settings verifies without also living in process env.

The worker keeps the raw `GITEA_TOKEN` in memory, writes only token-free proxy
config under `~/.roomote/`, and rewrites the selected Gitea base URL through a
worker-local HTTPS proxy so git can reach only the allowed repositories. The raw
`GITEA_TOKEN` is not exported into task shells or written into task-readable
credential files.

## Personal Linked Accounts

Personal Gitea account linking is optional at the deployment level and mirrors
the GitLab and Azure DevOps linked-account paths. It is an identity and
authorization signal only: runtime git operations keep using the deployment
`GITEA_TOKEN`.

To enable it:

1. Register an OAuth2 application on the Gitea instance (user, organization, or
   instance-level admin settings > Applications) with the redirect URI
   `<ROOMOTE_APP_URL>/api/auth/oauth2/callback/gitea`.
2. Save the generated client id and secret as `GITEA_CLIENT_ID` and
   `GITEA_CLIENT_SECRET`, through process env or as encrypted deployment env
   vars from Settings > Environments > Source Control.

When `GITEA_CLIENT_ID`, `GITEA_CLIENT_SECRET`, and `GITEA_BASE_URL` are all
present, Settings > Linked Accounts shows a Gitea row. Linking redirects to the
Gitea instance's OAuth consent page (`read:user` scope) and stores a Better
Auth `auth_accounts` row with `provider_id = 'gitea'` and the stringified
numeric Gitea user id as `account_id` — the same value the `@roomote` PR
comment gate matches against. Gitea sign-in is disabled (`disableSignUp`), so
the OAuth flow can only link an existing Roomote user. Because Gitea is always
instance-specific, the provider stays disabled without `GITEA_BASE_URL`, and
the web app must be able to reach that URL for token exchange and
`/api/v1/user` profile reads.

## Sync Repositories

After the Gitea values are available, run the admin-only Gitea sync path from
Settings > Environments > Source Control. The Gitea row calls the same tRPC
procedure used by tests and internal callers:

- tRPC procedure: `sourceControl.syncRepositories` with `provider: 'gitea'`
- settings component:
  [`apps/web/src/components/settings/SourceControl.tsx`](../../apps/web/src/components/settings/SourceControl.tsx)
- command implementation:
  [`apps/web/src/trpc/commands/source-control/index.ts`](../../apps/web/src/trpc/commands/source-control/index.ts)
- package implementation:
  [`packages/gitea/src/api.ts`](../../packages/gitea/src/api.ts)

The sync lists repositories from Gitea's `/user/repos` API and upserts each
repository into `repositories` with:

- `sourceControlProvider = 'gitea'`
- `installationId = null`
- `githubRepoId = null`
- `externalRepoId = <Gitea repository id>`
- `linkedByUserId = <admin who ran sync>`

Previously active Gitea repositories missing from the latest sync are marked
inactive.

After repository upsert, the command best-effort ensures a Gitea repository
webhook for each synced repository that is mapped to at least one
environment; synced repositories without an environment mapping are not
hooked, and an existing Roomote webhook (matched by the current deployment
webhook URL only — hooks pointing at an older Roomote URL need manual
cleanup) is best-effort removed from them during sync. The webhook URL is
`<public Roomote URL>/api/webhooks/gitea`; URL resolution follows the GitHub App
manifest behavior by preferring `TRPC_URL` unless it is loopback, then falling
back to `ROOMOTE_APP_URL`. If only loopback URLs are configured, webhook setup is
skipped and repository sync still succeeds.

The configured Gitea hook uses JSON payloads and listens for pull-request,
pull-request sync, pull-request comment, and issue-comment events. Hook setup
failures are returned in the sync result and shown as a Settings warning instead
of failing repository sync.

## Review Automation

Gitea pull-request webhooks are handled at `/api/webhooks/gitea`.
Roomote verifies the raw request body with Gitea's HMAC-SHA256 signature header
and the configured `GITEA_WEBHOOK_SECRET` before parsing the payload.

Review Code automation follows the same deployment automation and environment
targeting model as GitHub and GitLab:

- PR opened or reopened events enqueue an initial review when Review Code is
  enabled for the repository target.
- PR sync events enqueue a delta review.
- PR closed events update linked task PR status, and merged PRs can notify
  linked Slack or Teams threads.
- `@roomote` PR comments require linked commenter attribution before they can
  route into the existing PR owner task or enqueue a new review task.

Automatic author policy checks still use the Gitea sender login and deployment
token identity. Explicit `@roomote` comments still bypass the PR-author
allowlist because they are an explicit request, but they fail closed unless the
comment can be attributed to a linked Gitea user. When the commenter has linked
a personal Gitea account in Settings > Linked Accounts, the follow-up task runs
attributed to that linked Roomote user. Unlinked commenters get a reply with
link instructions (and a hint to ask an admin for the OAuth client credentials
when linking is not configured yet) instead of the follow-up running as the
repository sync owner.

## Smoke Test

Use this sequence to verify a connection end to end:

1. Run the Settings > Environments > Source Control Gitea sync as an admin.
2. Confirm the target repository appears as an active `gitea` repository row.
3. Confirm sync reports Gitea webhooks as configured, or intentionally skipped
   only because the Roomote URL is not publicly reachable.
4. Associate the repository with an environment and enable Review Code
   automation for that target.
5. Open or update a Gitea pull request and confirm a Gitea-sourced review task
   is enqueued.
6. Add an `@roomote` comment on the pull request as an unlinked user and
   confirm Roomote replies with account-link instructions rather than acting as
   the repository sync owner.
7. Link your Gitea account from Settings > Linked Accounts, confirm the
   `auth_accounts` row stores the numeric Gitea user id, then repeat the
   `@roomote` comment and confirm it routes into a task attributed to the
   linked user.
8. Launch a manual task with `sourceControlProvider: 'gitea'` against that
   repository and confirm the worker clones from the synced `cloneUrl`.
9. Confirm task shell env does not export `GITEA_TOKEN`.
10. If the task uses a repository set, confirm `selectedRepositories`,
    `all_repositories`, or an environment-backed repository list resolves to
    active synced Gitea rows.

## Troubleshooting

| Symptom                                                  | Likely cause                                                                                                         | Check                                                                                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITEA_BASE_URL is required to sync Gitea repositories.` | Instance URL is missing from both process env and encrypted env vars                                                 | Verify `GITEA_BASE_URL` is available to the web/runtime process                                                                                                              |
| `GITEA_TOKEN is required to sync Gitea repositories.`    | Token is missing from both process env and encrypted env vars                                                        | Verify `GITEA_TOKEN` is available to the web/runtime process                                                                                                                 |
| Token save fails with a Gitea rejection                  | Token is inactive, expired, or lacks basic repository access                                                         | Confirm the bot token can call `<GITEA_BASE_URL>/api/v1/user`                                                                                                                |
| Sync succeeds but repo is missing                        | Token identity cannot see the repository                                                                             | Confirm the bot/service account has repository or organization access                                                                                                        |
| Sync warns that webhooks were skipped                    | Roomote only has loopback callback URLs configured                                                                   | Configure a public `TRPC_URL` or `ROOMOTE_APP_URL` before syncing                                                                                                            |
| Sync warns that a repository webhook failed              | Token identity cannot administer that repository's hooks                                                             | Grant repository admin access or create the hook manually with the same URL and secret                                                                                       |
| Sync reports repositories skipped for webhooks           | The repository is not mapped to any environment                                                                      | Map the repository to an environment and re-run sync                                                                                                                         |
| Gitea webhook returns unauthorized                       | Missing or mismatched `GITEA_WEBHOOK_SECRET`, or body signature absent                                               | Confirm the hook secret matches Roomote's encrypted/process value                                                                                                            |
| PR event arrives but no review task starts               | Review Code target is disabled, repository is inactive, or author policy blocked it                                  | Check `background_automations`, environment repository mapping, and sender login                                                                                             |
| `@roomote` comment does not start work                   | Comment is not on a pull request, was sent by the Roomote token user, or cannot be attributed to a linked Gitea user | Confirm the payload has PR context, the sender is not the deployment bot, and the commenter has linked a Gitea account in Settings > Linked Accounts (admins may need to add `GITEA_CLIENT_ID` / `GITEA_CLIENT_SECRET` first) |
| Worker cannot clone Gitea repo                           | Repository was not synced, token cannot clone, or username is wrong                                                  | Confirm active Gitea repository rows, token read access, and optional `GITEA_USERNAME`                                                                                       |

## Related Implementation

- [`packages/gitea/src/api.ts`](../../packages/gitea/src/api.ts) — token/base URL resolution, token validation, repository listing, repository row mapping, sync, webhook setup, PR comments, runtime credentials
- [`apps/api/src/handlers/gitea`](../../apps/api/src/handlers/gitea) — webhook verification, event routing, automation target resolution, PR event handling, PR comment handling
- [`apps/web/src/trpc/commands/source-control/index.ts`](../../apps/web/src/trpc/commands/source-control/index.ts) — admin-only sync command and generated webhook secret persistence
- [`apps/web/src/components/settings/SourceControl.tsx`](../../apps/web/src/components/settings/SourceControl.tsx) — Source Control settings row
- [`apps/web/src/lib/server/auth.ts`](../../apps/web/src/lib/server/auth.ts) — Gitea OAuth provider for personal linked accounts
- [`apps/web/src/components/settings/LinkedAccounts.tsx`](../../apps/web/src/components/settings/LinkedAccounts.tsx) — personal Gitea linked-account row
- [`packages/cloud-agents/src/server/workflows/githubPrReview.ts`](../../packages/cloud-agents/src/server/workflows/githubPrReview.ts) — Gitea initial PR review prompt
- [`packages/cloud-agents/src/server/workflows/githubPrReviewSync.ts`](../../packages/cloud-agents/src/server/workflows/githubPrReviewSync.ts) — Gitea sync PR review prompt
- [`packages/sdk/src/server/lib/cloud-jobs/dequeue-helpers.ts`](../../packages/sdk/src/server/lib/cloud-jobs/dequeue-helpers.ts) — runtime Gitea credential metadata
- [`apps/worker/src/lib/github-token.ts`](../../apps/worker/src/lib/github-token.ts) — file-backed Git credential helper
