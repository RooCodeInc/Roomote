---
title: Feature Behavior Index
status: active
last_reviewed: 2026-06-30
owner: engineering
summary: Entry point for Roomote feature docs covering agent surfaces, integrations, and platform capabilities.
---

# Features

Behavior-focused docs for user-visible features, integrations, and operator-facing product behavior.

## Core Product

Roomote's core product is a set of **Roomote agents** that users can configure and interact with across multiple surfaces.

- **Primary surfaces:** web dashboard, Slack, Teams, Telegram, Linear, and GitHub.
- **Current agent types:** `Generalist`, `Code Reviewer`, and `PR Fixer`.
- **Product questions this section answers:** how agents are invoked, how users collaborate with them, how integrations feed work into them, and how Roomote presents their output back to users.
- [Agent Entry Surfaces](./agent-entry-surfaces.md) — Cross-surface overview of how work enters Roomote from the web dashboard, Slack, Teams, Telegram, Linear, GitHub, and programmatic launch paths

## Integration Features

- [Slack Integration](./slack-integration.md) — Bidirectional Slack integration: OAuth, event handling, LLM routing, message delivery, snapshot resume, work objects
- [Slack Onboarding Timeline](./slack-onboarding.md) — Proactive Slack setup/onboarding message timeline plus guardrails for avoiding noisy clustering
- [Telegram Integration](./telegram-integration.md) — Telegram bot task entry, webhook configuration, reply flow with markdown rendering, and Slack parity notes
- [Microsoft Teams Integration](./teams-integration.md) — Teams bot task entry, app/bot setup runbook, Entra account linking, reply flow, and parity notes
- [Linear Integration](./linear-integration.md) — Linear Agent Sessions: OAuth, webhook pipeline, LLM routing, plan steps, bidirectional communication
- [GitHub Integration](./github-integration.md) — GitHub App installation, webhook handling, PR reviews, PR follow-up workflows, and conflict resolution
- [GitLab Connection Setup](./gitlab-connection-setup.md) — Operator-facing setup guide for the current deployment-token-backed GitLab connection path
- [Gitea Connection Setup](./gitea-connection-setup.md) — Operator-facing setup guide for the deployment-token-backed Gitea source-control, webhook, and Review Code automation path
- [Azure DevOps Connection Setup](./ado-connection-setup.md) — Operator-facing setup guide for the deployment-token-backed Azure DevOps source-control, webhook, and Review Code automation path

## Platform Features

- [Environment Management](./environment-management.md) — Environment and workspace management covering configuration, snapshots, and compute target mapping
- [Preview Proxy](./preview-proxy.md) — HTTP and WebSocket traffic routing to Roomote-managed sandbox surfaces via stable URLs
- [MCP Servers](./mcp-servers.md) — MCP server setup covering built-in servers, conditional integrations, packaging, and worker deployment
- [Web Dashboard](./web-dashboard.md) — Technical documentation of the Next.js 16 web dashboard covering route structure, design system components, page architecture, and state management
- [Licensing & Seat Limits](./licensing.md) — FCL-1.0-ALv2 model, free 10-seat tier, signed license keys, seat-gate enforcement, and the admin license surface
- [Anonymous Analytics & Version Checks](./anonymous-analytics.md) — Opt-out anonymous telemetry pipeline (anonymous IDs, gating, capture paths, daily instance report) and the mandatory daily version check against the hosted Ping service
- [Public Docs Site](./public-docs-site.md) — Self-contained Mintlify workspace in `apps/docs` that powers the public product documentation site at docs.roomote.dev
