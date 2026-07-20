import { Hono } from 'hono';
import { isNativeMcpIntegration, MCP_INTEGRATIONS } from '@roomote/types';

import type { Variables } from '../../types';

import { asanaMcp } from './asana';
import { environmentsRouter } from '../environments';
import { tasksRouter } from '../tasks';
import { createIntegrationMcpProxy } from './integration-mcp';
import { grafanaMcp } from './grafana';
import { getIntegrationMcpProxyOptions } from './integration-mcp-policy';
import { linearMcp } from './linear';
import { mcpAuthMiddleware } from './middleware';
import { discordMcp } from './discord';
import { slackMcp } from './slack';
import { snowflakeMcp } from './snowflake';
import { vercelMcp } from './vercel';

export const mcp = new Hono<{ Variables: Variables }>();

mcp.route('/asana', asanaMcp);
mcp.route('/grafana', grafanaMcp);
mcp.route('/linear', linearMcp);
mcp.route('/snowflake', snowflakeMcp);
mcp.route('/vercel', vercelMcp);

for (const integration of MCP_INTEGRATIONS.filter(
  (candidate) =>
    !isNativeMcpIntegration(candidate) && candidate.id !== 'linear',
)) {
  mcp.route(
    `/${integration.id}`,
    createIntegrationMcpProxy(
      integration,
      getIntegrationMcpProxyOptions(integration),
    ),
  );
}

// Task and agent routes share the mcpAuth middleware
mcp.use('/slack/*', mcpAuthMiddleware);
mcp.use('/slack', mcpAuthMiddleware);
mcp.use('/discord/*', mcpAuthMiddleware);
mcp.use('/discord', mcpAuthMiddleware);
mcp.use('/tasks/*', mcpAuthMiddleware);
mcp.use('/tasks', mcpAuthMiddleware);
mcp.use('/environments/*', mcpAuthMiddleware);
mcp.use('/environments', mcpAuthMiddleware);

mcp.route('/slack', slackMcp);
mcp.route('/discord', discordMcp);
mcp.route('/tasks', tasksRouter);
mcp.route('/environments', environmentsRouter);
