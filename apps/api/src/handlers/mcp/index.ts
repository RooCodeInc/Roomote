import { Hono, type MiddlewareHandler } from 'hono';
import {
  Env,
  areCuratedIntegrationsDisabled,
  isCustomMcpDisabled,
} from '@roomote/env';
import {
  isCredentialOnlyMcpIntegration,
  isNativeMcpIntegration,
  MCP_INTEGRATIONS,
} from '@roomote/types';

import type { Variables } from '../../types';

import { asanaMcp } from './asana';
import { bitbucketMcp } from './bitbucket';
import { adoMergeMcp, giteaMergeMcp } from './native-provider-merge';
import { communicationMcp } from './communication';
import { environmentsRouter } from '../environments';
import { customAutomationsRouter } from '../custom-automations';
import { customSkillsRouter } from '../custom-skills';
import { tasksRouter } from '../tasks';
import { sessionsRouter } from '../sessions';
import { createCustomMcpProxy } from './custom-mcp';
import { createGbrainMcpProxy } from './gbrain';
import { createIntegrationMcpProxy } from './integration-mcp';
import { granolaMcp } from './granola';
import { grafanaMcp } from './grafana';
import { getIntegrationMcpProxyOptions } from './integration-mcp-policy';
import { createLinearMcp } from './linear';
import { activeRunMcpAuthMiddleware, mcpAuthMiddleware } from './middleware';
import { notionMcp } from './notion';
import { slackMcp } from './slack';
import { snowflakeMcp } from './snowflake';
import { vercelMcp } from './vercel';
import { createHttpIntegrationsMcp } from './http-integrations';
import { developmentFixturesMcp } from './development-fixtures';
import { publicUrlFetchRoute } from './public-url-fetch-route';
import { artifactMcpRouter } from './artifacts';

export const mcp = new Hono<{ Variables: Variables }>();

// integration keys are live; the operator flag controls only manifest integrations.
mcp.route('/http-integrations', createHttpIntegrationsMcp());

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
mcp.route('/development-fixtures', developmentFixturesMcp);

function registerNativeMcpRoute<E extends { Variables: Variables }>(
  path: string,
  router: Hono<E>,
) {
  mcp.use(path, mcpAuthMiddleware, activeRunMcpAuthMiddleware);
  mcp.use(`${path}/*`, mcpAuthMiddleware, activeRunMcpAuthMiddleware);
  mcp.route(path, router);
}

registerNativeMcpRoute('/public-url-fetch', publicUrlFetchRoute);

// Brain (deployment-hosted gbrain): a native-mode catalog
// integration with a custom handler, like snowflake/grafana below. The
// handler 404s per request unless the integration is enabled and a
// connection (admin-entered or R_GBRAIN_* env) exists.
mcp.route('/gbrain', createGbrainMcpProxy({ allowAuthTokens: true }));

mcp.route('/asana', asanaMcp);
mcp.use('/bitbucket', requireCuratedIntegrations);
mcp.use('/bitbucket/*', requireCuratedIntegrations);
mcp.use('/ado', requireCuratedIntegrations);
mcp.use('/ado/*', requireCuratedIntegrations);
mcp.use('/gitea', requireCuratedIntegrations);
mcp.use('/gitea/*', requireCuratedIntegrations);
mcp.route('/bitbucket', bitbucketMcp);
mcp.route('/ado', adoMergeMcp);
mcp.route('/gitea', giteaMergeMcp);
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
      // Fast turns authenticate with the acting user's auth token. Credential
      // resolution is actor-scoped either way: deployment-scoped integrations
      // use the org-wide connection, and user-scoped integrations only ever
      // resolve the token holder's own connection.
      allowAuthTokens: true,
    }),
  );
}

registerNativeMcpRoute('/slack', slackMcp);
registerNativeMcpRoute('/communication', communicationMcp);
registerNativeMcpRoute('/tasks', tasksRouter);
registerNativeMcpRoute('/sessions', sessionsRouter);
registerNativeMcpRoute('/environments', environmentsRouter);
registerNativeMcpRoute('/custom-automations', customAutomationsRouter);
registerNativeMcpRoute('/custom-skills', customSkillsRouter);
registerNativeMcpRoute('/artifacts', artifactMcpRouter);
