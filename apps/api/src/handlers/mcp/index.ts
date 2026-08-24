import { Hono, type MiddlewareHandler } from 'hono';
import {
  Env,
  areCuratedIntegrationsDisabled,
  isCustomMcpDisabled,
} from '@roomote/env';
import {
  getMcpIntegrationConnectionScope,
  isCredentialOnlyMcpIntegration,
  isNativeMcpIntegration,
  MCP_INTEGRATIONS,
} from '@roomote/types';

import type { Variables } from '../../types';

import { asanaMcp } from './asana';
import { communicationMcp } from './communication';
import { environmentsRouter } from '../environments';
import { customAutomationsRouter } from '../custom-automations';
import { tasksRouter } from '../tasks';
import { createCustomMcpProxy } from './custom-mcp';
import { createGbrainMcpProxy } from './gbrain';
import { createIntegrationMcpProxy } from './integration-mcp';
import { granolaMcp } from './granola';
import { grafanaMcp } from './grafana';
import { getIntegrationMcpProxyOptions } from './integration-mcp-policy';
import { createLinearMcp } from './linear';
import { mcpAuthMiddleware } from './middleware';
import { notionMcp } from './notion';
import { slackMcp } from './slack';
import { snowflakeMcp } from './snowflake';
import { vercelMcp } from './vercel';

export const mcp = new Hono<{ Variables: Variables }>();

const requireCuratedIntegrations: MiddlewareHandler<{
  Variables: Variables;
}> = async (c, next) => {
  if (areCuratedIntegrationsDisabled(Env.R_CURATED_INTEGRATIONS_DISABLED)) {
    return c.notFound();
  }

  await next();
};

for (const integration of MCP_INTEGRATIONS) {
  mcp.use(`/${integration.id}`, requireCuratedIntegrations);
  mcp.use(`/${integration.id}/*`, requireCuratedIntegrations);
}

// Deployment custom servers have their own kill switch, deliberately
// independent of the curated-catalog flag: operators who disable the catalog
// are the primary custom-server audience.
const requireCustomMcp: MiddlewareHandler<{
  Variables: Variables;
}> = async (c, next) => {
  if (isCustomMcpDisabled(Env.R_CUSTOM_MCP_DISABLED)) {
    return c.notFound();
  }

  await next();
};

mcp.use('/custom/*', requireCustomMcp);
mcp.route('/custom/:serverId', createCustomMcpProxy());

// Brain (deployment-hosted gbrain): a native-mode catalog
// integration with a custom handler, like snowflake/grafana below. The
// handler 404s per request unless the integration is enabled and a
// connection (admin-entered or R_GBRAIN_* env) exists.
mcp.route('/gbrain', createGbrainMcpProxy({ allowAuthTokens: true }));

mcp.route('/asana', asanaMcp);
mcp.route('/granola', granolaMcp);
mcp.route('/grafana', grafanaMcp);
mcp.route('/linear', createLinearMcp({ allowAuthTokens: true }));
mcp.route('/notion', notionMcp);
mcp.route('/snowflake', snowflakeMcp);
mcp.route('/vercel', vercelMcp);

for (const integration of MCP_INTEGRATIONS.filter(
  (candidate) =>
    !isNativeMcpIntegration(candidate) &&
    !isCredentialOnlyMcpIntegration(candidate) &&
    candidate.id !== 'linear',
)) {
  mcp.route(
    `/${integration.id}`,
    createIntegrationMcpProxy(integration, {
      ...getIntegrationMcpProxyOptions(integration),
      allowAuthTokens:
        getMcpIntegrationConnectionScope(integration) === 'deployment',
      allowAutomationTokens:
        getMcpIntegrationConnectionScope(integration) === 'deployment',
    }),
  );
}

// Task and agent routes share the mcpAuth middleware
mcp.use('/slack/*', mcpAuthMiddleware);
mcp.use('/slack', mcpAuthMiddleware);
mcp.use('/communication/*', mcpAuthMiddleware);
mcp.use('/communication', mcpAuthMiddleware);
mcp.use('/tasks/*', mcpAuthMiddleware);
mcp.use('/tasks', mcpAuthMiddleware);
mcp.use('/environments/*', mcpAuthMiddleware);
mcp.use('/environments', mcpAuthMiddleware);
mcp.use('/custom-automations/*', mcpAuthMiddleware);
mcp.use('/custom-automations', mcpAuthMiddleware);

mcp.route('/slack', slackMcp);
mcp.route('/communication', communicationMcp);
mcp.route('/tasks', tasksRouter);
mcp.route('/environments', environmentsRouter);
mcp.route('/custom-automations', customAutomationsRouter);
