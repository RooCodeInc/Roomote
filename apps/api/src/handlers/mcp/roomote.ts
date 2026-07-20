import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  and,
  db,
  eq,
  environments,
  isNull,
  mcpConnections,
  deploymentMcpEnablements,
  resolveInvocationIdentityMap,
} from '@roomote/db/server';
import {
  findLinearDeploymentMcpConnection,
  getLinearDeploymentMetadata,
} from '@roomote/sdk/server';
import {
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
  environmentConfigSchema,
  MCP_INTEGRATIONS,
  isUserToken,
  PRODUCT_NAME,
} from '@roomote/types';
import { Env, getDefaultDocsUrl } from '@roomote/env';
import { z } from 'zod';

import type { Variables } from '../../types';

import {
  assertTaskRunTokenTargetExists,
  McpProxyError,
  resolveActingUserIdOrNull,
  type McpAuthContext,
  isRunTokenContext,
  toMcpToolResult,
} from './proxy-utils';
import {
  lookupCommunicationChannelMessages,
  lookupCommunicationMessageContext,
  type CommunicationLookupTaskRun,
} from './communication-message-lookup';
import { requireCommunicationLookupTaskRun } from './communication-lookup-run-context';

const ROOMOTE_MCP_SERVER_INFO = {
  name: 'roomote-router-mcp',
  version: '1.0.0',
} as const;

const SUPPORTED_MCP_IDS = new Set(
  MCP_INTEGRATIONS.map((integration) => integration.id),
);

function getConfigMcpServers(configValue: unknown): Array<{
  id: string;
  transport: 'stdio' | 'streamable-http';
}> {
  const parsed = environmentConfigSchema.safeParse(configValue);
  if (!parsed.success) {
    return [];
  }

  return Object.entries(parsed.data.mcpServers ?? {}).map(([id, config]) => ({
    id,
    transport: 'command' in config ? 'stdio' : 'streamable-http',
  }));
}

function getConfigRepositories(configValue: unknown): Array<{
  repository: string;
  branch?: string;
}> {
  const parsed = environmentConfigSchema.safeParse(configValue);
  if (!parsed.success) {
    return [];
  }

  return parsed.data.repositories.map((repository) => ({
    repository: repository.repository,
    ...(repository.branch ? { branch: repository.branch } : {}),
  }));
}

async function resolveRoomoteMcpAuth(
  authContext: Variables['authContext'],
): Promise<McpAuthContext> {
  if (!authContext) {
    throw new McpProxyError(
      401,
      'Unauthorized: missing or invalid bearer token',
    );
  }

  if (isRunTokenContext(authContext)) {
    await assertTaskRunTokenTargetExists(authContext);

    return {
      userId: authContext.userId,
      tokenType: 'run',
      runId: authContext.runId,
    };
  }

  if (isUserToken(authContext)) {
    return {
      userId: authContext.userId,
      tokenType: 'auth',
    };
  }

  throw new McpProxyError(
    403,
    `${PRODUCT_NAME} MCP requires a user-scoped auth token or task run token`,
  );
}

async function buildAboutMePayload(options: {
  /**
   * The acting human user, or null when the job runs as the deployment
   * service principal.
   */
  userId: string | null;
  operation: 'overview' | 'integrations';
}) {
  const [
    environmentRows,
    linearRows,
    enabledDeploymentMcps,
    userConnections,
    invocationIdentities,
  ] = await Promise.all([
    db.query.environments.findMany({
      where: eq(environments.isEval, false),
      columns: {
        id: true,
        name: true,
        description: true,
        config: true,
      },
      orderBy: (table, { asc }) => [asc(table.name)],
    }),
    Promise.all([findLinearDeploymentMcpConnection()]),
    db.query.deploymentMcpEnablements.findMany({
      where: eq(deploymentMcpEnablements.enabled, true),
      columns: {
        mcpId: true,
      },
      orderBy: (table, { asc }) => [asc(table.mcpId)],
    }),
    db.query.mcpConnections.findMany({
      where: and(
        // Deployment-service-principal jobs have no human actor; their
        // legitimate connections are the deployment-scoped rows
        // (userId IS NULL).
        options.userId === null
          ? isNull(mcpConnections.userId)
          : eq(mcpConnections.userId, options.userId),
        eq(mcpConnections.enabled, true),
      ),
      columns: {
        id: true,
        mcpId: true,
        authStatus: true,
        enabled: true,
        scopes: true,
      },
      orderBy: (table, { asc }) => [asc(table.mcpId)],
    }),
    resolveInvocationIdentityMap(),
  ]);
  const linearInstallations = linearRows.flatMap((connection) => {
    const metadata = getLinearDeploymentMetadata(connection?.authConfig);
    return metadata
      ? [
          {
            id: connection!.id,
            linearOrganizationName: metadata.linearOrganizationName,
            linearOrganizationUrlKey: metadata.linearOrganizationUrlKey,
          },
        ]
      : [];
  });

  const environmentDeclaredMcpIds = Array.from(
    new Set(
      environmentRows.flatMap((environment) =>
        getConfigMcpServers(environment.config).map((server) => server.id),
      ),
    ),
  ).sort();
  const supportedDeploymentEnabledMcpIds = enabledDeploymentMcps
    .map((mcp) => mcp.mcpId)
    .filter((mcpId) => SUPPORTED_MCP_IDS.has(mcpId));
  const supportedUserConnections = userConnections.filter((connection) =>
    SUPPORTED_MCP_IDS.has(connection.mcpId),
  );

  return {
    requestedOperation: options.operation,
    product: {
      name: PRODUCT_NAME,
      appUrl: Env.R_APP_URL,
      docsUrl: getDefaultDocsUrl(Env.APP_ENV ?? 'development'),
    },
    deployment: {
      userId: options.userId,
      environmentCount: environmentRows.length,
      environments: environmentRows.map((environment) => ({
        id: environment.id,
        name: environment.name,
        description: environment.description ?? null,
        repositories: getConfigRepositories(environment.config),
        declaredMcpServers: getConfigMcpServers(environment.config),
      })),
    },
    integrations: {
      linear: {
        connected: linearInstallations.length > 0,
        installations: linearInstallations.map((installation) => ({
          organizationName: installation.linearOrganizationName,
          urlKey: installation.linearOrganizationUrlKey ?? null,
        })),
      },
    },
    configuredMcpServers: {
      deploymentEnabled: supportedDeploymentEnabledMcpIds,
      userConnections: supportedUserConnections.map((connection) => ({
        mcpId: connection.mcpId,
        authStatus: connection.authStatus ?? null,
        enabled: connection.enabled,
        scopes: connection.scopes ?? [],
      })),
      environmentDeclared: environmentDeclaredMcpIds,
    },
    capabilities: [
      "I work from Slack, Linear, and the web. I figure out the right repo automatically - you usually don't need to tell me.",
      'I implement changes, run tests, and open PRs.',
      'I can run automations like code reviews and PR fixes on a schedule.',
      'I use your connected integrations for context, like GitHub, Linear, and your enabled MCP tools.',
      'I can pick up where I left off when you follow up in the same thread.',
    ],
    gettingStarted: {
      slack: invocationIdentities.slack?.examplePrompt
        ? `Mention ${invocationIdentities.slack.guidanceName} in Slack with what you need. I'll figure out the right repo.`
        : 'Use the connected Slack app in a DM or channel with what you need.',
      teams: invocationIdentities.microsoft?.examplePrompt
        ? `Mention ${invocationIdentities.microsoft.guidanceName} in Teams with what you need.`
        : 'Use the connected Teams bot in a chat or channel with what you need.',
      telegram: invocationIdentities.telegram?.deepLinkUrl
        ? `Message ${invocationIdentities.telegram.guidanceName} on Telegram: ${invocationIdentities.telegram.deepLinkUrl}`
        : 'Message the connected Telegram bot to start work from Telegram.',
      linear:
        linearRows.length > 0
          ? 'Start a Linear Agent Session or mention Roomote in an issue comment.'
          : 'Connect Linear to start tasks from issues.',
      github: invocationIdentities.github?.mentionText
        ? `Mention ${invocationIdentities.github.mentionText} on a PR for follow-up work or reviews.`
        : 'Mention the GitHub app on a PR for follow-up work or reviews.',
      web: 'Use the web app to start tasks, configure environments, or check on work.',
    },
  };
}

async function buildCommunicationMessageContextPayload(options: {
  auth: McpAuthContext;
  actingUserId: string | null;
  channel?: string;
  messageId?: string;
  messageLink?: string;
}) {
  let taskRun: CommunicationLookupTaskRun | undefined;

  if (options.auth.tokenType === 'run') {
    if (!options.auth.runId) {
      throw new McpProxyError(
        403,
        'MCP proxy requires a task run token with a task run id',
      );
    }

    taskRun = await requireCommunicationLookupTaskRun(options.auth.runId);
  }

  return lookupCommunicationMessageContext({
    ...(typeof options.channel === 'string' && options.channel.length > 0
      ? { channel: options.channel }
      : {}),
    ...(typeof options.messageId === 'string' && options.messageId.length > 0
      ? { messageId: options.messageId }
      : {}),
    ...(typeof options.messageLink === 'string' &&
    options.messageLink.length > 0
      ? { messageLink: options.messageLink }
      : {}),
    ...(taskRun ? { taskRun } : {}),
    ...(options.auth.tokenType === 'auth'
      ? { actingUserId: options.actingUserId }
      : {}),
  });
}

async function buildCommunicationChannelMessagesPayload(options: {
  auth: McpAuthContext;
  actingUserId: string | null;
  channel?: string;
  oldest?: string;
  latest?: string;
}) {
  let taskRun: CommunicationLookupTaskRun | undefined;

  if (options.auth.tokenType === 'run') {
    if (!options.auth.runId) {
      throw new McpProxyError(
        403,
        'MCP proxy requires a task run token with a task run id',
      );
    }

    taskRun = await requireCommunicationLookupTaskRun(options.auth.runId);
  }

  return lookupCommunicationChannelMessages({
    ...(typeof options.channel === 'string' && options.channel.length > 0
      ? { channel: options.channel }
      : {}),
    ...(typeof options.oldest === 'string' && options.oldest.length > 0
      ? { oldest: options.oldest }
      : {}),
    ...(typeof options.latest === 'string' && options.latest.length > 0
      ? { latest: options.latest }
      : {}),
    ...(taskRun ? { taskRun } : {}),
    ...(options.auth.tokenType === 'auth'
      ? { actingUserId: options.actingUserId }
      : {}),
  });
}

function createRoomoteTransport() {
  return new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
}

function createRoomoteMcpServer(
  auth: McpAuthContext,
  actingUserId: string | null,
) {
  const server = new McpServer(ROOMOTE_MCP_SERVER_INFO, {
    instructions: `Use get_about_me for Roomote platform, integration, and getting-started context. Use ${CHAT_MESSAGE_CONTEXT_TOOL.name} for surrounding context from the task communication channel or a referenced Slack/Discord message. Use ${CHAT_CHANNEL_MESSAGES_TOOL.name} for readable history from the task communication channel or an explicitly linked channel.`,
  });

  server.registerTool(
    'get_about_me',
    {
      title: 'Get About Me',
      description:
        'Learn about the current Roomote deployment, integrations, capabilities, and getting-started paths.',
      inputSchema: {
        operation: z
          .enum(['overview', 'integrations'])
          .describe(
            'Use "overview" for capability and workflow questions. Use "integrations" for setup and configuration questions.',
          ),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operation }) => {
      const payload = await buildAboutMePayload({
        userId: actingUserId,
        operation,
      });

      return toMcpToolResult(payload);
    },
  );

  server.registerTool(
    CHAT_CHANNEL_MESSAGES_TOOL.name,
    {
      title: CHAT_CHANNEL_MESSAGES_TOOL.title,
      description: CHAT_CHANNEL_MESSAGES_TOOL.description,
      inputSchema: {
        channel: z
          .string()
          .optional()
          .describe(CHAT_CHANNEL_MESSAGES_TOOL.inputDescriptions.channel),
        oldest: z
          .string()
          .optional()
          .describe(CHAT_CHANNEL_MESSAGES_TOOL.inputDescriptions.oldest),
        latest: z
          .string()
          .optional()
          .describe(CHAT_CHANNEL_MESSAGES_TOOL.inputDescriptions.latest),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ channel, oldest, latest }) => {
      const payload = await buildCommunicationChannelMessagesPayload({
        auth,
        actingUserId,
        ...(typeof channel === 'string' && channel.trim().length > 0
          ? { channel: channel.trim() }
          : {}),
        ...(typeof oldest === 'string' && oldest.trim().length > 0
          ? { oldest: oldest.trim() }
          : {}),
        ...(typeof latest === 'string' && latest.trim().length > 0
          ? { latest: latest.trim() }
          : {}),
      });

      return toMcpToolResult(payload);
    },
  );

  server.registerTool(
    CHAT_MESSAGE_CONTEXT_TOOL.name,
    {
      title: CHAT_MESSAGE_CONTEXT_TOOL.title,
      description: CHAT_MESSAGE_CONTEXT_TOOL.description,
      inputSchema: {
        channel: z
          .string()
          .optional()
          .describe(CHAT_MESSAGE_CONTEXT_TOOL.inputDescriptions.channel),
        messageId: z
          .string()
          .optional()
          .describe(CHAT_MESSAGE_CONTEXT_TOOL.inputDescriptions.messageId),
        messageLink: z
          .string()
          .optional()
          .describe(CHAT_MESSAGE_CONTEXT_TOOL.inputDescriptions.messageLink),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ channel, messageId, messageLink }) => {
      const payload = await buildCommunicationMessageContextPayload({
        auth,
        actingUserId,
        ...(typeof channel === 'string' && channel.trim().length > 0
          ? { channel: channel.trim() }
          : {}),
        ...(typeof messageId === 'string' && messageId.trim().length > 0
          ? { messageId: messageId.trim() }
          : {}),
        ...(typeof messageLink === 'string' && messageLink.trim().length > 0
          ? { messageLink: messageLink.trim() }
          : {}),
      });

      return toMcpToolResult(payload);
    },
  );

  return server;
}

export const roomoteMcp = new Hono<{ Variables: Variables }>();

roomoteMcp.on(['POST', 'GET', 'DELETE'], '/', async (c) => {
  const transport = createRoomoteTransport();

  try {
    const auth = await resolveRoomoteMcpAuth(c.get('authContext'));
    // Null means the job runs as the deployment service principal; the
    // Roomote MCP tools are informational and operate on deployment-scoped
    // data, so they support that case.
    const actingUserId = await resolveActingUserIdOrNull(auth);
    const server = createRoomoteMcpServer(auth, actingUserId);

    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } catch (error) {
    if (error instanceof McpProxyError) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message: error.message,
          },
        },
        { status: error.httpStatus },
      );
    }

    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message:
            error instanceof Error
              ? error.message
              : 'Unknown Roomote MCP error',
        },
      },
      { status: 500 },
    );
  }
});
