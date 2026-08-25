import {
  db,
  mcpConnections,
  deploymentMcpEnablements,
  eq,
  inArray,
  and,
  isNull,
  or,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  filterMcpToolDefinitions,
  getDefaultMcpConnectionRole,
  getAllowedIntegrationMcpToolNames,
  getMcpIntegration,
  getMcpIntegrationConnectionScope,
  getMcpIntegrationDefaultDisabledTools,
  type McpConnectionRole,
  isMcpConnectionAsanaConfig,
  isMcpConnectionNotionConfig,
  isMcpConnectionRipplingConfig,
  isMcpConnectionGranolaConfig,
  isMcpConnectionElevenLabsConfig,
  isMcpConnectionGrafanaConfig,
  isMcpConnectionSnowflakeConfig,
  isMcpConnectionVercelConfig,
  isMcpConnectionXConfig,
  isSelfServeMcpIntegration,
  isMcpToolAllowed,
  isDeploymentScopedMcpIntegration,
  MCP_INTEGRATIONS,
  normalizeGrafanaBaseUrl,
  type McpIntegration,
  type McpToolsListJsonRpcPayload,
  parseMcpJsonRpcPayload,
} from '@roomote/types';
import { decrypt, encrypt } from '@roomote/db/encryption';
import { getValidAccessToken } from '@roomote/sdk/server';
import { validateRipplingConnection } from '@roomote/sdk/server/rippling-api';

import type { UserAuthSuccess } from '@/types';
import type { StaticOauthReadiness } from '@/lib/server/mcp-static-oauth';
import { getDeploymentStaticOauthReadiness } from '@/lib/server/deployment-static-oauth';
import { Env, areCuratedIntegrationsDisabled } from '@/lib/server/env';
import { assertCuratedIntegrationsEnabled } from '@/lib/server/curated-integrations';
import { MCP_TOOL_CATALOG_REQUIRES_PERSONAL_CONNECTION } from '@/lib/mcp-tool-errors';
import { captureIntegrationLifecycleEvent } from '@/lib/server/integration-telemetry';
import { saveAuthenticatedDeploymentMcpConnection } from '@/lib/server/deployment-mcp-connection';
import type {
  SaveAsanaConnectionInput,
  SaveNotionConnectionInput,
  SaveRipplingConnectionInput,
  SaveGranolaConnectionInput,
  SaveElevenLabsConnectionInput,
  SaveGrafanaConnectionInput,
  SaveSnowflakeConnectionInput,
  SaveVercelConnectionInput,
  SaveXConnectionInput,
} from '@/types';

type LegacySnowflakePasswordInput = Omit<
  SaveSnowflakeConnectionInput,
  'authMethod'
> & {
  authMethod: 'password';
};

type SaveSnowflakeConnectionCommandInput =
  | SaveSnowflakeConnectionInput
  | LegacySnowflakePasswordInput;

type VercelConnectionData = {
  authStatus?: 'pending' | 'authenticated' | 'error' | null;
  defaultTeamIdOrSlug?: string;
};

type GrafanaConnectionData = {
  authStatus?: 'pending' | 'authenticated' | 'error' | null;
  baseUrl: string;
};

function assertAdmin(auth: UserAuthSuccess) {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

function getStaticOauthSetupError(
  integration: Pick<McpIntegration, 'name'>,
  readiness: StaticOauthReadiness,
): string | null {
  if (readiness === 'ready' || readiness === 'not_required') {
    return null;
  }

  if (readiness === 'partial') {
    return `${integration.name} OAuth setup is incomplete on this Roomote deployment. Ask the team managing this deployment to finish configuring it before connecting.`;
  }

  return `${integration.name} isn't available on this Roomote deployment yet. Ask the team managing this deployment to configure OAuth before connecting.`;
}

async function assertStaticOauthReady(
  integration: McpIntegration,
): Promise<void> {
  const readiness = await getDeploymentStaticOauthReadiness(Env, integration);
  const error = getStaticOauthSetupError(integration, readiness);

  if (error) {
    throw new Error(error);
  }
}

const ALL_DEPLOYMENT_CONTROLLED_APP_IDS = new Set([
  ...MCP_INTEGRATIONS.map((integration) => integration.id),
]);

function getMcpIntegrationIds(): string[] {
  return MCP_INTEGRATIONS.map((integration) => integration.id);
}

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_TOOL_CATALOG_TIMEOUT_MS = 10_000;

type ListedMcpTool = {
  name: string;
  description: string | null;
  enabled: boolean;
};

type VisibleMcpConnectionForCatalog = {
  id: string;
  mcpId: string;
};

type DeploymentMcpEnablementForTools = {
  mcpId: string;
  enabled: boolean;
  disabledTools: string[] | null;
};

async function getDeploymentMcpEnablementForTools(
  mcpId: string,
): Promise<DeploymentMcpEnablementForTools> {
  const enablement = await db.query.deploymentMcpEnablements.findFirst({
    where: eq(deploymentMcpEnablements.mcpId, mcpId),
    columns: {
      mcpId: true,
      enabled: true,
      disabledTools: true,
    },
  });

  if (!enablement || !enablement.enabled) {
    throw new Error(
      'This MCP integration must be enabled before tools can be managed.',
    );
  }

  return enablement;
}

async function getVisibleMcpConnectionForToolCatalog(
  auth: UserAuthSuccess,
  mcpId: string,
): Promise<VisibleMcpConnectionForCatalog> {
  const integration = getMcpIntegration(mcpId);
  if (!integration) {
    throw new Error(`Unknown MCP integration: ${mcpId}`);
  }

  const connectionScope = getMcpIntegrationConnectionScope(integration);
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, mcpId),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.authStatus, 'authenticated'),
      connectionScope === 'deployment'
        ? isNull(mcpConnections.userId)
        : eq(mcpConnections.userId, auth.userId),
    ),
    columns: {
      id: true,
      mcpId: true,
      authConfig: true,
    },
  });

  if (!connection) {
    throw new Error(
      connectionScope === 'deployment'
        ? `Connect ${integration.name} before managing tools for this deployment.`
        : MCP_TOOL_CATALOG_REQUIRES_PERSONAL_CONNECTION,
    );
  }

  if (
    mcpId === 'notion' &&
    !isMcpConnectionNotionConfig(connection.authConfig)
  ) {
    throw new Error(
      'Configure a Notion internal integration before managing tools for this deployment.',
    );
  }

  return { id: connection.id, mcpId: connection.mcpId };
}

/**
 * Resolve the bearer credential used to list an upstream integration's tool
 * catalog. Admin-configured upstream integrations (X) store a static
 * encrypted bearer token; everything else resolves OAuth tokens.
 */
async function resolveUpstreamCatalogAccessToken(
  connectionId: string,
  integrationUrl: string,
): Promise<string | null> {
  const connection = await db.query.mcpConnections.findFirst({
    where: eq(mcpConnections.id, connectionId),
    columns: {
      authConfig: true,
    },
  });

  if (isMcpConnectionXConfig(connection?.authConfig)) {
    const bearerToken = decrypt(
      connection.authConfig.encryptedBearerToken,
    ).trim();

    return bearerToken.length > 0 ? bearerToken : null;
  }

  return (await getValidAccessToken(connectionId, integrationUrl)) ?? null;
}

async function fetchUpstreamMcpTools(input: {
  id: string;
  mcpId: string;
  disabledTools: string[] | null;
}): Promise<ListedMcpTool[]> {
  const integration = getMcpIntegration(input.mcpId);
  if (!integration) {
    throw new Error(`Unknown MCP integration: ${input.mcpId}`);
  }
  const resolvedIntegration = integration;

  const integrationUrl = resolvedIntegration.url;
  if (!integrationUrl) {
    throw new Error(
      `${resolvedIntegration.name} does not expose an upstream tool catalog that can be managed from this dialog yet.`,
    );
  }

  const accessToken = await resolveUpstreamCatalogAccessToken(
    input.id,
    integrationUrl,
  );
  if (!accessToken) {
    throw new Error(
      `${resolvedIntegration.name} needs to be reconnected before tools can be managed.`,
    );
  }

  const reconnectMessage = `${resolvedIntegration.name} needs to be reconnected before tools can be managed.`;

  function isTimeoutError(error: unknown): boolean {
    return (
      (error instanceof DOMException &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
      (error instanceof Error &&
        error.message.includes('The operation was aborted due to timeout'))
    );
  }

  function extractUpstreamErrorMessage(
    bodyText: string,
    contentType: string | null,
  ): string | null {
    const payload = parseMcpJsonRpcPayload(
      bodyText,
      contentType,
    ) as McpToolsListJsonRpcPayload | null;
    if (
      typeof payload?.error?.message === 'string' &&
      payload.error.message.trim().length > 0
    ) {
      return payload.error.message.trim();
    }

    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const candidates = [
        parsed.error_description,
        parsed.error,
        parsed.message,
        parsed.detail,
      ];

      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
          return candidate.trim();
        }
      }
    } catch {
      // Ignore non-JSON bodies and fall back to the raw body text.
    }

    const trimmedBody = bodyText.trim();
    return trimmedBody.length > 0 ? trimmedBody : null;
  }

  function shouldReconnectFromUpstreamError(
    responseStatus: number | null,
    upstreamMessage: string | null,
  ): boolean {
    if (responseStatus === 401) {
      return true;
    }

    if (!upstreamMessage) {
      return false;
    }

    const normalizedMessage = upstreamMessage.toLowerCase();
    return (
      normalizedMessage.includes('invalid_token') ||
      normalizedMessage.includes('invalid access token') ||
      normalizedMessage.includes('expired access token')
    );
  }

  function buildUpstreamToolLoadError(args: {
    response: Response;
    responseBody: string;
    action: 'load tools' | 'initialize' | 'initialize MCP session';
  }): Error {
    const upstreamMessage = extractUpstreamErrorMessage(
      args.responseBody,
      args.response.headers.get('content-type'),
    );

    if (
      shouldReconnectFromUpstreamError(args.response.status, upstreamMessage)
    ) {
      return new Error(reconnectMessage);
    }

    if (upstreamMessage) {
      if (args.action === 'load tools') {
        return new Error(
          `Failed to load tools from ${resolvedIntegration.name}: ${upstreamMessage}`,
        );
      }

      if (args.action === 'initialize') {
        return new Error(
          `Failed to initialize ${resolvedIntegration.name} before loading tools: ${upstreamMessage}`,
        );
      }

      return new Error(
        `Failed to initialize MCP session with ${resolvedIntegration.name}: ${upstreamMessage}`,
      );
    }

    if (args.action === 'load tools') {
      return new Error(
        `Failed to load tools from ${resolvedIntegration.name} (${args.response.status} ${args.response.statusText})`,
      );
    }

    if (args.action === 'initialize') {
      return new Error(
        `Failed to initialize ${resolvedIntegration.name} before loading tools (${args.response.status} ${args.response.statusText})`,
      );
    }

    return new Error(
      `Failed to initialize MCP session with ${resolvedIntegration.name} (${args.response.status} ${args.response.statusText})`,
    );
  }

  const postJsonRpc = async (
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ) =>
    fetch(integrationUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MCP_TOOL_CATALOG_TIMEOUT_MS),
    });

  async function listToolsWithInitializedSession(): Promise<{
    response: Response;
    responseBody: string;
  }> {
    const initializeResponse = await postJsonRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'roomote-admin',
            version: '0.0.0',
          },
        },
      },
      {
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
    );

    const initializeResponseBody = await initializeResponse.text();

    if (!initializeResponse.ok) {
      throw buildUpstreamToolLoadError({
        response: initializeResponse,
        responseBody: initializeResponseBody,
        action: 'initialize',
      });
    }

    const sessionHeaders: Record<string, string> = {
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    };
    const sessionId = initializeResponse.headers.get('mcp-session-id');
    if (sessionId) {
      sessionHeaders['mcp-session-id'] = sessionId;
    }

    const initializedResponse = await postJsonRpc(
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      },
      sessionHeaders,
    );

    const initializedResponseBody = await initializedResponse.text();

    if (!initializedResponse.ok) {
      throw buildUpstreamToolLoadError({
        response: initializedResponse,
        responseBody: initializedResponseBody,
        action: 'initialize MCP session',
      });
    }

    const response = await postJsonRpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      },
      sessionHeaders,
    );
    const responseBody = await response.text();
    return { response, responseBody };
  }

  let response: Response;
  let responseBody: string;

  try {
    response = await postJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    responseBody = await response.text();
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }

    ({ response, responseBody } = await listToolsWithInitializedSession());
  }

  if (
    !response.ok &&
    response.status === 400 &&
    responseBody.includes('Mcp-Session-Id')
  ) {
    ({ response, responseBody } = await listToolsWithInitializedSession());
  }

  if (!response.ok) {
    throw buildUpstreamToolLoadError({
      response,
      responseBody,
      action: 'load tools',
    });
  }

  const payload = parseMcpJsonRpcPayload(
    responseBody,
    response.headers.get('content-type'),
  ) as McpToolsListJsonRpcPayload | null;

  if (!payload) {
    throw new Error(
      `Failed to load tools from ${resolvedIntegration.name}: upstream tools/list returned an invalid payload.`,
    );
  }

  if (payload.error) {
    const upstreamMessage =
      typeof payload.error.message === 'string' &&
      payload.error.message.trim().length > 0
        ? payload.error.message.trim()
        : 'upstream MCP server returned a JSON-RPC error';
    if (shouldReconnectFromUpstreamError(null, upstreamMessage)) {
      throw new Error(reconnectMessage);
    }
    throw new Error(
      `Failed to load tools from ${resolvedIntegration.name}: ${upstreamMessage}`,
    );
  }

  if (!Array.isArray(payload.result?.tools)) {
    throw new Error(
      `Failed to load tools from ${resolvedIntegration.name}: upstream tools/list returned an invalid payload.`,
    );
  }

  const tools = payload.result.tools;
  const toolDefinitions = tools.flatMap((tool) =>
    typeof tool.name === 'string'
      ? [
          {
            name: tool.name,
            description:
              typeof tool.description === 'string' ? tool.description : null,
          },
        ]
      : [],
  );
  const allowedToolNames =
    getAllowedIntegrationMcpToolNames(resolvedIntegration);
  const visibleTools = filterMcpToolDefinitions(toolDefinitions, {
    allowedToolNames,
  });

  return visibleTools.map((tool) => ({
    ...tool,
    enabled: isMcpToolAllowed(tool.name, {
      disabledToolNames: input.disabledTools,
    }),
  }));
}

/**
 * Get deployment-level MCP enablements
 */
export async function getDeploymentMcpEnablementsCommand(
  _auth: UserAuthSuccess,
) {
  const visibleMcpIntegrationIds = getMcpIntegrationIds();

  if (visibleMcpIntegrationIds.length === 0) {
    return [];
  }

  return db.query.deploymentMcpEnablements.findMany({
    where: inArray(deploymentMcpEnablements.mcpId, visibleMcpIntegrationIds),
  });
}

export function getCuratedIntegrationsAvailabilityCommand() {
  return {
    enabled: !areCuratedIntegrationsDisabled(
      Env.R_CURATED_INTEGRATIONS_DISABLED,
    ),
  };
}

/**
 * Return public-safe OAuth setup status for integrations that require a
 * deployment-configured client. Credential names and values never leave the
 * server.
 */
export async function getMcpOauthReadinessCommand(_auth: UserAuthSuccess) {
  const readiness = await Promise.all(
    MCP_INTEGRATIONS.map(async (integration) => ({
      mcpId: integration.id,
      status: await getDeploymentStaticOauthReadiness(Env, integration),
    })),
  );

  return readiness.filter(
    (
      entry,
    ): entry is {
      mcpId: string;
      status: Exclude<StaticOauthReadiness, 'not_required'>;
    } => entry.status !== 'not_required',
  );
}

/**
 * Admin: enable or disable a curated MCP for the deployment
 */
export async function setDeploymentMcpEnabledCommand(
  auth: UserAuthSuccess,
  input: { mcpId: string; enabled: boolean },
) {
  assertAdmin(auth);

  if (input.enabled) {
    assertCuratedIntegrationsEnabled();
  }

  if (!ALL_DEPLOYMENT_CONTROLLED_APP_IDS.has(input.mcpId)) {
    throw new Error(`Unknown deployment-controlled app: ${input.mcpId}`);
  }

  const integration = getMcpIntegration(input.mcpId);
  if (!integration) {
    throw new Error(`Unknown MCP integration: ${input.mcpId}`);
  }

  if (
    input.enabled &&
    isDeploymentScopedMcpIntegration(input.mcpId) &&
    ALL_DEPLOYMENT_CONTROLLED_APP_IDS.has(input.mcpId)
  ) {
    const connection = await db.query.mcpConnections.findFirst({
      where: and(
        eq(mcpConnections.mcpId, input.mcpId),
        eq(mcpConnections.enabled, true),
        eq(mcpConnections.authStatus, 'authenticated'),
        isNull(mcpConnections.userId),
      ),
      columns: { id: true, authConfig: true },
    });

    if (!connection) {
      throw new Error(
        'This MCP integration must be connected before it can be enabled.',
      );
    }

    if (
      input.mcpId === 'notion' &&
      !isMcpConnectionNotionConfig(connection.authConfig)
    ) {
      throw new Error(
        'Configure a Notion internal integration before enabling it.',
      );
    }
  }

  if (
    input.enabled &&
    integration?.oauthClientEnv &&
    !isDeploymentScopedMcpIntegration(input.mcpId)
  ) {
    await assertStaticOauthReady(integration);
  }

  const defaultDisabledTools =
    getMcpIntegrationDefaultDisabledTools(integration);

  const persistEnablement = async (database: DatabaseOrTransaction) => {
    const [result] = await database
      .insert(deploymentMcpEnablements)
      .values({
        mcpId: input.mcpId,
        enabled: input.enabled,
        enabledByUserId: auth.userId,
        ...(defaultDisabledTools.length > 0
          ? { disabledTools: [...defaultDisabledTools] }
          : {}),
      })
      .onConflictDoUpdate({
        target: [deploymentMcpEnablements.mcpId],
        set: {
          enabled: input.enabled,
          enabledByUserId: auth.userId,
          updatedAt: new Date(),
        },
      })
      .returning();

    return result!;
  };

  const result = input.enabled
    ? await persistEnablement(db)
    : await db.transaction(async (tx) => {
        // Credential saves lock the connection before the enablement row too.
        await tx
          .delete(mcpConnections)
          .where(eq(mcpConnections.mcpId, input.mcpId));
        return persistEnablement(tx);
      });

  captureIntegrationLifecycleEvent(
    input.enabled ? 'integration_enabled' : 'integration_disabled',
    input.mcpId,
    auth.userId,
  );

  return result;
}

/**
 * Get MCP connections visible to the current user.
 * This includes user-scoped connections plus deployment-scoped connections.
 */
export async function getUserMcpConnectionsCommand(auth: UserAuthSuccess) {
  const visibleMcpIntegrationIds = getMcpIntegrationIds();

  if (visibleMcpIntegrationIds.length === 0) {
    return [];
  }

  const deploymentScopedIds = visibleMcpIntegrationIds.filter((mcpId) =>
    isDeploymentScopedMcpIntegration(mcpId),
  );
  const userScopedIds = visibleMcpIntegrationIds.filter(
    (mcpId) => !isDeploymentScopedMcpIntegration(mcpId),
  );
  const visibilityFilters = [];

  if (userScopedIds.length > 0) {
    visibilityFilters.push(
      and(
        eq(mcpConnections.userId, auth.userId),
        inArray(mcpConnections.mcpId, userScopedIds),
      ),
    );
  }

  if (deploymentScopedIds.length > 0) {
    visibilityFilters.push(
      and(
        isNull(mcpConnections.userId),
        inArray(mcpConnections.mcpId, deploymentScopedIds),
      ),
    );
  }

  if (visibilityFilters.length === 0) {
    return [];
  }

  const connections = await db.query.mcpConnections.findMany({
    where: or(...visibilityFilters),
    orderBy: (mcpConnections, { desc }) => [desc(mcpConnections.createdAt)],
    columns: {
      id: true,
      mcpId: true,
      authStatus: true,
    },
  });

  return connections.map((connection) => ({
    id: connection.id,
    mcpId: connection.mcpId,
    authStatus: connection.authStatus,
  }));
}

export async function getSnowflakeConnectionCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'snowflake'),
      isNull(mcpConnections.userId),
    ),
    columns: {
      authConfig: true,
      authStatus: true,
    },
  });

  if (!connection || !isMcpConnectionSnowflakeConfig(connection.authConfig)) {
    return null;
  }

  return {
    authStatus: connection.authStatus,
    authMethod: connection.authConfig.encryptedPrivateKey
      ? ('key_pair' as const)
      : ('password' as const),
    account: connection.authConfig.account,
    username: connection.authConfig.username,
    role: connection.authConfig.role,
    warehouse: connection.authConfig.warehouse,
    database: connection.authConfig.database,
  };
}

export async function getAsanaConnectionCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'asana'),
      isNull(mcpConnections.userId),
    ),
    columns: {
      authConfig: true,
      authStatus: true,
    },
  });

  if (!connection || !isMcpConnectionAsanaConfig(connection.authConfig)) {
    return null;
  }

  return {
    authStatus: connection.authStatus,
  };
}

export async function getNotionConnectionCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'notion'),
      isNull(mcpConnections.userId),
    ),
    columns: {
      authConfig: true,
      authStatus: true,
    },
  });

  if (!connection || !isMcpConnectionNotionConfig(connection.authConfig)) {
    return null;
  }

  return { authStatus: connection.authStatus };
}

export async function getRipplingConnectionCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'rippling'),
      isNull(mcpConnections.userId),
    ),
    columns: { authConfig: true, authStatus: true },
  });

  if (!connection || !isMcpConnectionRipplingConfig(connection.authConfig)) {
    return null;
  }

  return { authStatus: connection.authStatus };
}

export async function getGranolaConnectionCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'granola'),
      isNull(mcpConnections.userId),
    ),
    columns: {
      authConfig: true,
      authStatus: true,
    },
  });

  if (!connection || !isMcpConnectionGranolaConfig(connection.authConfig)) {
    return null;
  }

  return {
    authStatus: connection.authStatus,
  };
}

export async function getElevenLabsConnectionCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'elevenlabs'),
      isNull(mcpConnections.userId),
    ),
    columns: {
      authConfig: true,
      authStatus: true,
    },
  });

  if (!connection || !isMcpConnectionElevenLabsConfig(connection.authConfig)) {
    return null;
  }

  return {
    authStatus: connection.authStatus,
    voiceId: connection.authConfig.voiceId,
  };
}

export async function getXConnectionCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const connection = await db.query.mcpConnections.findFirst({
    where: and(eq(mcpConnections.mcpId, 'x'), isNull(mcpConnections.userId)),
    columns: {
      authConfig: true,
      authStatus: true,
    },
  });

  if (!connection || !isMcpConnectionXConfig(connection.authConfig)) {
    return null;
  }

  return {
    authStatus: connection.authStatus,
  };
}

export async function getVercelConnectionCommand(
  auth: UserAuthSuccess,
): Promise<VercelConnectionData | null> {
  assertAdmin(auth);

  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'vercel'),
      isNull(mcpConnections.userId),
    ),
    columns: {
      authConfig: true,
      authStatus: true,
    },
  });

  if (!connection || !isMcpConnectionVercelConfig(connection.authConfig)) {
    return null;
  }

  return {
    authStatus: connection.authStatus,
    defaultTeamIdOrSlug: connection.authConfig.defaultTeamIdOrSlug,
  };
}

export async function getGrafanaConnectionCommand(
  auth: UserAuthSuccess,
): Promise<GrafanaConnectionData | null> {
  assertAdmin(auth);

  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'grafana'),
      isNull(mcpConnections.userId),
    ),
    columns: {
      authConfig: true,
      authStatus: true,
    },
  });

  if (!connection || !isMcpConnectionGrafanaConfig(connection.authConfig)) {
    return null;
  }

  return {
    authStatus: connection.authStatus,
    baseUrl: connection.authConfig.baseUrl,
  };
}

export async function saveSnowflakeConnectionCommand(
  auth: UserAuthSuccess,
  input: SaveSnowflakeConnectionCommandInput,
) {
  assertAdmin(auth);
  assertCuratedIntegrationsEnabled();

  const authConfig = await saveAuthenticatedDeploymentMcpConnection({
    mcpId: 'snowflake',
    userId: auth.userId,
    buildAuthConfig: (existingAuthConfig) => {
      const existingConfig = isMcpConnectionSnowflakeConfig(existingAuthConfig)
        ? existingAuthConfig
        : null;
      const preservingExistingCredential =
        input.authMethod === 'password' && input.password.length === 0;
      const nextEncryptedPassword =
        input.authMethod === 'password'
          ? input.password.length > 0
            ? encrypt(input.password)
            : existingConfig?.encryptedPassword
          : undefined;
      const nextEncryptedPrivateKey =
        input.authMethod === 'key_pair'
          ? input.privateKey.trim().length > 0
            ? encrypt(input.privateKey)
            : existingConfig?.encryptedPrivateKey
          : preservingExistingCredential
            ? existingConfig?.encryptedPrivateKey
            : undefined;
      const nextEncryptedPrivateKeyPassphrase =
        input.authMethod === 'key_pair'
          ? input.privateKeyPassphrase.length > 0
            ? encrypt(input.privateKeyPassphrase)
            : input.privateKey.trim().length > 0
              ? undefined
              : existingConfig?.encryptedPrivateKeyPassphrase
          : preservingExistingCredential
            ? existingConfig?.encryptedPrivateKeyPassphrase
            : undefined;

      const nextAuthConfig = {
        type: 'snowflake' as const,
        account: input.account,
        username: input.username,
        role: input.role,
        ...(input.warehouse
          ? { warehouse: input.warehouse }
          : existingConfig?.warehouse
            ? { warehouse: existingConfig.warehouse }
            : {}),
        ...(input.database
          ? { database: input.database }
          : existingConfig?.database
            ? { database: existingConfig.database }
            : {}),
        ...(nextEncryptedPassword
          ? { encryptedPassword: nextEncryptedPassword }
          : {}),
        ...(nextEncryptedPrivateKey
          ? { encryptedPrivateKey: nextEncryptedPrivateKey }
          : {}),
        ...(nextEncryptedPrivateKeyPassphrase
          ? {
              encryptedPrivateKeyPassphrase: nextEncryptedPrivateKeyPassphrase,
            }
          : {}),
        ...(existingConfig?.schema ? { schema: existingConfig.schema } : {}),
        ...(existingConfig?.allowedStatementTypes
          ? { allowedStatementTypes: existingConfig.allowedStatementTypes }
          : {}),
      };

      if (
        input.authMethod === 'password' &&
        !nextAuthConfig.encryptedPassword &&
        !nextAuthConfig.encryptedPrivateKey
      ) {
        throw new Error(
          'Programmatic Access Token is required when no Snowflake credential is already stored.',
        );
      }

      if (
        input.authMethod === 'key_pair' &&
        !nextAuthConfig.encryptedPrivateKey
      ) {
        throw new Error(
          'Private key is required when no Snowflake key pair is already stored.',
        );
      }

      return nextAuthConfig;
    },
  });

  return {
    authMethod: authConfig.encryptedPrivateKey
      ? ('key_pair' as const)
      : ('password' as const),
    account: authConfig.account,
    username: authConfig.username,
    role: authConfig.role,
    warehouse: authConfig.warehouse,
    database: authConfig.database,
  };
}

export async function saveAsanaConnectionCommand(
  auth: UserAuthSuccess,
  input: SaveAsanaConnectionInput,
) {
  assertAdmin(auth);
  assertCuratedIntegrationsEnabled();

  await saveAuthenticatedDeploymentMcpConnection({
    mcpId: 'asana',
    userId: auth.userId,
    buildAuthConfig: (existingAuthConfig) => {
      const existingConfig = isMcpConnectionAsanaConfig(existingAuthConfig)
        ? existingAuthConfig
        : null;
      const encryptedToken = input.accessToken.length
        ? encrypt(input.accessToken)
        : existingConfig?.encryptedToken;

      if (!encryptedToken) {
        throw new Error(
          'Asana access token is required when no Asana token is already stored.',
        );
      }

      return { type: 'asana' as const, encryptedToken };
    },
  });

  return {
    authStatus: 'authenticated' as const,
  };
}

export async function saveNotionConnectionCommand(
  auth: UserAuthSuccess,
  input: SaveNotionConnectionInput,
) {
  assertAdmin(auth);
  assertCuratedIntegrationsEnabled();

  await saveAuthenticatedDeploymentMcpConnection({
    mcpId: 'notion',
    userId: auth.userId,
    clearOauthTokens: true,
    resetDisabledTools: true,
    buildAuthConfig: (existingAuthConfig) => {
      const existingConfig = isMcpConnectionNotionConfig(existingAuthConfig)
        ? existingAuthConfig
        : null;
      const encryptedToken = input.internalIntegrationSecret.length
        ? encrypt(input.internalIntegrationSecret)
        : existingConfig?.encryptedToken;

      if (!encryptedToken) {
        throw new Error(
          'A Notion internal integration secret is required when no secret is already stored.',
        );
      }

      return { type: 'notion' as const, encryptedToken };
    },
  });

  return { authStatus: 'authenticated' as const };
}

export async function saveRipplingConnectionCommand(
  auth: UserAuthSuccess,
  input: SaveRipplingConnectionInput,
) {
  assertAdmin(auth);
  assertCuratedIntegrationsEnabled();

  await saveAuthenticatedDeploymentMcpConnection({
    mcpId: 'rippling',
    userId: auth.userId,
    clearOauthTokens: true,
    resetDisabledTools: true,
    buildAuthConfig: async (existingAuthConfig) => {
      const existingConfig = isMcpConnectionRipplingConfig(existingAuthConfig)
        ? existingAuthConfig
        : null;
      const encryptedApiToken = input.apiToken.length
        ? encrypt(input.apiToken)
        : existingConfig?.encryptedApiToken;

      if (!encryptedApiToken) {
        throw new Error(
          'A Rippling API token is required when no token is already stored.',
        );
      }

      const authConfig = {
        type: 'rippling' as const,
        encryptedApiToken,
      };
      await validateRipplingConnection(authConfig);
      return authConfig;
    },
  });

  return { authStatus: 'authenticated' as const };
}

export async function saveGranolaConnectionCommand(
  auth: UserAuthSuccess,
  input: SaveGranolaConnectionInput,
) {
  assertAdmin(auth);
  assertCuratedIntegrationsEnabled();

  await saveAuthenticatedDeploymentMcpConnection({
    mcpId: 'granola',
    userId: auth.userId,
    buildAuthConfig: (existingAuthConfig) => {
      const existingConfig = isMcpConnectionGranolaConfig(existingAuthConfig)
        ? existingAuthConfig
        : null;
      const encryptedApiKey = input.apiKey.length
        ? encrypt(input.apiKey)
        : existingConfig?.encryptedApiKey;

      if (!encryptedApiKey) {
        throw new Error(
          'Granola API key is required when no Granola key is already stored.',
        );
      }

      return { type: 'granola' as const, encryptedApiKey };
    },
  });

  return {
    authStatus: 'authenticated' as const,
  };
}

export async function saveElevenLabsConnectionCommand(
  auth: UserAuthSuccess,
  input: SaveElevenLabsConnectionInput,
) {
  assertAdmin(auth);
  assertCuratedIntegrationsEnabled();

  await saveAuthenticatedDeploymentMcpConnection({
    mcpId: 'elevenlabs',
    userId: auth.userId,
    buildAuthConfig: (existingAuthConfig) => {
      const existingConfig = isMcpConnectionElevenLabsConfig(existingAuthConfig)
        ? existingAuthConfig
        : null;
      const encryptedApiKey = input.apiKey.length
        ? encrypt(input.apiKey)
        : existingConfig?.encryptedApiKey;

      if (!encryptedApiKey) {
        throw new Error(
          'ElevenLabs API key is required when no ElevenLabs key is already stored.',
        );
      }

      return {
        type: 'elevenlabs' as const,
        encryptedApiKey,
        voiceId: input.voiceId,
      };
    },
  });

  return {
    authStatus: 'authenticated' as const,
  };
}

export async function saveXConnectionCommand(
  auth: UserAuthSuccess,
  input: SaveXConnectionInput,
) {
  assertAdmin(auth);
  assertCuratedIntegrationsEnabled();

  await saveAuthenticatedDeploymentMcpConnection({
    mcpId: 'x',
    userId: auth.userId,
    buildAuthConfig: (existingAuthConfig) => {
      const existingConfig = isMcpConnectionXConfig(existingAuthConfig)
        ? existingAuthConfig
        : null;
      const encryptedBearerToken = input.bearerToken.length
        ? encrypt(input.bearerToken)
        : existingConfig?.encryptedBearerToken;

      if (!encryptedBearerToken) {
        throw new Error(
          'X bearer token is required when no X token is already stored.',
        );
      }

      return { type: 'x' as const, encryptedBearerToken };
    },
  });

  return {
    authStatus: 'authenticated' as const,
  };
}

export async function saveVercelConnectionCommand(
  auth: UserAuthSuccess,
  input: SaveVercelConnectionInput,
) {
  assertAdmin(auth);
  assertCuratedIntegrationsEnabled();

  const authConfig = await saveAuthenticatedDeploymentMcpConnection({
    mcpId: 'vercel',
    userId: auth.userId,
    buildAuthConfig: (existingAuthConfig) => {
      const existingConfig = isMcpConnectionVercelConfig(existingAuthConfig)
        ? existingAuthConfig
        : null;
      const encryptedAccessToken = input.accessToken.length
        ? encrypt(input.accessToken)
        : existingConfig?.encryptedAccessToken;

      if (!encryptedAccessToken) {
        throw new Error(
          'Vercel access token is required when no Vercel token is already stored.',
        );
      }

      return {
        type: 'vercel' as const,
        encryptedAccessToken,
        ...(input.defaultTeamIdOrSlug
          ? { defaultTeamIdOrSlug: input.defaultTeamIdOrSlug }
          : {}),
      };
    },
  });

  return {
    authStatus: 'authenticated' as const,
    defaultTeamIdOrSlug: authConfig.defaultTeamIdOrSlug,
  };
}

export async function saveGrafanaConnectionCommand(
  auth: UserAuthSuccess,
  input: SaveGrafanaConnectionInput,
) {
  assertAdmin(auth);
  assertCuratedIntegrationsEnabled();

  const authConfig = await saveAuthenticatedDeploymentMcpConnection({
    mcpId: 'grafana',
    userId: auth.userId,
    buildAuthConfig: (existingAuthConfig) => {
      const existingConfig = isMcpConnectionGrafanaConfig(existingAuthConfig)
        ? existingAuthConfig
        : null;
      const encryptedServiceAccountToken = input.serviceAccountToken.length
        ? encrypt(input.serviceAccountToken)
        : existingConfig?.encryptedServiceAccountToken;

      if (!encryptedServiceAccountToken) {
        throw new Error(
          'Grafana service account token is required when no Grafana token is already stored.',
        );
      }

      return {
        type: 'grafana' as const,
        baseUrl: normalizeGrafanaBaseUrl(input.baseUrl),
        encryptedServiceAccountToken,
      };
    },
  });

  return {
    authStatus: 'authenticated' as const,
    baseUrl: authConfig.baseUrl,
  };
}

export async function listDeploymentMcpIntegrationToolsCommand(
  auth: UserAuthSuccess,
  input: { mcpId: string },
) {
  assertAdmin(auth);
  assertCuratedIntegrationsEnabled();
  const integration = getMcpIntegration(input.mcpId);
  if (!integration) {
    throw new Error(`Unknown MCP integration: ${input.mcpId}`);
  }

  const enablement = await getDeploymentMcpEnablementForTools(input.mcpId);
  const connection = await getVisibleMcpConnectionForToolCatalog(
    auth,
    input.mcpId,
  );
  return {
    mcpId: enablement.mcpId,
    tools: await fetchUpstreamMcpTools({
      id: connection.id,
      mcpId: connection.mcpId,
      disabledTools: enablement.disabledTools,
    }),
  };
}

export async function setDeploymentDisabledMcpIntegrationToolsCommand(
  auth: UserAuthSuccess,
  input: {
    mcpId: string;
    disabledTools: string[];
  },
) {
  assertAdmin(auth);
  assertCuratedIntegrationsEnabled();
  const integration = getMcpIntegration(input.mcpId);
  if (!integration) {
    throw new Error(`Unknown MCP integration: ${input.mcpId}`);
  }

  await getDeploymentMcpEnablementForTools(input.mcpId);

  const disabledTools = Array.from(
    new Set(
      input.disabledTools
        .map((toolName) => toolName.trim())
        .filter((toolName) => toolName.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right));

  const [updatedEnablement] = await db
    .update(deploymentMcpEnablements)
    .set({
      disabledTools: disabledTools.length > 0 ? disabledTools : null,
      updatedAt: new Date(),
    })
    .where(eq(deploymentMcpEnablements.mcpId, input.mcpId))
    .returning({
      mcpId: deploymentMcpEnablements.mcpId,
      disabledTools: deploymentMcpEnablements.disabledTools,
    });

  if (!updatedEnablement) {
    throw new Error('Failed to update disabled MCP tools');
  }

  return updatedEnablement;
}

/**
 * Create or restart the OAuth flow for a curated MCP connection.
 */
export async function connectMcpCommand(
  auth: UserAuthSuccess,
  input: { mcpId: string; redirectTo?: string; role?: McpConnectionRole },
) {
  assertCuratedIntegrationsEnabled();
  const integration = getMcpIntegration(input.mcpId);
  if (!integration) {
    throw new Error(`Unknown MCP integration: ${input.mcpId}`);
  }

  const connectionRole = input.role ?? getDefaultMcpConnectionRole(integration);

  if (!isSelfServeMcpIntegration(integration)) {
    throw new Error(
      `${integration.name} is configured by an admin-managed connection flow and cannot be linked from this screen yet.`,
    );
  }

  await assertStaticOauthReady(integration);

  if (
    input.redirectTo &&
    (!input.redirectTo.startsWith('/') || input.redirectTo.startsWith('//'))
  ) {
    throw new Error('redirectTo must be a relative path');
  }

  const isDeploymentScoped = isDeploymentScopedMcpIntegration(
    integration,
    connectionRole,
  );
  if (isDeploymentScoped) {
    assertAdmin(auth);
  } else {
    const enablement = await db.query.deploymentMcpEnablements.findFirst({
      where: and(
        eq(deploymentMcpEnablements.mcpId, input.mcpId),
        eq(deploymentMcpEnablements.enabled, true),
      ),
    });
    if (!enablement) {
      throw new Error(
        'This MCP integration is not enabled for this deployment',
      );
    }
  }

  // Upsert the connection row
  const [connection] = await db
    .insert(mcpConnections)
    .values({
      userId: isDeploymentScoped ? null : auth.userId,
      mcpId: integration.id,
      connectionRole,
      authConfig: {},
      enabled: false,
      authStatus: 'pending',
    })
    .onConflictDoUpdate({
      target: [
        mcpConnections.userId,
        mcpConnections.mcpId,
        mcpConnections.connectionRole,
      ],
      set: {
        userId: isDeploymentScoped ? null : auth.userId,
        connectionRole,
        authConfig: {},
        enabled: false,
        authStatus: 'pending',
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!connection) {
    throw new Error('Failed to create MCP connection');
  }

  // Return relative path so the browser uses its current domain
  if (input.redirectTo) {
    return `/api/mcp-oauth/initiate/${connection.id}?redirectTo=${encodeURIComponent(input.redirectTo)}`;
  }

  return `/api/mcp-oauth/initiate/${connection.id}`;
}

/**
 * Remove the visible curated MCP connection.
 */
export async function disconnectMcpCommand(
  auth: UserAuthSuccess,
  input: { mcpId: string; role?: McpConnectionRole },
) {
  const integration = getMcpIntegration(input.mcpId);
  if (!integration) {
    throw new Error(`Unknown MCP integration: ${input.mcpId}`);
  }

  const connectionRole = input.role ?? getDefaultMcpConnectionRole(integration);
  const connectionScope = getMcpIntegrationConnectionScope(
    integration,
    connectionRole,
  );
  if (connectionScope === 'deployment') {
    assertAdmin(auth);
  }

  const [deleted] = await db
    .delete(mcpConnections)
    .where(
      and(
        eq(mcpConnections.mcpId, input.mcpId),
        eq(mcpConnections.connectionRole, connectionRole),
        connectionScope === 'deployment'
          ? isNull(mcpConnections.userId)
          : eq(mcpConnections.userId, auth.userId),
      ),
    )
    .returning();

  if (!deleted) {
    throw new Error('MCP connection not found');
  }

  if (connectionScope === 'deployment') {
    await db
      .insert(deploymentMcpEnablements)
      .values({
        mcpId: input.mcpId,
        enabled: false,
        enabledByUserId: auth.userId,
      })
      .onConflictDoUpdate({
        target: [deploymentMcpEnablements.mcpId],
        set: {
          enabled: false,
          enabledByUserId: auth.userId,
          updatedAt: new Date(),
        },
      });
  }

  captureIntegrationLifecycleEvent(
    'integration_removed',
    input.mcpId,
    auth.userId,
  );
  if (connectionScope === 'deployment') {
    captureIntegrationLifecycleEvent(
      'integration_disabled',
      input.mcpId,
      auth.userId,
    );
  }

  return { success: true };
}
