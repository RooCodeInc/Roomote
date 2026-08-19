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
const FAST_AGENT_INTEGRATION_TOOL_CACHE_RETRY_MS = 30_000;
const FAST_AGENT_INTEGRATION_DISCOVERY_TIMEOUT_MS = 10_000;
const FAST_AGENT_INTEGRATION_CALL_TIMEOUT_MS = 60_000;

type IntegrationToolCacheEntry = {
  expiresAt: number;
  tools: Promise<McpToolDefinition[]>;
};

export const FAST_AGENT_REMEMBER_USER_FACT_TOOL: McpToolDefinition = {
  name: 'remember_user_fact',
  description:
    'Persist an explicit durable fact or preference about the current sender in the shared Brain. Use this when the user asks to remember something. Choose a short stable semantic key such as "favorite number"; calling the tool again with the same key updates the existing memory instead of creating a duplicate. Never store secrets, credentials, or inferred sensitive traits, and never claim persistence unless this call succeeds.',
  inputSchema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        description:
          'A short stable semantic label for the fact, such as "favorite number".',
      },
      value: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: 'The explicit fact or preference to remember.',
      },
    },
    required: ['key', 'value'],
    additionalProperties: false,
  },
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
  url: string;
  headers: Record<string, string>;
}): Promise<McpToolDefinition[]> {
  const cached = integrationToolCache.get(options.url);
  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      // Keep serving the last known-good catalog while refreshing. Fast turns
      // must never wait behind a deployment integration that stopped answering
      // after it was previously discovered successfully.
      cached.expiresAt =
        Date.now() + FAST_AGENT_INTEGRATION_TOOL_CACHE_RETRY_MS;
      const refresh = withFastIntegrationTimeout(
        (signal) => listMcpTools({ ...options, signal }),
        FAST_AGENT_INTEGRATION_DISCOVERY_TIMEOUT_MS,
        'Fast integration tool discovery',
      );
      void refresh
        .then((tools) => {
          if (integrationToolCache.get(options.url) === cached) {
            integrationToolCache.set(options.url, {
              expiresAt: Date.now() + FAST_AGENT_INTEGRATION_TOOL_CACHE_TTL_MS,
              tools: Promise.resolve(tools),
            });
          }
        })
        .catch(() => {
          if (integrationToolCache.get(options.url) === cached) {
            cached.expiresAt =
              Date.now() + FAST_AGENT_INTEGRATION_TOOL_CACHE_RETRY_MS;
          }
        });
    }

    return cached.tools;
  }

  const tools = withFastIntegrationTimeout(
    (signal) => listMcpTools({ ...options, signal }),
    FAST_AGENT_INTEGRATION_DISCOVERY_TIMEOUT_MS,
    'Fast integration tool discovery',
  );
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

async function saveFastAgentUserMemory(
  context: IntegrationAuditContext,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const { apiBaseUrl, authToken } = await resolveBrokerAuth(context);
  const response = await fetch(
    new URL('api/mcp/tasks/memory', `${apiBaseUrl}/`).toString(),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...args,
        source: { surface: context.conversation.surface },
      }),
      signal,
    },
  );
  const result = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;

  if (!response.ok) {
    throw new Error(
      result?.error ?? `User memory request failed (${response.status}).`,
    );
  }

  return result;
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
      tools: [
        ...(
          await listCachedIntegrationTools({
            url: integrationProxyUrl(apiBaseUrl, integration.id),
            headers: { Authorization: `Bearer ${authToken}` },
          })
        ).filter((tool) => !integration.disabledTools.has(tool.name)),
        ...(integration.id === BRAIN_MCP_ID
          ? [FAST_AGENT_REMEMBER_USER_FACT_TOOL]
          : []),
      ],
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
    const result = await withFastIntegrationTimeout(
      async (signal) => {
        if (
          integration.id === BRAIN_MCP_ID &&
          request.toolName === FAST_AGENT_REMEMBER_USER_FACT_TOOL.name
        ) {
          return saveFastAgentUserMemory(context, request.args, signal);
        }

        const { apiBaseUrl, authToken } = await resolveBrokerAuth(context);
        return callMcpTool({
          url: integrationProxyUrl(apiBaseUrl, integration.id),
          headers: { Authorization: `Bearer ${authToken}` },
          toolName: request.toolName,
          args: request.args,
          toolCallId: `fast:${audit.id}:${integration.id}:${request.toolName}`,
          signal,
        });
      },
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
