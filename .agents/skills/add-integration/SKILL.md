---
name: add-integration
description: Add a new built-in MCP integration to Roomote. Use when adding a new third-party service (e.g. Asana, Datadog, Vercel) to the built-in integrations catalog shown in Settings/Integrations.
---

# Add Integration

Use this skill when the task is to add a new curated MCP integration to Roomote's built-in integration catalog, setup recommendations, Slack URL detection, integration setup guidance, and docs.

## Start Here

Read the current built-in integration surfaces before editing:

- `.agent-guidance/features/mcp-servers.md`
- `packages/types/src/mcp-oauth.ts`
- `packages/types/src/mcp-service-detection.ts`
- `packages/cloud-agents/src/server/mcp-self-setup/catalog.ts`
- `apps/worker/src/mcp/roomote-mcp-server/integration-setup.ts`

Use existing services as reference implementations:

- Open upstream OAuth with dynamic client registration: Notion, Sentry, PostHog, Neon, Supabase, Braintrust
- Upstream proxy plus explicit read-only policy: Better Stack
- Native admin-configured server: Snowflake

Do not start editing until the access model, connection scope, and read-only posture are explicit.

## Prerequisite Research

Determine the access model first. This is the decision that controls the rest of the implementation.

1. Search the service's official docs for:
   - `<service> MCP server`
   - `<service> Model Context Protocol`
   - `<service> OAuth`
2. Confirm whether the service ships a remote MCP server.
3. If it does, confirm how that server authenticates:
   - dynamic client registration
   - static OAuth client credentials
   - waitlist, partnership, or allowlist restrictions
4. Check whether the server already exposes only read-only tools, or whether Roomote must constrain tool access at the proxy layer.

Prefer the provider's own docs over blog posts, aggregators, or community examples.

## Access Model Decision Tree

### 1. Remote MCP server exists

Check whether the remote server is open to any MCP client and supports OAuth with dynamic client registration (RFC 7591).

- If yes, use `serverMode: 'upstream_proxy'` with the standard OAuth flow.
- This is the ideal path and matches integrations such as Notion, Sentry, Railway, Better Stack, Neon, Supabase, Braintrust, and PostHog.

### 2. Remote MCP server exists, but access is restricted

If the provider requires a waitlist, partnership, explicit allowlist, or another closed-client arrangement:

- Stop.
- Ask the user whether to pursue a partnership, wait for open access, or choose another approach.

Do not add the service as a built-in integration until that restriction is resolved.

### 3. Remote MCP server exists, but uses static OAuth credentials

If the provider does not support dynamic registration and instead requires a fixed OAuth client ID or secret:

- Stop.
- Ask the user whether they want to introduce deployment-managed static OAuth credentials for that integration.

Do not add static OAuth client handling as a new built-in pattern without that explicit product decision.

### 3b. Remote MCP server exists, but OAuth app distribution requires review or approval

Some providers let you create an OAuth app and use it immediately for your own workspace, but require an app review or approval process before customers in other workspaces or organizations can authorize through it.

This is different from a waitlist on the MCP server itself. The remote MCP server is open, but the OAuth app cannot be broadly distributed until the provider approves it.

- Check the provider's developer docs for sections such as `publish your app`, `submit for review`, `app distribution`, or equivalent OAuth publishing guidance.
- If review or approval is required for cross-organization OAuth distribution: stop and ask the user to choose one of these paths:
  - Submit the OAuth app for review and wait for approval, even if that takes weeks.
  - Build a native MCP server using the provider's REST API plus admin-configured credentials such as a PAT or API key instead. Use Snowflake as the baseline pattern for this path.
  - Do both: ship the native integration first, submit the OAuth app for review in parallel, and upgrade to the upstream proxy later.

### 4. No remote MCP server exists

Stop and ask the user to choose one of these paths:

- Build a native MCP server inside Roomote with `serverMode: 'native'` and `connectionMode: 'admin_configured'`
- Wait for the provider to ship an official remote MCP server
- Recommend that the user configure a custom MCP server in their environment instead

Do not quietly convert a missing remote MCP into a built-in integration without that product decision.

## Connection Scope Decision

Choose connection scope after the access model is clear.

- Use `'user'` by default when each user should connect their own account or when the data is primarily personal to the actor.
- Use `'organization'` when one admin should connect shared workspace data for everyone.

Common rule of thumb:

- Personal docs, personal databases, or user-owned workspaces usually stay `'user'`
- Monitoring, infrastructure, analytics, and shared operational data usually become `'organization'`

Reference examples:

- `'user'`: Notion, Neon, Supabase, Braintrust
- `'organization'`: Sentry, Better Stack, Railway, PostHog

Write down the reasoning in the final output. Do not pick organization scope by habit.

## Read-Only Tool Policy Decision

Inspect the upstream MCP tool surface before deciding whether Roomote needs an explicit allowlist.

- Read the provider's MCP tool documentation first.
- If the docs are incomplete, inspect the upstream `tools/list` response before finalizing the policy.
- Enumerate every available tool name.
- Decide which tools are safe for read-only proxying.

Add a policy in `apps/api/src/handlers/mcp/integration-mcp-policy.ts` when the upstream server exposes mutating operations.

Follow the existing patterns:

- `BETTER_STACK_READ_ONLY_TOOL_NAMES`
- `INTEGRATION_MCP_ALLOWED_TOOL_NAMES`

Skip the policy only when the upstream is already constrained to read-only behavior, such as Supabase's `?read_only=true` endpoint.

Do not claim a service is read-only without checking the actual tool surface.

## Implementation Checklist

Read each target file before editing it. Follow the existing service entries rather than inventing a new shape.

1. `packages/types/src/mcp-oauth.ts`
   - Add the new entry to `MCP_INTEGRATIONS`
   - Required fields: `id`, `name`, `url` for upstream proxies, `description`, `icon`
   - Optional fields: `connectionScope`, `serverMode`, `connectionMode`, `oauthClientEnv`, `oauthScopes`, `authorizationParameters`, `homepageCard`
   - Use `PRODUCT_NAME` in descriptions where the surrounding entries already do

2. `packages/types/src/mcp-service-detection.ts`
   - Add the service to `SLACK_MCP_SETUP_SERVICES`
   - Use app-domain host suffixes, not docs or marketing domains
   - Add `pathPrefixes` only when the domain also hosts unrelated content

3. `packages/cloud-agents/src/server/mcp-self-setup/catalog.ts`
   - Add the integration ID to `setupMcpRecommendationIds`
   - Add a full `AVAILABLE_SETUP_MCP_INTEGRATIONS` entry with:
     - `id`
     - `name`
     - `category: 'built_in_integration'`
     - `description`
     - `capabilities` with three bullets
     - `setupLocation`

4. `apps/worker/src/mcp/roomote-mcp-server/integration-setup.ts`
   - Add a `# ServiceName` section to `INTEGRATION_SETUP_CONTENT`
   - For deployment scope, say:
     - "A deployment operator enables X from Settings > Integrations."
     - "That operator connects X once for the deployment via OAuth."
   - For user scope, say:
     - "A deployment operator enables X from Settings > Integrations."
     - "Each user connects their own account via OAuth."

5. `apps/api/src/handlers/mcp/integration-mcp-policy.ts`
   - Add `const SERVICE_READ_ONLY_TOOL_NAMES = [...]` when the upstream exposes mutating tools
   - Register it in `INTEGRATION_MCP_ALLOWED_TOOL_NAMES`
   - Skip this file only when the upstream is already read-only

6. `apps/web/src/components/system/custom/logos/brand-icon.tsx`
   - Import the icon from `simple-icons`
   - Add it to `SIMPLE_ICONS`
   - Confirm the icon exists in the installed `simple-icons` package before editing

7. `apps/web/src/components/settings/Integrations.tsx`
   - Add `DEEP_LINK_ENABLE_DESCRIPTIONS[serviceId]`

8. `packages/slack/src/mcp-recommendations.ts`
   - Add `SLACK_ENABLE_DESCRIPTIONS[serviceId]`

9. `.agent-guidance/features/mcp-servers.md`
   - Update the curated integration catalog section
   - Add a short paragraph explaining:
     - access model
     - connection scope
     - read-only policy or lack of one

10. `apps/marketing/src/pages/index.astro`
   - When the new service is a customer-facing supported integration that should appear in marketing, add it to the homepage integrations list in the same change
   - Keep the marketing list aligned with what Roomote actively supports, not internal-only dependencies
   - Write the marketing integration description around the benefit to users, not as a CTA to install or connect the service
   - Use the existing descriptions in `apps/marketing/src/data/integrations.ts` as the reference for tone, length, and structure

11. `apps/docs`
   - When the new service should appear in the public docs integration list, add or update its page under `apps/docs/integrations/`, add it to `apps/docs/docs.json`, and update `apps/docs/integrations/index.mdx`
   - For integration logos in the overview list, use `apps/docs/snippets/integration-name.jsx`
   - Prefer an Iconify Simple Icons slug in `<IntegrationName icon="..." />` when Iconify ships the logo
   - If Iconify Simple Icons does not ship the logo yet, add a manual monochrome fallback to `manualIconFallbacks` inside `IntegrationName` in `apps/docs/snippets/integration-name.jsx` and document the key in the MDX usage
   - For sidebar/page icons, use an Iconify Simple Icons URL in page frontmatter when available, such as `icon: 'https://api.iconify.design/simple-icons:asana.svg?color=%23111827'`; otherwise keep a Lucide fallback like `plug` until a source-backed icon is available. If the user provides a manual source asset, vectorize and recolor it under `apps/docs/logo/integrations/` and point frontmatter at that file.

12. Shared PR-linked work-item rendering
   - If the new integration can originate or resolve issue/task references that should appear in pull request metadata, update the canonical task-context mapping for those work items instead of inventing an integration-specific PR-body field
   - Add or update the provider adapter in the shared PR metadata renderer under `packages/cloud-agents/src/server/workflows/`
   - Add formatter and task-context tests for the new provider behavior
   - Update the relevant internal guidance in the same change so future integration work keeps the renderer in sync

## Native Integration Branch

If the service has no remote MCP server and the user chooses the native Roomote path, treat the checklist above as incomplete.

At minimum, also expect to implement:

- a native API handler under `apps/api/src/handlers/mcp/<service>/`
- any auth or credential storage path needed for `admin_configured` connections
- worker-facing MCP config support through the existing integration config flow
- additional docs and tests for the native server itself

Use Snowflake as the baseline for that branch.

## Test Checklist

Add or update tests that cover the new integration's metadata, setup copy, Slack detection, and UI surfaces. Run the smallest command set that proves the change.

- `pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/cloud-agents exec vitest run src/server/router/__tests__/slack-mcp-setup.test.ts`
- `pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/sdk exec vitest run src/server/routers/mcp-connections.test.ts`
- `pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/worker exec vitest run src/mcp/roomote-mcp-server/__tests__/integration-setup.test.ts`
- `pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/web exec vitest run src/components/settings/Integrations.test.tsx src/components/settings/LinkedAccounts.test.tsx 'src/app/(authenticated)/home/OnboardingCard.client.test.tsx'`
- `pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/api exec vitest run src/handlers/mcp/__tests__/integration-mcp-auth.test.ts`
- `pnpm check-types`
- `node .agents/skills/agent-guidance-maintenance/scripts/knowledge-check.mjs`

Run the API auth test only when you added or changed a read-only tool policy.

## Guardrails

- Do not add a built-in integration until the access model is confirmed from official docs.
- Do not assume every remote MCP server supports dynamic registration.
- Do not assume an OAuth app that works in your own workspace will automatically work for customers in other organizations. Check the provider's app distribution and review requirements.
- Do not use marketing or docs domains in Slack URL detection.
- Do not add a read-only policy until you have enumerated real tool names.
- Do not skip `.agent-guidance/features/mcp-servers.md` when the built-in catalog changes.
- Do not skip the homepage integrations list in `apps/marketing/src/pages/index.astro` when the new integration is customer-facing and belongs in the marketed support set.
- Do not default to organization scope without explicit shared-data reasoning.
- Do not continue past a waitlist or restricted-access upstream without user direction.
- Do not add an integration that can produce PR-linkable work items without also updating the canonical task-context mapping, shared PR renderer adapter, targeted tests, and internal guidance in the same change.

## Output Standard

End by reporting:

- which access model was selected and why
- which connection scope was chosen and why
- whether a read-only tool policy was needed
- every file created or modified
- the test results, including anything intentionally skipped
