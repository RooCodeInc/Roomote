import { createAuthToken } from '@roomote/auth';
import { Env } from '@roomote/env';
import {
  beginSlackFastIntegrationCall,
  completeSlackFastIntegrationCall,
  db,
  deploymentMcpEnablements,
  eq,
  githubInstallations,
  isBrainProviderConfigured,
  isNull,
} from '@roomote/db/server';
import {
  BRAIN_MCP_ID,
  getMcpIntegration,
  getMcpIntegrationConnectionScope,
  formatErrorForLog,
  isCredentialOnlyMcpIntegration,
} from '@roomote/types';

import {
  callMcpTool,
  listMcpTools,
  type McpToolDefinition,
} from '../mcp-tool-client';
import { isRouterMcpServerEnabled } from '../router/mcp-policy';
import { resolveApiBaseUrl } from '../shared-utils';
import { FAST_AGENT_BRAIN_INSTRUCTIONS } from './fast-agent-constants';
import {
  getFastAgentConversationStorageWorkspaceId,
  type FastAgentConversation,
} from './fast-agent-conversation';

export type FastAgentIntegration = {
  id: string;
  name: string;
  description: string;
  instructions?: string;
  tools: McpToolDefinition[];
};

type FastAgentIntegrationCandidate = Omit<FastAgentIntegration, 'tools'> & {
  disabledTools: Set<string>;
};

type BrokerContext = {
  userId: string;
  apiBaseUrl?: string;
};

type IntegrationAuditContext = BrokerContext & {
  sessionId: string;
  conversation: FastAgentConversation;
  messageId: string;
};

const FAST_AGENT_INTEGRATION_TOOL_CACHE_TTL_MS = 5 * 60_000;

type IntegrationToolCacheEntry = {
  expiresAt: number;
  tools: Promise<McpToolDefinition[]>;
};

const integrationToolCache = new Map<string, IntegrationToolCacheEntry>();

async function listCachedIntegrationTools(options: {
  url: string;
  headers: Record<string, string>;
}): Promise<McpToolDefinition[]> {
  const cached = integrationToolCache.get(options.url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tools;
  }

  const tools = listMcpTools(options);
  integrationToolCache.set(options.url, {
    expiresAt: Date.now() + FAST_AGENT_INTEGRATION_TOOL_CACHE_TTL_MS,
    tools,
  });

  try {
    return await tools;
  } catch (error) {
    if (integrationToolCache.get(options.url)?.tools === tools) {
      integrationToolCache.delete(options.url);
    }
    throw error;
  }
}

export function clearFastAgentIntegrationToolCache(): void {
  integrationToolCache.clear();
}

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
 * local transports, filesystem tools, or arbitrary proxy URLs. Tools disabled
 * by the deployment remain unavailable; calls to exposed tools are audited.
 */
export async function listFastAgentIntegrations(
  context: BrokerContext,
): Promise<FastAgentIntegration[]> {
  const [enabled, githubInstallation] = await Promise.all([
    db
      .select({
        mcpId: deploymentMcpEnablements.mcpId,
        disabledTools: deploymentMcpEnablements.disabledTools,
      })
      .from(deploymentMcpEnablements)
      .where(eq(deploymentMcpEnablements.enabled, true)),
    isRouterMcpServerEnabled('github')
      ? db.query.githubInstallations.findFirst({
          where: isNull(githubInstallations.suspendedAt),
          columns: { id: true },
        })
      : Promise.resolve(undefined),
  ]);

  const candidates: FastAgentIntegrationCandidate[] = enabled.flatMap(
    ({ mcpId, disabledTools }) => {
      const integration = getMcpIntegration(mcpId);
      return isFastModeIntegration(integration)
        ? [
            {
              id: integration.id,
              name: integration.name,
              description: integration.description,
              disabledTools: new Set(disabledTools ?? []),
            },
          ]
        : [];
    },
  );

  // Same activation rule as sandbox MCP delivery: only an explicit R_BRAIN_*
  // provider key means the deployment has a Brain, because the URL and
  // gateway token are template-defaulted plumbing on some platforms.
  if (Env.R_GBRAIN_URL && (await isBrainProviderConfigured())) {
    candidates.push({
      id: BRAIN_MCP_ID,
      name: 'Brain',
      description:
        "Read this deployment's shared memory of completed tasks and connected integration activity.",
      instructions: FAST_AGENT_BRAIN_INSTRUCTIONS,
      disabledTools: new Set<string>(),
    });
  }

  if (githubInstallation) {
    candidates.push({
      id: 'github',
      name: 'GitHub',
      description:
        'Read repositories, code, issues, pull requests, commits, and recent activity available to the deployment GitHub App.',
      disabledTools: new Set<string>(),
    });
  }

  if (candidates.length === 0) {
    return [];
  }

  const { apiBaseUrl, authToken } = await resolveBrokerAuth(context);
  const results = await Promise.allSettled(
    candidates.map(async (integration) => ({
      ...integration,
      tools: (
        await listCachedIntegrationTools({
          url: integrationProxyUrl(apiBaseUrl, integration.id),
          headers: { Authorization: `Bearer ${authToken}` },
        })
      ).filter((tool) => !integration.disabledTools.has(tool.name)),
    })),
  );

  return results.flatMap((result) =>
    result.status === 'fulfilled' && result.value.tools.length > 0
      ? [
          {
            id: result.value.id,
            name: result.value.name,
            description: result.value.description,
            instructions: result.value.instructions,
            tools: result.value.tools,
          },
        ]
      : [],
  );
}

function serializeAuditPreview(value: unknown, maxLength: number): string {
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, maxLength);
  } catch {
    return '[Unserializable integration result]';
  }
}

export async function callFastAgentIntegration(
  context: IntegrationAuditContext,
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

  // Fail closed: an integration tool never executes unless its durable audit
  // record exists first.
  const audit = await beginSlackFastIntegrationCall({
    slackQuickAnswerId: context.sessionId,
    userId: context.userId,
    // The persisted audit schema is legacy Slack-shaped; the broker boundary
    // remains provider-neutral while a later N-1-safe migration renames it.
    slackTeamId: getFastAgentConversationStorageWorkspaceId(
      context.conversation,
    ),
    slackChannel: context.conversation.replyTarget.channelId,
    slackThreadTs: context.conversation.conversationId,
    slackMessageTs: context.messageId,
    integrationId: integration.id,
    toolName: request.toolName,
    arguments: request.args,
  });

  try {
    const { apiBaseUrl, authToken } = await resolveBrokerAuth(context);
    const result = await callMcpTool({
      url: integrationProxyUrl(apiBaseUrl, integration.id),
      headers: { Authorization: `Bearer ${authToken}` },
      toolName: request.toolName,
      args: request.args,
      toolCallId: `fast:${audit.id}:${integration.id}:${request.toolName}`,
    });

    try {
      await completeSlackFastIntegrationCall({
        id: audit.id,
        status: 'succeeded',
        resultPreview: serializeAuditPreview(result, 30_000),
        startedAt: audit.startedAt,
      });
    } catch (error) {
      console.warn(
        `[Fast Agent] Could not complete integration audit ${audit.id}: ${formatErrorForLog(error)}`,
      );
    }

    return result;
  } catch (error) {
    try {
      await completeSlackFastIntegrationCall({
        id: audit.id,
        status: 'failed',
        error: formatErrorForLog(error).slice(0, 10_000),
        startedAt: audit.startedAt,
      });
    } catch (auditError) {
      console.warn(
        `[Fast Agent] Could not complete failed integration audit ${audit.id}: ${formatErrorForLog(auditError)}`,
      );
    }
    throw error;
  }
}
