export const INTEGRATION_SETUP_CONTENT = `Guide for how to set up and connect integrations in Roomote. Use this when a user asks how to enable or configure a specific integration.

# General Setup Flow

Most built-in integrations are managed from the web dashboard at Settings > Integrations. There are two levels of setup:

1. Deployment-level: An admin enables the integration for the deployment. This makes it available to all members.
2. User-level: Each user connects their own account via OAuth or provides their own credentials. This is required for integrations that access user-specific data.

Both steps must be completed before I can use the integration during tasks.

Custom MCP servers are separate: they are configured per-environment in the environment editor or environment YAML, not in Settings > Integrations.

# Slack

Slack is set up from Settings > Integrations in the web dashboard. An admin installs the Roomote Slack app to the Slack workspace. Once installed, users can mention me in any channel or DM to start tasks. No per-user setup is needed beyond the deployment-level install.

# Linear

An admin connects Linear from Settings > Integrations. This uses OAuth to link the connected Linear workspace. Once connected, I can look up issues, check project context, and update status during tasks. Users can also start tasks by mentioning me in Linear issue comments or creating Agent Sessions.

# GitHub

GitHub is connected via a GitHub App installation. An admin installs the Roomote GitHub App on the relevant GitHub organization/repos from Settings > Integrations. Once installed, I can access repo context through the GitHub App installation. Automatic PR review and direct PR @roomote follow-up or re-review requests also require Code Reviewer to be enabled. Automatic review still follows the current reviewer gate, while direct PR mentions are manual requests in the PR thread rather than part of that proactive gate. No per-user OAuth is needed since access goes through the GitHub App installation.

# Notion

Notion uses OAuth and requires both levels:
1. An admin enables Notion from Settings > Integrations.
2. Each user connects their Notion account via OAuth from the same page.

Once connected, I can read Notion pages and databases for additional context during tasks.

# Jira

Jira uses OAuth and requires both levels:
1. An admin enables Jira from Settings > Integrations.
2. That admin connects Jira once for the workspace via OAuth.

Once connected, I can read Jira issues, project metadata, and JQL search results using the workspace's connected Atlassian account.

# Sentry

Sentry uses the workspace MCP integration:
1. An admin opens Settings > Integrations.
2. That admin connects Sentry once for the workspace via OAuth.

Once connected, tasks can inspect Sentry issue and project context, and scheduled Sentry triage automation uses the same read-only MCP connection.

# Pylon

Pylon uses OAuth:
1. An admin enables Pylon from Settings > Integrations.
2. That admin connects Pylon once for the workspace via OAuth.

Once connected, I can read customer issues, issue message history, and account details during tasks.

# Neon

Neon uses OAuth:
1. An admin enables Neon from Settings > Integrations.
2. Each user connects their Neon account via OAuth.

Once connected, I get database access to understand schema and data context during tasks.

# Supabase

Supabase uses OAuth:
1. An admin enables Supabase from Settings > Integrations.
2. Each user connects their Supabase account via OAuth.

Once connected, I get read-only database access for schema and data context.

# Better Stack

Better Stack uses OAuth:
1. An admin enables Better Stack from Settings > Integrations.
2. That admin connects Better Stack once for the workspace via OAuth.

Once connected, I can access the workspace's read-only monitoring data and incident details during tasks.

# Railway

Railway uses OAuth:
1. An admin enables Railway from Settings > Integrations.
2. That admin connects Railway once for the workspace via OAuth.

Once connected, I can confirm the connected Railway account and list Railway projects and services during tasks.

# Braintrust

Braintrust uses OAuth:
1. An admin enables Braintrust from Settings > Integrations.
2. Each user connects their Braintrust account via OAuth.

Once connected, I can access AI evaluation and logging data during tasks.

# Asana

Asana uses an admin-managed access token:
1. An admin enables Asana from Settings > Integrations.
2. That admin connects Asana once for the workspace with an Asana access token.

The token can be either a Personal Access Token or a Service Account token. Once connected, I can inspect workspaces, projects, tasks, teams, and task comments during tasks.

# Grafana

Grafana uses an admin-managed service account token:
1. An admin enables Grafana from Settings > Integrations.
2. That admin connects Grafana once for the workspace with a Grafana URL and service account token.

Once connected, I can inspect dashboards, alert rules, current alert instances, data sources, and annotations during tasks.

# Vercel

Vercel uses an admin-managed access token:
1. An admin enables Vercel from Settings > Integrations.
2. That admin connects Vercel once for the workspace with a Vercel access token.

The admin can also save an optional default team ID or slug so project and deployment tools stay scoped to the shared workspace by default. Once connected, I can inspect teams, projects, deployments, logs, and domain availability during tasks.

# Supermemory

Supermemory uses OAuth:
1. An admin enables Supermemory from Settings > Integrations.
2. That admin connects Supermemory once for the workspace via OAuth.

Once connected, I can save shared memories and recall relevant context from earlier tasks using the workspace's connected Supermemory account. Memories are stored in that Supermemory account, so anything I save is visible to everyone in the workspace.

# Zero

Zero uses Path C (CLI in the runtime with user/capability discovery, connected once for the deployment):
1. A deployment operator enables Zero from Settings > Integrations.
2. That operator connects Zero once for the workspace via OAuth.

Only after Zero is enabled for the deployment do I install the zero CLI for that task and activate the packaged Zero skill. The Zero MCP connection is for authentication and funding. Capability spend comes from the workspace-connected Zero wallet, not a separate Roomote-managed wallet.

# Unsupported Built-in Integrations And Feature Requests

If a user asks about a service that is not a built-in Roomote integration today (for example Datadog), say that it is not supported as a built-in right now.

Also tell them:
1. The fallback is usually a custom MCP server attached to the environment.
2. They can send the team a feature request, and the team acts on those quickly.

If the user asks how to send a feature request, tell them:
1. Use the shared Slack channel with the Roomote team, if they have one.
2. Or click the Lightbulb / Feature Request action in the web navigation.

# Custom MCP Servers

Teams can add custom MCP servers to any environment via the environment YAML config. This supports two transport types:

HTTP: Provide a url and optional headers.
Stdio: Provide a command, optional args, and optional env vars.

Custom MCPs are configured per-environment, not deployment-wide. Edit the environment config from the web dashboard or via the manage_environments tool.

# Troubleshooting

If I tell you an integration is not available during a task, check:
1. Is it enabled at the deployment level in Settings > Integrations?
2. Has the required OAuth connection been completed for that integration? User-scoped integrations need the user's own account, while deployment-scoped integrations need the deployment connection.

If you paste a URL from a supported service in Slack and the integration is not connected, I will prompt you to set it up before proceeding with the task.
`;
