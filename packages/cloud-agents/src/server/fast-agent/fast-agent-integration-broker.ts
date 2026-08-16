import { createAuthToken } from '@roomote/auth';
import {
  db,
  deploymentMcpEnablements,
  eq,
  githubInstallations,
  isNull,
} from '@roomote/db/server';
import {
  getMcpIntegration,
  getMcpIntegrationConnectionScope,
  isCredentialOnlyMcpIntegration,
} from '@roomote/types';

import {
  callMcpTool,
  listMcpTools,
  type McpToolDefinition,
} from '../mcp-tool-client';
import { isRouterMcpServerEnabled } from '../router/mcp-policy';
import { resolveApiBaseUrl } from '../shared-utils';

export type FastAgentIntegration = {
  id: string;
  name: string;
  description: string;
  tools: McpToolDefinition[];
};

type BrokerContext = {
  userId: string;
  apiBaseUrl?: string;
};

function isFastModeIntegration(
  integration: ReturnType<typeof getMcpIntegration>,
): integration is NonNullable<ReturnType<typeof getMcpIntegration>> {
  return Boolean(
    integration &&
    getMcpIntegrationConnectionScope(integration) === 'deployment' &&
    !isCredentialOnlyMcpIntegration(integration),
  );
}

function integrationProxyUrl(baseUrl: string, integrationId: string): string {
  const relativePath =
    integrationId === 'github'
      ? 'api/mcp-routing/github'
      : `api/mcp/${encodeURIComponent(integrationId)}`;
  return new URL(relativePath, `${baseUrl}/`).toString();
}

async function resolveBrokerAuth(context: BrokerContext) {
  const apiBaseUrl = resolveApiBaseUrl(context.apiBaseUrl);
  if (!apiBaseUrl) {
    throw new Error('Integration API base URL is unavailable.');
  }

  return {
    apiBaseUrl,
    authToken: await createAuthToken({
      userId: context.userId,
      timeoutMs: 2 * 60_000,
    }),
  };
}

/**
 * Deployment integrations only. Fast mode never receives MCP server configs,
 * local transports, filesystem tools, or arbitrary proxy URLs.
 */
export async function listFastAgentIntegrations(
  context: BrokerContext,
): Promise<FastAgentIntegration[]> {
  const [enabled, githubInstallation] = await Promise.all([
    db
      .select({ mcpId: deploymentMcpEnablements.mcpId })
      .from(deploymentMcpEnablements)
      .where(eq(deploymentMcpEnablements.enabled, true)),
    isRouterMcpServerEnabled('github')
      ? db.query.githubInstallations.findFirst({
          where: isNull(githubInstallations.suspendedAt),
          columns: { id: true },
        })
      : Promise.resolve(undefined),
  ]);

  const candidates = enabled
    .map(({ mcpId }) => getMcpIntegration(mcpId))
    .filter(isFastModeIntegration)
    .map((integration) => ({
      id: integration.id,
      name: integration.name,
      description: integration.description,
    }));

  if (githubInstallation) {
    candidates.push({
      id: 'github',
      name: 'GitHub',
      description:
        'Read repositories, code, issues, pull requests, commits, and recent activity available to the deployment GitHub App.',
    });
  }

  if (candidates.length === 0) {
    return [];
  }

  const { apiBaseUrl, authToken } = await resolveBrokerAuth(context);
  const results = await Promise.allSettled(
    candidates.map(async (integration) => ({
      ...integration,
      tools: await listMcpTools({
        url: integrationProxyUrl(apiBaseUrl, integration.id),
        headers: { Authorization: `Bearer ${authToken}` },
      }),
    })),
  );

  return results.flatMap((result) =>
    result.status === 'fulfilled' && result.value.tools.length > 0
      ? [result.value]
      : [],
  );
}

export async function callFastAgentIntegration(
  context: BrokerContext,
  available: FastAgentIntegration[],
  request: {
    integrationId: string;
    toolName: string;
    args: Record<string, unknown>;
  },
): Promise<unknown> {
  const integration = available.find(
    (candidate) => candidate.id === request.integrationId,
  );
  if (!integration) {
    throw new Error('That integration is not available to fast mode.');
  }
  if (!integration.tools.some((tool) => tool.name === request.toolName)) {
    throw new Error('That integration tool is not available to fast mode.');
  }

  const { apiBaseUrl, authToken } = await resolveBrokerAuth(context);
  return callMcpTool({
    url: integrationProxyUrl(apiBaseUrl, integration.id),
    headers: { Authorization: `Bearer ${authToken}` },
    toolName: request.toolName,
    args: request.args,
    toolCallId: `fast:${integration.id}:${request.toolName}`,
  });
}
