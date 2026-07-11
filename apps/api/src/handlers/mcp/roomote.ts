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
  taskRuns,
} from '@roomote/db/server';
import {
  findLinearDeploymentMcpConnection,
  getLinearDeploymentMetadata,
} from '@roomote/sdk/server';
import {
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
  lookupSlackChannelMessages,
  lookupSlackThread,
} from './slack-thread-lookup';
import { getTaskChannelBindings } from '../tasks/helpers';

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
      appUrl: Env.ROOMOTE_APP_URL,
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

type SlackLookupRunContext = {
  actingUserId: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  payload: unknown;
};

/**
 * Load the Slack routing context for a run-token request: the run's acting
 * user and payload plus the owning task's Slack channel bindings (channel
 * bindings moved from runs to tasks in the Stage 2 data-model
 * simplification).
 */
async function loadSlackLookupRunContext(
  runId: number,
): Promise<SlackLookupRunContext> {
  const run = await db.query.taskRuns.findFirst({
    columns: {
      actingUserId: true,
      taskId: true,
      payload: true,
    },
    where: eq(taskRuns.id, runId),
  });

  if (!run) {
    throw new McpProxyError(404, 'Task run not found for this MCP token');
  }

  const bindings = await getTaskChannelBindings(run.taskId);

  return {
    actingUserId: run.actingUserId,
    slackChannelId: bindings?.slackChannelId ?? null,
    slackThreadTs: bindings?.slackThreadTs ?? null,
    payload: run.payload,
  };
}

async function buildSlackThreadPayload(options: {
  auth: McpAuthContext;
  actingUserId: string | null;
  channel?: string;
  messageTs: string;
}) {
  let taskRun: SlackLookupRunContext | undefined;

  if (options.auth.tokenType === 'run') {
    if (!options.auth.runId) {
      throw new McpProxyError(
        403,
        'MCP proxy requires a task run token with a task run id',
      );
    }

    taskRun = await loadSlackLookupRunContext(options.auth.runId);
  }

  return lookupSlackThread({
    messageTs: options.messageTs,
    ...(typeof options.channel === 'string' && options.channel.length > 0
      ? { channel: options.channel }
      : {}),
    ...(taskRun ? { taskRun } : {}),
    ...(options.auth.tokenType === 'auth'
      ? { actingSlackMembershipUserId: options.actingUserId }
      : {}),
  });
}

async function buildSlackChannelMessagesPayload(options: {
  auth: McpAuthContext;
  actingUserId: string | null;
  channel?: string;
  oldest?: string;
  latest?: string;
}) {
  let taskRun: SlackLookupRunContext | undefined;

  if (options.auth.tokenType === 'run') {
    if (!options.auth.runId) {
      throw new McpProxyError(
        403,
        'MCP proxy requires a task run token with a task run id',
      );
    }

    taskRun = await loadSlackLookupRunContext(options.auth.runId);
  }

  return lookupSlackChannelMessages({
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
      ? { actingSlackMembershipUserId: options.actingUserId }
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
    instructions:
      'Use get_about_me for Roomote platform, integration, and getting-started context. Use get_slack_thread when you need the surrounding Slack thread for a referenced Slack message. Use get_slack_channel_messages when you need history from a public Slack channel the app has already joined.',
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
    'get_slack_channel_messages',
    {
      title: 'Get Public Slack Channel Messages',
      description:
        'Fetch history from the originating Slack channel or an explicitly provided Slack channel, but only when that channel is public and the Slack app has already joined it. Optional oldest/latest bounds accept Slack timestamps or ISO 8601 date strings. Explicit channel lookups still require a linked acting Slack user when the current context has one.',
      inputSchema: {
        channel: z
          .string()
          .optional()
          .describe(
            'Optional Slack channel ID, channel name, or channel mention. Required when the current context did not start from Slack. Only public channels the Slack app has already joined are supported.',
          ),
        oldest: z
          .string()
          .optional()
          .describe(
            'Optional inclusive lower bound for returned messages, as a Slack timestamp or ISO 8601 date string.',
          ),
        latest: z
          .string()
          .optional()
          .describe(
            'Optional inclusive upper bound for returned messages, as a Slack timestamp or ISO 8601 date string.',
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
    async ({ channel, oldest, latest }) => {
      const payload = await buildSlackChannelMessagesPayload({
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
    'get_slack_thread',
    {
      title: 'Get Slack Thread',
      description:
        'Look up a Slack message by timestamp in the originating Slack channel and return the full thread that contains it. When the current context did not start from Slack, provide the Slack channel ID, name, or channel mention.',
      inputSchema: {
        channel: z
          .string()
          .optional()
          .describe(
            'Optional Slack channel ID, channel name, or channel mention. Required when the current context did not start from Slack.',
          ),
        messageTs: z
          .string()
          .min(1)
          .describe(
            'Slack message timestamp to look up in the originating or provided Slack channel.',
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
    async ({ channel, messageTs }) => {
      const payload = await buildSlackThreadPayload({
        auth,
        actingUserId,
        ...(typeof channel === 'string' && channel.trim().length > 0
          ? { channel: channel.trim() }
          : {}),
        messageTs: messageTs.trim(),
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
