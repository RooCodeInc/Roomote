---
title: Azure DevOps Connection Setup
status: active
last_reviewed: 2026-07-08
owner: engineering
summary: Operator-facing setup guide for connecting Azure DevOps to Roomote through deployment-token-backed source control, service hooks, and optional Entra-backed commenter account linking.
---

# Azure DevOps Connection Setup

Roomote's Azure DevOps repository access is deployment-token backed. Operators
connect Azure DevOps by providing an organization name and personal access
token, then syncing accessible repositories from the Settings Source Control
section. Sync also configures Azure DevOps service-hook subscriptions for pull
request events when the deployment has a publicly reachable Roomote URL. When
operators also provide Microsoft Entra app credentials with Azure DevOps
delegated permissions, users can link personal Azure DevOps accounts so PR
comment mentions are attributed to the commenter rather than the repository
sync owner.

Use this page when setting up or debugging a deployment's Azure DevOps
source-control connection. For the shared source-control boundary, see
[GitHub Integration](./github-integration.md).

## Current Capability

The current path supports:

- validating newly saved `ADO_TOKEN` values against the organization
  `connectionData` API from `/setup` and Settings (definitive rejections,
  including Azure DevOps' 203 sign-in responses, block the save; connectivity
  failures do not). Validation is skipped when no organization is available
  from the submitted values or saved configuration.
- syncing repositories visible to the Azure DevOps PAT into provider-tagged
  `repositories` rows from Settings > Environments > Source Control
- cloning Azure DevOps repositories from the synced repository row's `cloneUrl`
- launching Azure DevOps-backed manual, environment, and repository-set tasks
- inferring `sourceControlProvider = 'ado'` for web-launched manual and
  environment tasks from the selected synced repository rows
- resolving `all_repositories` Azure DevOps workspaces from synced Azure
  DevOps repository rows
- automatic Azure DevOps service-hook setup during repository sync for pull
  request created, updated, and commented events, scoped to synced
  repositories mapped to at least one environment; unmapped repositories are
  not hooked, and sync best-effort removes previously created Roomote
  subscriptions from them
- webhook ingestion at `/api/webhooks/ado`
- Azure DevOps pull request Review Code automation for PR create and source
  update events
- Azure DevOps pull request comment mention routing: comments containing
  `@roomote` route into an existing PR task when possible or start a new Review
  Code task, then reply on the Azure DevOps PR thread
- optional Azure DevOps personal account linking through Settings > Linked
  Accounts when `ADO_CLIENT_ID`, `ADO_CLIENT_SECRET`, and `ADO_ORGANIZATION`
  are configured

The current path does not yet include:

- a first-party Azure DevOps app installation flow
- an Azure DevOps-specific repository permission delegation UI

Azure DevOps OAuth is legacy. Microsoft no longer accepts new Azure DevOps
OAuth app registrations as of April 2025 and recommends Microsoft Entra OAuth
for new apps. Roomote's `ADO_CLIENT_ID` / `ADO_CLIENT_SECRET` path therefore
uses Microsoft Entra OAuth for the linked-account flow. Repository sync,
checkout, and PR writes still use the deployment `ADO_TOKEN`; replacing that
background credential with a service principal or managed identity is a
separate runtime credential change.

## Required Azure DevOps Access

Create a dedicated Azure DevOps bot or service-account identity for the Roomote
deployment. Add that identity to the Azure DevOps organization, projects, and
repositories Roomote should access.

Create a personal access token for that identity with Code permissions
appropriate to the intended behavior and permission to create/update service
hook subscriptions in the target projects:

| Permission or project role                    | Needed for                                                       |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Code read access                              | repository listing and private repository clone                  |
| Code write access                             | pushing branches or commits from Roomote tasks                   |
| Service-hook subscription management          | automatic pull request service-hook setup during repository sync |
| Project membership or project admin as needed | Azure DevOps service-hook API access for the target project      |

Prefer a token owned by a bot/service account rather than a human user so token
rotation, offboarding, and repository access are deployment-owned.

Azure DevOps reference docs:

- [Azure DevOps REST API patterns](https://learn.microsoft.com/en-us/azure/devops/integrate/how-to/call-rest-api?view=azure-devops)
- [Repositories - List REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/repositories/list?view=azure-devops-rest-7.1)
- [Projects - List REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/core/projects/list?view=azure-devops-rest-7.1)
- [Service Hook Subscriptions - Create REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/hooks/subscriptions/create?view=azure-devops-rest-7.1)
- [Service hook events](https://learn.microsoft.com/en-us/azure/devops/service-hooks/events?view=azure-devops)
- [Service hook consumers](https://learn.microsoft.com/en-us/azure/devops/service-hooks/consumers?view=azure-devops)
- [Azure DevOps Entra OAuth app guidance](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/entra-oauth?view=azure-devops)
- [Azure DevOps Entra authentication guidance](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/entra?view=azure-devops)

## Configure Roomote

Provide these values to Roomote through process env or encrypted Roomote
environment variables:

1. `ADO_ORGANIZATION`, the Azure DevOps organization slug from
   `https://dev.azure.com/<organization>`.
2. `ADO_TOKEN`, the PAT for the bot or service-account identity.
3. Optional `ADO_BASE_URL`, defaulting to `https://dev.azure.com`.
4. Optional `ADO_USERNAME`, defaulting to `ado`, used as the Git-over-HTTPS
   username paired with the PAT.
5. Optional `ADO_CLIENT_ID` and `ADO_CLIENT_SECRET`, the Microsoft Entra app
   client credentials used only to expose Azure DevOps in Settings > Linked
   Accounts for PR comment attribution. The Entra app must have Azure DevOps
   delegated permissions and the Roomote callback redirect URI.
6. Optional `ADO_TENANT_ID`, defaulting to
   `ROOMOTE_AUTH_MICROSOFT_TENANT_ID` when present, and then to `common`.
7. Optional `ADO_WEBHOOK_SECRET`. If omitted, the admin sync command generates
   and persists a random secret before creating service hooks.

The Settings Source Control section treats Azure DevOps as configured only
when the required `ADO_ORGANIZATION` and `ADO_TOKEN` values are present.
Satisfied optional fields alone do not count: `ADO_TENANT_ID` falls back to
`ROOMOTE_AUTH_MICROSOFT_TENANT_ID`, so deployments using Microsoft sign-in
would otherwise show a bare credentials form instead of the provider setup
instructions.

The sync and worker credential paths resolve values in
[`packages/ado/src/api.ts`](../../packages/ado/src/api.ts), preferring process
env and then encrypted environment variables. The worker keeps the raw
`ADO_TOKEN` in memory, writes only token-free proxy config under `~/.roomote/`,
and rewrites the selected Azure DevOps base URL through a worker-local HTTPS
proxy so git can reach only the allowed repositories. The raw `ADO_TOKEN` is
not exported into task shells or written into task-readable credential files.

`ADO_WEBHOOK_SECRET` is used both as the Basic-auth password and as the
`X-Roomote-Webhook-Secret` header configured on Azure DevOps web-hook consumer
subscriptions. Service hooks set `basicAuthUsername = roomote`,
`basicAuthPassword = <ADO_WEBHOOK_SECRET>`, and the matching custom header. The
API accepts either credential when validating `/api/webhooks/ado` deliveries.

`ADO_CLIENT_ID` and `ADO_CLIENT_SECRET` do not grant repository access. They
enable a Better Auth Azure DevOps linked-account flow backed by Microsoft
Entra. The provider requests the Azure DevOps resource scope
`499b84ac-1321-427f-aa17-267ca6975798/.default`, then calls global Azure
DevOps APIs under `https://app.vssps.visualstudio.com`. It stores
`auth_accounts.provider_id = 'ado'` with the stable
`connectionData.authenticatedUser.id` so comment-webhook authors can be matched
to linked Roomote users, and uses the profile API only for display/email
enrichment. The Entra tenant must have the Azure DevOps enterprise
application/service principal and admin consent for the app's Azure DevOps
delegated permission. Comment-triggered work requires this row so the task can
run as the linked Roomote user while repository clone, API, and comment writes
still use the deployment PAT.

## Sync Repositories

After the Azure DevOps values are available, run the admin-only Azure DevOps
sync path from Settings > Environments > Source Control. The Azure DevOps row
calls the same tRPC procedure used by tests and internal callers:

- tRPC procedure: `sourceControl.syncRepositories` with `provider: 'ado'`
- settings component:
  [`apps/web/src/components/settings/SourceControl.tsx`](../../apps/web/src/components/settings/SourceControl.tsx)
- command implementation:
  [`apps/web/src/trpc/commands/source-control/index.ts`](../../apps/web/src/trpc/commands/source-control/index.ts)
- package implementation:
  [`packages/ado/src/api.ts`](../../packages/ado/src/api.ts)

The sync lists repositories from Azure DevOps'
`https://dev.azure.com/<organization>/_apis/git/repositories?api-version=7.1`
API and upserts each repository into `repositories` with:

- `sourceControlProvider = 'ado'`
- `installationId = null`
- `githubRepoId = null`
- `externalRepoId = <Azure DevOps repository UUID>`
- `fullName = <organization>/<project>/<repository>`
- `cloneUrl = <remoteUrl with the organization userinfo stripped>` — Azure
  DevOps `remoteUrl` values embed the organization as the URL username
  (`https://org@dev.azure.com/...`), which would bypass the worker's
  `insteadOf` credential-proxy rewrite; sync stores the URL without userinfo
  and the worker also strips userinfo defensively before cloning
- `linkedByUserId = <admin who ran sync>`

Previously active Azure DevOps repositories missing from the latest sync are
marked inactive.

After repository rows are synced, the command resolves the public webhook base
URL from `TRPC_URL` or `ROOMOTE_APP_URL`. If the result is not loopback, it
creates or refreshes Azure DevOps service-hook subscriptions for every synced
repository that is mapped to at least one environment and has both the Azure
DevOps repository UUID and project ID. The subscriptions target
`/api/webhooks/ado`. Synced repositories without an environment mapping are
not hooked, and existing Roomote subscriptions (matched by the current
deployment webhook URL only — subscriptions pointing at an older Roomote URL
need manual cleanup) are best-effort removed from them during sync.

Roomote configures the following ADO event IDs:

- `git.pullrequest.created`
- `git.pullrequest.updated` with `notificationType = PushNotification`
- `git.pullrequest.updated` with `notificationType = StatusUpdateNotification`
- `ms.vss-code.git-pullrequest-comment-event`

The two `git.pullrequest.updated` subscriptions share the same ADO event ID, so
Roomote adds a `notificationType` query parameter to those webhook URLs. The API
uses that hint to start Review Code sync jobs only for source-branch
`PushNotification` deliveries; `StatusUpdateNotification` deliveries update
closed/merged task state but do not start active PR re-reviews.

Service-hook setup failures are collected per repository and surfaced in
Settings/onboarding toast messages instead of failing repository sync. This
keeps manual Azure DevOps task launch usable even when the token lacks service
hook permissions.

## Pull Request Automation

ADO pull request webhooks enqueue the existing PR-review task types with
`sourceControlProvider: 'ado'`:

- `git.pullrequest.created` starts `CloudTaskType.GithubPrReview`
- active source-branch `git.pullrequest.updated` deliveries start
  `CloudTaskType.GithubPrReviewSync`
- abandoned PR updates mark tracked tasks as `closed`
- completed PR updates mark tracked tasks as `merged` and notify connected
  Slack/Teams threads when applicable
- `ms.vss-code.git-pullrequest-comment-event` deliveries route PR comments
  containing `@roomote` into reusable PR-owner tasks, link to active reviews
  for the same head SHA, or start `CloudTaskType.GithubPrReview`

ADO merge-attempted (`git.pullrequest.merged`) hooks are not configured for
Roomote PR automation. Azure DevOps also emits the completed status update, and
Roomote uses that single path to avoid duplicate merged-state updates and
duplicate Slack/Teams notifications.

The cloud-agent PR review workflows branch on `sourceControlProvider = 'ado'`
and emit Azure DevOps-specific `review-code` prompts. These prompts instruct
the worker to use local git state and Roomote source-control MCP tools instead
of GitHub-only commands such as `gh pr`.

Review Code automation still requires an active environment mapping for the
synced Azure DevOps repository, matching the GitHub/GitLab/Gitea automation
gate.

Comment mention routing is explicit-request driven, so it bypasses the PR
author policy while still requiring the synced repository and environment
mapping gate. Roomote ignores comments authored by Roomote-prefixed Azure
DevOps identities or by the current deployment token identity resolved from
Azure DevOps connection data. Explicit ADO comment mentions require the
commenter to have a linked Azure DevOps account in Settings > Linked Accounts;
target resolution matches the webhook comment author's stable `id` to
`auth_accounts.provider_id = 'ado'` and attributes the task to that linked
Roomote user. When no linked account exists, Roomote replies on the PR thread
with a link-account instruction instead of starting work.

## Smoke Test

Use this sequence to verify a connection end to end:

1. Run the Settings > Environments > Source Control Azure DevOps sync as an admin.
2. Confirm the target repository appears as an active `ado` repository row.
3. Confirm sync reports service hooks configured, or that any service-hook
   failure clearly points to missing Azure DevOps permissions.
4. Launch a manual task from that synced Azure DevOps repository, or from an
   environment backed only by active Azure DevOps repository mappings. Web
   launches stamp `sourceControlProvider: 'ado'` from those rows; non-web
   callers can still pass it explicitly.
5. Open or update an Azure DevOps pull request in a synced repository that has
   an environment mapping, then confirm a Review Code task is enqueued with
   `sourceControlProvider: 'ado'`.
6. If `ADO_CLIENT_ID` / `ADO_CLIENT_SECRET` are configured for an Entra app,
   link the commenter's Azure DevOps account from Settings > Linked Accounts.
7. Add a pull request comment containing `@roomote`, then confirm Roomote
   replies on the Azure DevOps PR thread and either routes into an existing PR
   task or enqueues a new `GithubPrReview` task with `sourceControlProvider`
   set to `ado`.
8. Confirm the worker clones from the synced repository `cloneUrl`.
9. Confirm task shell env does not export `ADO_TOKEN`.
10. If the task uses a repository set, confirm `selectedRepositories`, `all_repositories`, or an environment-backed repository list resolves to active synced Azure DevOps rows.

## Troubleshooting

| Symptom                                                           | Likely cause                                                                                                                  | Check                                                                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saving the config fails with `Azure DevOps rejected the token.`   | The PAT is expired, revoked, or not valid for the configured organization                                                     | Recreate the PAT for the bot/service account in the target organization and save it again                                                                         |
| `ADO_ORGANIZATION is required to sync Azure DevOps repositories.` | Organization is missing from both process env and encrypted env vars                                                          | Verify `ADO_ORGANIZATION` is available to the web/runtime process                                                                                                 |
| `ADO_TOKEN is required to sync Azure DevOps repositories.`        | Token is missing from both process env and encrypted env vars                                                                 | Verify `ADO_TOKEN` is available to the web/runtime process                                                                                                        |
| Sync succeeds but repo is missing                                 | Token identity cannot see the repository                                                                                      | Confirm the bot/service account has organization, project, or repository access                                                                                   |
| Sync succeeds but service hooks are skipped                       | `TRPC_URL` and `ROOMOTE_APP_URL` resolve to loopback, or the repository is not mapped to any environment                      | Configure a public Roomote URL and map the repository to an environment, then rerun sync                                                                          |
| Service-hook setup fails for a repository                         | PAT identity cannot manage project service hooks                                                                              | Grant service-hook subscription management/project admin permissions and rerun sync                                                                               |
| ADO webhook returns `invalid_signature`                           | `ADO_WEBHOOK_SECRET` does not match the configured hook credentials                                                           | Rerun sync after updating/removing `ADO_WEBHOOK_SECRET` or update subscriptions manually                                                                          |
| Pull request webhook is recorded but no Review Code task starts   | No active environment mapping or author policy blocked automation                                                             | Confirm the synced repository has an environment mapping and PR reviewer settings allow the author                                                                |
| `@roomote` PR comment receives a link-account reply               | Comment author has not linked Azure DevOps in Roomote                                                                         | Configure `ADO_CLIENT_ID` / `ADO_CLIENT_SECRET` for an Entra app if the row is missing, then have the commenter link Azure DevOps in Settings > Linked Accounts   |
| `@roomote` PR comment is recorded but no task starts              | Missing mention, Roomote/deployment-token author, no active repository row, no environment mapping, or missing linked account | Confirm the comment contains `@roomote`, the author is not the Roomote bot, the commenter has linked Azure DevOps, and the synced repo has an environment mapping |
| Worker cannot clone Azure DevOps repo                             | Repository was not synced, PAT cannot clone, or username is wrong                                                             | Confirm active Azure DevOps repository rows, token Code access, and optional username                                                                             |
| Worker clone fails with `could not read Password for 'https://<org>@dev.azure.com/...'` | Repository row stores a clone URL with embedded userinfo (synced before URL normalization), so the git `insteadOf` proxy rewrite does not match | Re-run the Azure DevOps sync to normalize the stored clone URL, and confirm the worker release includes the userinfo-stripping clone path |

## Related Implementation

- [`packages/ado/src/api.ts`](../../packages/ado/src/api.ts) — token/base URL resolution, token validation, repository listing, repository row mapping, sync, service-hook setup, runtime credentials
- [`apps/web/src/trpc/commands/source-control/index.ts`](../../apps/web/src/trpc/commands/source-control/index.ts) — admin-only sync command
- [`apps/api/src/handlers/ado`](../../apps/api/src/handlers/ado) — Azure DevOps webhook ingestion, pull request automation routing, and PR comment mention handling
- [`apps/web/src/trpc/commands/cloud-jobs/index.ts`](../../apps/web/src/trpc/commands/cloud-jobs/index.ts) — web launch provider inference from selected repositories and environment mappings
- [`apps/web/src/components/settings/SourceControl.tsx`](../../apps/web/src/components/settings/SourceControl.tsx) — Source Control settings row
- [`packages/sdk/src/server/lib/cloud-jobs/dequeue-helpers.ts`](../../packages/sdk/src/server/lib/cloud-jobs/dequeue-helpers.ts) — runtime Azure DevOps credential metadata
- [`apps/worker/src/lib/github-token.ts`](../../apps/worker/src/lib/github-token.ts) — file-backed Git credential helper
