import { createAuthToken } from '@roomote/auth';
import {
  beginSlackFastIntegrationCall,
  completeSlackFastIntegrationCall,
  db,
  githubInstallations,
  isNull,
} from '@roomote/db/server';
import {
  BRAIN_MCP_ID,
  getMcpIntegration,
  formatErrorForLog,
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
  type FastAgentMcpServerConfig,
  type FastAgentConversation,
} from './fast-agent-conversation';

export type FastAgentIntegration = {
  id: string;
  name: string;
  description: string;
  instructions?: string;
  tools: McpToolDefinition[];
  endpoint?: {
    url: string;
    headers: Record<string, string>;
  };
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
const FAST_AGENT_INTEGRATION_TOOL_CACHE_RETRY_MS = 30_000;
const FAST_AGENT_INTEGRATION_DISCOVERY_TIMEOUT_MS = 10_000;
const FAST_AGENT_INTEGRATION_CALL_TIMEOUT_MS = 60_000;

type IntegrationToolCacheEntry = {
  expiresAt: number;
  tools: Promise<McpToolDefinition[]>;
};

const integrationToolCache = new Map<string, IntegrationToolCacheEntry>();

async function withFastIntegrationTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(
        `${operationName} timed out after ${timeoutMs}ms.`,
      );
      abortController.abort(error);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([
      operation(abortController.signal),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function listCachedIntegrationTools(options: {
  cacheKey: string;
  url: string;
  headers: Record<string, string>;
}): Promise<McpToolDefinition[]> {
  const { cacheKey, ...clientOptions } = options;
  const cached = integrationToolCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      // Keep serving the last known-good catalog while refreshing. Fast turns
      // must never wait behind a deployment MCP server that stopped answering
      // after it was previously discovered successfully.
      cached.expiresAt =
        Date.now() + FAST_AGENT_INTEGRATION_TOOL_CACHE_RETRY_MS;
      const refresh = withFastIntegrationTimeout(
        (signal) => listMcpTools({ ...clientOptions, signal }),
        FAST_AGENT_INTEGRATION_DISCOVERY_TIMEOUT_MS,
        'Fast integration tool discovery',
      );
      void refresh
        .then((tools) => {
          if (integrationToolCache.get(cacheKey) === cached) {
            integrationToolCache.set(cacheKey, {
              expiresAt: Date.now() + FAST_AGENT_INTEGRATION_TOOL_CACHE_TTL_MS,
              tools: Promise.resolve(tools),
            });
          }
        })
        .catch(() => {
          if (integrationToolCache.get(cacheKey) === cached) {
            cached.expiresAt =
              Date.now() + FAST_AGENT_INTEGRATION_TOOL_CACHE_RETRY_MS;
          }
        });
    }

    return cached.tools;
  }

  const tools = withFastIntegrationTimeout(
    (signal) => listMcpTools({ ...clientOptions, signal }),
    FAST_AGENT_INTEGRATION_DISCOVERY_TIMEOUT_MS,
    'Fast integration tool discovery',
  );
  integrationToolCache.set(cacheKey, {
    expiresAt: Date.now() + FAST_AGENT_INTEGRATION_TOOL_CACHE_TTL_MS,
    tools,
  });

  try {
    return await tools;
  } catch (error) {
    if (integrationToolCache.get(cacheKey)?.tools === tools) {
      integrationToolCache.delete(cacheKey);
    }
    throw error;
  }
}

export function clearFastAgentIntegrationToolCache(): void {
  integrationToolCache.clear();
}

function integrationProxyUrl(baseUrl: string, integrationId: string): string {
  const relativePath =
    integrationId === 'github'
      ? 'api/mcp-routing/github'
      : `api/mcp/${encodeURIComponent(integrationId)}`;
  return new URL(relativePath, `${baseUrl}/`).toString();
}

function describeMcpServer(
  id: string,
): Pick<FastAgentIntegration, 'name' | 'description' | 'instructions'> {
  if (id === 'roomote') {
    return {
      name: 'Roomote',
      description:
        'Manage this Roomote deployment, including custom automations and other deployment capabilities.',
    };
  }
  if (id === BRAIN_MCP_ID) {
    return {
      name: 'Brain',
      description:
        "Read this deployment's shared memory of completed tasks and connected integration activity.",
      instructions: FAST_AGENT_BRAIN_INSTRUCTIONS,
    };
  }
  const integration = getMcpIntegration(id);
  return {
    name: integration?.name ?? id,
    description:
      integration?.description ??
      'Use tools from this deployment-configured MCP server.',
  };
}

function resolveFastMcpEndpoint(options: {
  apiBaseUrl: string;
  authToken: string;
  config: FastAgentMcpServerConfig;
}) {
  const apiUrl = new URL(options.apiBaseUrl);
  const configuredUrl = new URL(options.config.url, options.apiBaseUrl);
  const isDeploymentProxy =
    configuredUrl.origin === apiUrl.origin &&
    (configuredUrl.pathname.startsWith('/api/mcp/') ||
      configuredUrl.pathname.startsWith('/api/mcp-routing/'));

  if (!isDeploymentProxy) {
    return {
      url: configuredUrl.toString(),
      headers: options.config.headers,
    };
  }

  const relativePath = `${configuredUrl.pathname.replace(/^\/+/, '')}${configuredUrl.search}`;
  return {
    url: new URL(relativePath, `${options.apiBaseUrl}/`).toString(),
    headers: {
      ...options.config.headers,
      Authorization: `Bearer ${options.authToken}`,
    },
  };
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
 * Actor-resolved remote MCP servers only. Local transports and filesystem
 * tools remain sandbox-only. Tools disabled by the deployment remain
 * unavailable, and calls to exposed tools are audited.
 */
export async function listFastAgentIntegrations(
  context: BrokerContext,
  resolveMcpServerConfigs?: () => Promise<
    Record<string, FastAgentMcpServerConfig>
  >,
): Promise<FastAgentIntegration[]> {
  const configuredServersPromise: Promise<
    Record<string, FastAgentMcpServerConfig>
  > = resolveMcpServerConfigs?.() ?? Promise.resolve({});
  const [configuredServers, githubInstallation] = await Promise.all([
    configuredServersPromise,
    isRouterMcpServerEnabled('github')
      ? db.query.githubInstallations.findFirst({
          where: isNull(githubInstallations.suspendedAt),
          columns: { id: true },
        })
      : Promise.resolve(undefined),
  ]);
  const { apiBaseUrl, authToken } = await resolveBrokerAuth(context);
  const candidates: FastAgentIntegrationCandidate[] = Object.entries(
    configuredServers,
  ).map(([id, config]) => ({
    id,
    ...describeMcpServer(id),
    endpoint: resolveFastMcpEndpoint({ apiBaseUrl, authToken, config }),
    disabledTools: new Set(config.disabledTools ?? []),
  }));

  if (githubInstallation && !configuredServers.github) {
    candidates.push({
      id: 'github',
      name: 'GitHub',
      description:
        'Read repositories, code, issues, pull requests, commits, and recent activity available to the deployment GitHub App.',
      endpoint: {
        url: integrationProxyUrl(apiBaseUrl, 'github'),
        headers: { Authorization: `Bearer ${authToken}` },
      },
      disabledTools: new Set<string>(),
    });
  }

  if (candidates.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(
    candidates.map(async (integration) => ({
      ...integration,
      tools: (
        await listCachedIntegrationTools({
          cacheKey: `${context.userId}:${integration.endpoint!.url}`,
          url: integration.endpoint!.url,
          headers: integration.endpoint!.headers,
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
            endpoint: result.value.endpoint,
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
    fastAgentConversationId: context.sessionId,
    userId: context.userId,
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
    const endpoint =
      integration.endpoint ??
      ({
        url: integrationProxyUrl(apiBaseUrl, integration.id),
        headers: { Authorization: `Bearer ${authToken}` },
      } as const);
    const result = await withFastIntegrationTimeout(
      (signal) =>
        callMcpTool({
          url: endpoint.url,
          headers: endpoint.headers,
          toolName: request.toolName,
          args: request.args,
          toolCallId: `fast:${audit.id}:${integration.id}:${request.toolName}`,
          signal,
        }),
      FAST_AGENT_INTEGRATION_CALL_TIMEOUT_MS,
      `Fast ${integration.id}/${request.toolName} integration call`,
    );

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
