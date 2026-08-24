import { Hono, type MiddlewareHandler } from 'hono';
import { Env, areCuratedIntegrationsDisabled } from '@roomote/env';

import type { Variables } from '../../types';

import { getAllowedRouterMcpToolNames } from '@roomote/cloud-agents/router-mcp-policy';

import { createGithubMcp } from './github';
import { createLinearMcp } from './linear';
import { roomoteMcp } from './roomote';

/**
 * Router-facing MCP endpoints.
 * These accept user-scoped auth tokens so the LLM router can gather context
 * before a task run exists.
 */
export const mcpRouting = new Hono<{ Variables: Variables }>();

const requireCuratedIntegrations: MiddlewareHandler<{
  Variables: Variables;
}> = async (c, next) => {
  if (areCuratedIntegrationsDisabled(Env.R_CURATED_INTEGRATIONS_DISABLED)) {
    return c.notFound();
  }

  await next();
};

mcpRouting.route('/roomote', roomoteMcp);
mcpRouting.use('/linear', requireCuratedIntegrations);
mcpRouting.use('/linear/*', requireCuratedIntegrations);
mcpRouting.route(
  '/linear',
  createLinearMcp({
    allowAuthTokens: true,
    allowedToolNames: getAllowedRouterMcpToolNames('linear'),
  }),
);
mcpRouting.route(
  '/github',
  createGithubMcp({
    allowAuthTokens: true,
    allowAutomationTokens: true,
    allowedToolNames: getAllowedRouterMcpToolNames('github'),
  }),
);
