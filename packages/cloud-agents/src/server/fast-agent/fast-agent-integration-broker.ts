import {
  createAuthToken,
  createSessionBrokerToken,
  ROOMOTE_MCP_PATH,
} from '@roomote/auth';
import { Env, areCuratedIntegrationsDisabled } from '@roomote/env';
import {
  HTTP_INTEGRATIONS_MCP_ID,
  HTTP_INTEGRATIONS_INSTRUCTIONS,
} from '../../http-integrations';
import {
  getBitbucketOAuthConnection,
  resolveBitbucketInstanceHost,
} from '@roomote/bitbucket';
import {
  and,
  beginSlackFastIntegrationCall,
  completeSlackFastIntegrationCall,
  db,
  deploymentSecrets,
  eq,
  githubInstallations,
  isNull,
  repositories,
  users,
} from '@roomote/db/server';
import { resolveGitLabInstanceHost } from '@roomote/gitlab';
import {
  createMemoryMcpInstructions,
  MCP_INTEGRATION_PROXY_PATH_PREFIX,
  MCP_ROUTING_PROXY_PATH_PREFIX,
  ROOMOTE_MCP_ID,
  getMcpIntegration,
  getMemoryMcpDisplayName,
  formatErrorForLog,
  isMemoryMcpServer,
} from '@roomote/types';

import {
  callMcpTool,
  listMcpTools,
  type McpToolDefinition,
} from '../mcp-tool-client';
import { isRouterMcpServerEnabled } from '../mcp-policy';
import { resolveApiBaseUrl } from '../shared-utils';
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
    // Deployment-proxy endpoints authenticate with a short-lived broker token
    // that must be re-minted at call time rather than reused from list time.
    deploymentProxy?: boolean;
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
  humanTurn?: boolean;
  sessionId: string;
  conversation: FastAgentConversation;
  messageId: string;
};

const FAST_AGENT_INTEGRATION_TOOL_CACHE_TTL_MS = 5 * 60_000;
const FAST_AGENT_INTEGRATION_TOOL_CACHE_RETRY_MS = 30_000;
const FAST_AGENT_INTEGRATION_TOOL_CACHE_MAX_ENTRIES = 1_000;
const FAST_AGENT_INTEGRATION_DISCOVERY_TIMEOUT_MS = 10_000;
const FAST_AGENT_INTEGRATION_CALL_TIMEOUT_MS = 60_000;

type IntegrationToolCacheEntry = {
  expiresAt: number;
  tools: Promise<McpToolDefinition[]>;
};

const integrationToolCache = new Map<string, IntegrationToolCacheEntry>();

const FAST_ROOMOTE_MANAGE_TASKS_LAUNCH_FIELDS = new Set([
  'prompt',
  'environmentId',
  'branch',
  'notifyOnSettle',
]);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Fast has a native launch gate that owns Session attachment, kickoff ordering,
 * attachments, and settlement. Keep the direct task API available to other MCP
 * consumers without exposing its incompatible launch action to Fast models.
 */
function shapeFastIntegrationTool(
  integrationId: string,
  tool: McpToolDefinition,
): McpToolDefinition | null {
  if (integrationId !== ROOMOTE_MCP_ID || tool.name !== 'manage_tasks') {
    return tool;
  }

  const inputSchema = asObject(tool.inputSchema);
  const properties = asObject(inputSchema?.properties);
  const action = asObject(properties?.action);
  const actions = Array.isArray(action?.enum) ? action.enum : null;
  if (!inputSchema || !properties || !action || !actions) {
    // A schema we cannot narrow must not retain the unsafe launch path.
    return null;
  }

  return {
    ...tool,
    description:
      'Manage Roomote Sessions and inspect or control existing tasks. Use launch_task to start coding work from a Fast Session.',
    inputSchema: {
      ...inputSchema,
      properties: {
        ...Object.fromEntries(
          Object.entries(properties).filter(
            ([name]) => !FAST_ROOMOTE_MANAGE_TASKS_LAUNCH_FIELDS.has(name),
          ),
        ),
        action: {
          ...action,
          enum: actions.filter((candidate) => candidate !== 'launch'),
          description: 'The Session or existing-task action to perform.',
        },
      },
    },
  };
}

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
    // Re-insert so eviction below is least-recently-used rather than oldest.
    integrationToolCache.delete(cacheKey);
    integrationToolCache.set(cacheKey, cached);
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
  pruneIntegrationToolCacheEntries();
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

// The cache is keyed per user, so on deployments with many Fast users
// abandoned entries would otherwise accumulate for the process lifetime.
// Eviction is by count rather than age: a stale catalog is still served
// instantly while it refreshes in the background, so keeping it around means
// the first message after an idle stretch never blocks on tool discovery.
function pruneIntegrationToolCacheEntries(): void {
  while (
    integrationToolCache.size >= FAST_AGENT_INTEGRATION_TOOL_CACHE_MAX_ENTRIES
  ) {
    const oldestKey = integrationToolCache.keys().next().value;
    if (oldestKey === undefined) return;
    integrationToolCache.delete(oldestKey);
  }
}

export function clearFastAgentIntegrationToolCache(): void {
  integrationToolCache.clear();
}

function integrationProxyUrl(baseUrl: string, integrationId: string): string {
  const relativePath =
    integrationId === 'github' || integrationId === 'gitlab'
      ? `api/mcp-routing/${integrationId}`
      : `api/mcp/${encodeURIComponent(integrationId)}`;
  return new URL(relativePath, `${baseUrl}/`).toString();
}

function describeMcpServer(
  id: string,
): Pick<FastAgentIntegration, 'name' | 'description' | 'instructions'> {
  if (id === HTTP_INTEGRATIONS_MCP_ID) {
    return {
      name: 'HTTP integrations',
      description:
        'API-mediated HTTP requests to operator-configured integrations.',
      instructions: HTTP_INTEGRATIONS_INSTRUCTIONS,
    };
  }
  if (id === ROOMOTE_MCP_ID) {
    return {
      name: 'Roomote',
      description:
        'Manage this Roomote deployment, including custom skills, custom automations, and other deployment capabilities.',
    };
  }
  if (isMemoryMcpServer(id)) {
    return {
      name: getMemoryMcpDisplayName(id),
      description: 'Read and write persistent context shared across tasks.',
      instructions: createMemoryMcpInstructions(id, {
        surface: 'conversation',
      }),
    };
  }
  const integration = getMcpIntegration(id);
  return {
    name: integration?.name ?? id,
    description:
      integration?.description ??
      'Use tools from this deployment-configured MCP server.',
    instructions: integration?.instructions,
  };
}

function resolveFastMcpEndpoint(options: {
  apiBaseUrl: string;
  authToken: string;
  integrationId: string;
  config: FastAgentMcpServerConfig;
}) {
  const apiUrl = new URL(options.apiBaseUrl);
  const configuredUrl = new URL(options.config.url, options.apiBaseUrl);
  const isDeploymentProxy =
    configuredUrl.origin === apiUrl.origin &&
    (configuredUrl.pathname.startsWith(MCP_INTEGRATION_PROXY_PATH_PREFIX) ||
      configuredUrl.pathname.startsWith(MCP_ROUTING_PROXY_PATH_PREFIX) ||
      (options.integrationId === ROOMOTE_MCP_ID &&
        configuredUrl.pathname === ROOMOTE_MCP_PATH));

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
    deploymentProxy: true,
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

async function hasGitLabDiscoveryConnection(): Promise<boolean> {
  if (Env.R_CURATED_INTEGRATIONS_DISABLED) {
    return false;
  }
  const host = await resolveGitLabInstanceHost();
  const [repository, connection] = await Promise.all([
    db.query.repositories.findFirst({
      where: and(
        eq(repositories.sourceControlProvider, 'gitlab'),
        eq(repositories.isActive, true),
        eq(repositories.host, host),
      ),
      columns: { id: true },
    }),
    db.query.deploymentSecrets.findFirst({
      where: eq(deploymentSecrets.name, 'gitlab_deployment_oauth_connection'),
      columns: { name: true },
    }),
  ]);
  return Boolean(repository && connection);
}

async function isBitbucketAvailable(userId: string): Promise<boolean> {
  if (areCuratedIntegrationsDisabled(Env.R_CURATED_INTEGRATIONS_DISABLED))
    return false;
  const connection = await getBitbucketOAuthConnection();
  if (connection?.status !== 'active') return false;
  const host = await resolveBitbucketInstanceHost();
  if (host !== 'bitbucket.org' && host !== 'www.bitbucket.org') return false;

  const [member, repository] = await Promise.all([
    db.query.users.findFirst({
      where: and(eq(users.id, userId), isNull(users.deletedAt)),
      columns: { role: true },
    }),
    db.query.repositories.findFirst({
      where: and(
        eq(repositories.sourceControlProvider, 'bitbucket'),
        eq(repositories.host, host),
        eq(repositories.isActive, true),
      ),
      columns: { externalRepoId: true },
    }),
  ]);
  return !!(
    member &&
    ['admin', 'member'].includes(member.role) &&
    repository?.externalRepoId
  );
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
  if (!resolveMcpServerConfigs) {
    console.warn(
      '[Fast Agent] No MCP server config resolver was provided for this surface; deployment MCP servers will be unavailable.',
    );
  }
  const configuredServersPromise: Promise<
    Record<string, FastAgentMcpServerConfig>
  > = resolveMcpServerConfigs?.() ?? Promise.resolve({});
  const [
    configuredServers,
    githubInstallation,
    gitlabConnection,
    bitbucketAvailable,
  ] = await Promise.all([
    configuredServersPromise,
    isRouterMcpServerEnabled('github')
      ? db.query.githubInstallations.findFirst({
          where: isNull(githubInstallations.suspendedAt),
          columns: { id: true },
        })
      : Promise.resolve(undefined),
    hasGitLabDiscoveryConnection().catch(() => false),
    isBitbucketAvailable(context.userId),
  ]);

  if (
    Object.keys(configuredServers).length === 0 &&
    !githubInstallation &&
    !gitlabConnection &&
    !bitbucketAvailable
  ) {
    return [];
  }

  const { apiBaseUrl, authToken } = await resolveBrokerAuth(context);
  const candidates: FastAgentIntegrationCandidate[] = Object.entries(
    configuredServers,
  ).map(([id, config]) => ({
    id,
    ...describeMcpServer(id),
    endpoint: resolveFastMcpEndpoint({
      apiBaseUrl,
      authToken,
      integrationId: id,
      config,
    }),
    disabledTools: new Set(config.disabledTools ?? []),
  }));

  if (githubInstallation && !configuredServers.github) {
    candidates.push({
      id: 'github',
      name: 'GitHub',
      description:
        'Read public github.com repositories and connected private repositories using the deployment GitHub App. Public repositories do not need to be connected. In active connected repositories, use native update_pull_request, add_issue_comment, and add_reply_to_pull_request_comment capabilities, including reviewer requests, draft status, and comment reactions. Follow the discovered native tool descriptions and schemas for supported arguments.',
      endpoint: {
        url: integrationProxyUrl(apiBaseUrl, 'github'),
        headers: { Authorization: `Bearer ${authToken}` },
        deploymentProxy: true,
      },
      disabledTools: new Set<string>(),
    });
  }

  if (gitlabConnection && !configuredServers.gitlab) {
    candidates.push({
      id: 'gitlab',
      name: 'GitLab',
      description:
        'Read connected GitLab repositories and commit history, inspect merge requests, and make bounded merge request updates and comments. Access is authorized on each request.',
      endpoint: {
        url: integrationProxyUrl(apiBaseUrl, 'gitlab'),
        headers: { Authorization: `Bearer ${authToken}` },
        deploymentProxy: true,
      },
      disabledTools: new Set<string>(),
    });
  }

  if (bitbucketAvailable && !configuredServers.bitbucket) {
    candidates.push({
      id: 'bitbucket',
      name: 'Bitbucket',
      description:
        'Read bounded files, directories, code search, commits, and pull requests from active connected Bitbucket Cloud repositories; update PR titles/descriptions, decline PRs, and add comments or replies.',
      endpoint: {
        url: integrationProxyUrl(apiBaseUrl, 'bitbucket'),
        headers: { Authorization: `Bearer ${authToken}` },
        deploymentProxy: true,
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
          cacheKey: `${context.userId}:${integration.endpoint!.url}:${configuredServers[integration.id]?.cacheRevision ?? ''}`,
          url: integration.endpoint!.url,
          headers: integration.endpoint!.headers,
        })
      )
        .filter((tool) => !integration.disabledTools.has(tool.name))
        .flatMap((tool) => {
          const shaped = shapeFastIntegrationTool(integration.id, tool);
          return shaped ? [shaped] : [];
        }),
    })),
  );

  let hasPrimaryMemory = false;
  return results.flatMap((result) => {
    if (result.status !== 'fulfilled' || result.value.tools.length === 0) {
      return [];
    }

    const isMemory = isMemoryMcpServer(result.value.id);
    const primaryMemory = isMemory && !hasPrimaryMemory;
    if (isMemory) {
      hasPrimaryMemory = true;
    }

    return [
      {
        id: result.value.id,
        name: result.value.name,
        description: result.value.description,
        instructions: isMemory
          ? createMemoryMcpInstructions(result.value.id, {
              primary: primaryMemory,
              surface: 'conversation',
            })
          : result.value.instructions,
        tools: result.value.tools,
        endpoint: result.value.endpoint,
      },
    ];
  });
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
  if (
    request.integrationId === ROOMOTE_MCP_ID &&
    request.toolName === 'manage_tasks' &&
    request.args.action === 'launch'
  ) {
    throw new Error(
      'Fast Sessions must use launch_task so the child stays attached and reports settlement to its parent Session.',
    );
  }

  // Fail closed: an integration tool never executes unless its durable audit
  // record exists first.
  const audit = await beginSlackFastIntegrationCall({
    fastAgentConversationId: context.sessionId,
    userId: context.userId,
    slackTeamId: getFastAgentConversationStorageWorkspaceId(
      context.conversation,
    ),
    slackChannel:
      'replyTarget' in context.conversation
        ? context.conversation.replyTarget.channelId
        : context.conversation.conversationId,
    slackThreadTs: context.conversation.conversationId,
    slackMessageTs: context.messageId,
    integrationId: integration.id,
    toolName: request.toolName,
    arguments:
      integration.id === HTTP_INTEGRATIONS_MCP_ID
        ? { toolName: request.toolName }
        : request.args,
  });

  try {
    // The token minted at list time is short-lived, so deployment-proxy calls
    // re-mint it here: a call late in a long turn must not send an expired
    // bearer. Direct upstream endpoints keep their own resolved headers.
    let endpoint = integration.endpoint;
    if (!endpoint || endpoint.deploymentProxy) {
      const { apiBaseUrl, authToken } = await resolveBrokerAuth(context);
      endpoint = endpoint
        ? {
            ...endpoint,
            headers: {
              ...endpoint.headers,
              Authorization: `Bearer ${authToken}`,
            },
          }
        : {
            url: integrationProxyUrl(apiBaseUrl, integration.id),
            headers: { Authorization: `Bearer ${authToken}` },
          };
    }
    if (
      integration.id === HTTP_INTEGRATIONS_MCP_ID &&
      endpoint.deploymentProxy &&
      context.humanTurn
    ) {
      endpoint = {
        ...endpoint,
        headers: {
          ...endpoint.headers,
          Authorization: `Bearer ${await createSessionBrokerToken({
            userId: context.userId,
            fastConversationId: context.sessionId,
          })}`,
        },
      };
    }
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
        resultPreview:
          integration.id === HTTP_INTEGRATIONS_MCP_ID
            ? '[Broker result omitted]'
            : serializeAuditPreview(result, 30_000),
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
