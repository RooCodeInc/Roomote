import { Hono } from 'hono';

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

mcpRouting.route('/roomote', roomoteMcp);
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
    allowedToolNames: getAllowedRouterMcpToolNames('github'),
  }),
);
