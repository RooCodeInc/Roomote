import {
  and,
  count,
  customMcpServers,
  db,
  eq,
  inArray,
  isNull,
  mcpConnections,
  personalMcpServers,
} from '@roomote/db/server';
import { decrypt, encrypt } from '@roomote/db/encryption';
import {
  canManageCustomMcpServer,
  customMcpConnectionWhere,
  findCustomMcpServerById,
  getValidAccessToken,
  prepareCustomMcpOAuthConnection,
  type ResolvedCustomMcpServer,
} from '@roomote/sdk/server';
import { safeFetch } from '@roomote/sdk/server/safe-fetch';
import {
  DEFAULT_CUSTOM_MCP_SERVER_VISIBILITY,
  MAX_CUSTOM_MCP_SERVERS,
  MAX_PERSONAL_MCP_SERVERS,
  customMcpConnectionId,
  parseMcpJsonRpcPayload,
  type CustomMcpRemoteServerInput,
  type CustomMcpServerInput,
  type CustomMcpServerVisibility,
  type CustomMcpStdioServerInput,
} from '@roomote/types';
import type { UserAuthSuccess } from '@/types';
import { Env, isCustomMcpDisabled } from '@/lib/server/env';
import { captureIntegrationLifecycleEvent } from '@/lib/server/integration-telemetry';

export const CUSTOM_MCP_DISABLED_MESSAGE =
  'Custom MCP servers are disabled by the deployment operator.';

function assertAdmin(auth: UserAuthSuccess) {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

const NOT_FOUND_MESSAGE = 'Custom MCP server not found.';

/**
 * Load a server the caller may manage, from either table. Mirrors integration
 * keys: a personal server belongs to its owner alone; a deployment server is
 * managed by administrators and by the member who added it. Everyone else
 * gets the same "not found" as a server that does not exist, so a personal
 * server's existence never leaks.
 */
async function loadManageableServer(
  auth: UserAuthSuccess,
  id: string,
): Promise<ResolvedCustomMcpServer> {
  const server = await findCustomMcpServerById(id);
  if (
    !server ||
    !canManageCustomMcpServer(server, {
      userId: auth.userId,
      isAdmin: auth.isAdmin,
    })
  ) {
    throw new Error(NOT_FOUND_MESSAGE);
  }
  return server;
}

export function assertCustomMcpEnabled(
  disabledFlag: string | boolean | undefined = Env.R_CUSTOM_MCP_DISABLED,
) {
  if (isCustomMcpDisabled(disabledFlag)) {
    throw new Error(CUSTOM_MCP_DISABLED_MESSAGE);
  }
}

export function getCustomMcpAvailabilityCommand() {
  return { enabled: !isCustomMcpDisabled(Env.R_CUSTOM_MCP_DISABLED) };
}

/**
 * Browser-facing row shape. Secret material is omitted by construction:
 * header and stdio-env *names* round-trip so edit dialogs can render rows,
 * but values never leave the server.
 */
export interface CustomMcpServerListEntry {
  id: string;
  name: string;
  transport: 'remote' | 'stdio';
  url: string | null;
  authType: 'none' | 'static_headers' | 'oauth';
  headerNames: string[];
  stdioCommand: string | null;
  stdioArgs: string[];
  stdioEnvNames: string[];
  disabledTools: string[];
  hasManualClient: boolean;
  oauthResourceIndicatorDisabled: boolean;
  authStatus: 'pending' | 'authenticated' | 'error' | null;
  enabled: boolean;
  /** `owner`: private to the viewer. `deployment`: shared with every member. */
  visibility: CustomMcpServerVisibility;
  /** Whether the viewer may edit, connect, or remove it. */
  canManage: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `deployment` lists the servers every member shares; any member may read
 * them (names and URLs are not secret), and `canManage` says who may change
 * each one. `personal` lists only the caller's own private servers.
 */
export async function listCustomMcpServersCommand(
  auth: UserAuthSuccess,
  input: { scope?: CustomMcpServerVisibility } = {},
): Promise<CustomMcpServerListEntry[]> {
  const scope = input.scope ?? 'deployment';

  if (scope === 'owner') {
    const servers = await db.query.personalMcpServers.findMany({
      where: eq(personalMcpServers.ownerUserId, auth.userId),
      orderBy: (table, { asc }) => [asc(table.name)],
    });
    const connectionRows =
      servers.length > 0
        ? await db.query.mcpConnections.findMany({
            where: and(
              eq(mcpConnections.userId, auth.userId),
              inArray(
                mcpConnections.mcpId,
                servers.map((server) => customMcpConnectionId(server.id)),
              ),
            ),
            columns: { mcpId: true, authStatus: true },
          })
        : [];
    const authStatusByMcpId = new Map(
      connectionRows.map((row) => [row.mcpId, row.authStatus]),
    );

    return servers.map((server) => ({
      id: server.id,
      name: server.name,
      transport: 'remote' as const,
      url: server.url,
      authType: server.authType,
      headerNames: Object.keys(server.headers ?? {}),
      stdioCommand: null,
      stdioArgs: [],
      stdioEnvNames: [],
      disabledTools: server.disabledTools ?? [],
      hasManualClient: Boolean(server.manualClientId),
      oauthResourceIndicatorDisabled: server.oauthResourceIndicatorDisabled,
      authStatus:
        server.authType === 'oauth'
          ? (authStatusByMcpId.get(customMcpConnectionId(server.id)) ??
            'pending')
          : null,
      enabled: server.enabled,
      visibility: 'owner' as const,
      canManage: true,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    }));
  }

  const servers = await db.query.customMcpServers.findMany({
    orderBy: (table, { asc }) => [asc(table.name)],
  });

  const connectionRows =
    servers.length > 0
      ? await db.query.mcpConnections.findMany({
          where: and(
            isNull(mcpConnections.userId),
            inArray(
              mcpConnections.mcpId,
              servers.map((server) => customMcpConnectionId(server.id)),
            ),
          ),
          columns: { mcpId: true, authStatus: true },
        })
      : [];

  const authStatusByMcpId = new Map(
    connectionRows.map((row) => [row.mcpId, row.authStatus]),
  );

  return servers.map((server) => ({
    id: server.id,
    name: server.name,
    transport: server.stdio ? 'stdio' : 'remote',
    url: server.url,
    authType: server.authType,
    headerNames: Object.keys(server.headers ?? {}),
    stdioCommand: server.stdio?.command ?? null,
    stdioArgs: server.stdio?.args ?? [],
    stdioEnvNames: Object.keys(server.stdio?.env ?? {}),
    disabledTools: server.disabledTools ?? [],
    hasManualClient: Boolean(server.manualClientId),
    oauthResourceIndicatorDisabled: server.oauthResourceIndicatorDisabled,
    authStatus:
      server.authType === 'oauth'
        ? (authStatusByMcpId.get(customMcpConnectionId(server.id)) ?? 'pending')
        : null,
    enabled: server.enabled,
    visibility: 'deployment' as const,
    canManage: auth.isAdmin || server.createdByUserId === auth.userId,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  }));
}

/**
 * Encrypt each secret value individually so names stay readable for the list
 * endpoint while values are protected at rest. An empty-string value on an
 * update means "keep the stored value" (the browser never has the original to
 * echo back); on create it is rejected upstream by the caller.
 */
function encryptSecretValues(
  next: Record<string, string> | undefined,
  existing: Record<string, string> | null | undefined,
  { allowKeepExisting }: { allowKeepExisting: boolean },
): Record<string, string> | null {
  if (!next) {
    return null;
  }

  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(next)) {
    if (value === '') {
      const kept = allowKeepExisting ? existing?.[name] : undefined;

      if (kept === undefined) {
        throw new Error(`A value is required for '${name}'.`);
      }

      result[name] = kept;
    } else {
      result[name] = encrypt(value);
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function remoteColumns(
  input: CustomMcpRemoteServerInput,
  existing?: {
    headers: Record<string, string> | null;
    manualClientSecret: string | null;
  },
) {
  return {
    url: input.url,
    authType: input.authType,
    headers: encryptSecretValues(input.headers, existing?.headers, {
      allowKeepExisting: existing !== undefined,
    }),
    stdio: null,
    manualClientId:
      input.authType === 'oauth' ? (input.manualClientId ?? null) : null,
    manualClientSecret:
      input.authType === 'oauth'
        ? input.manualClientSecret === '' ||
          input.manualClientSecret === undefined
          ? (existing?.manualClientSecret ?? null)
          : input.manualClientSecret
        : null,
    oauthResourceIndicatorDisabled:
      input.oauthResourceIndicatorDisabled ?? false,
  };
}

function stdioColumns(
  input: CustomMcpStdioServerInput,
  existing?: { stdioEnv: Record<string, string> | null },
) {
  return {
    url: null,
    authType: 'none' as const,
    headers: null,
    stdio: {
      command: input.stdio.command,
      ...(input.stdio.args ? { args: input.stdio.args } : {}),
      ...(input.stdio.env
        ? {
            env:
              encryptSecretValues(input.stdio.env, existing?.stdioEnv, {
                allowKeepExisting: existing !== undefined,
              }) ?? undefined,
          }
        : {}),
    },
    manualClientId: null,
    manualClientSecret: null,
    oauthResourceIndicatorDisabled: false,
  };
}

/**
 * Any member may add a remote server, shared (`deployment`, the default) or
 * private (`owner`), the way they add integration keys. Local (stdio)
 * servers run a command inside every task sandbox, so those stay with
 * administrators and are never personal.
 */
export async function createCustomMcpServerCommand(
  auth: UserAuthSuccess,
  input: CustomMcpServerInput & { visibility?: CustomMcpServerVisibility },
) {
  assertCustomMcpEnabled();
  const { visibility = DEFAULT_CUSTOM_MCP_SERVER_VISIBILITY, ...server } =
    input;

  if (server.transport === 'stdio') {
    assertAdmin(auth);
    if (visibility === 'owner') {
      throw new Error('Local (stdio) servers cannot be personal.');
    }
  }

  if (visibility === 'owner' && server.transport === 'remote') {
    return createPersonalMcpServer(auth, server);
  }

  return createDeploymentMcpServer(auth, server);
}

async function createPersonalMcpServer(
  auth: UserAuthSuccess,
  input: CustomMcpRemoteServerInput,
) {
  const [countRow] = await db
    .select({ value: count() })
    .from(personalMcpServers)
    .where(eq(personalMcpServers.ownerUserId, auth.userId));

  if ((countRow?.value ?? 0) >= MAX_PERSONAL_MCP_SERVERS) {
    throw new Error(
      `At most ${MAX_PERSONAL_MCP_SERVERS} personal MCP servers are supported.`,
    );
  }

  const { stdio: _stdio, url, ...columns } = remoteColumns(input);
  const [created] = await db
    .insert(personalMcpServers)
    .values({ name: input.name, url, ...columns, ownerUserId: auth.userId })
    .onConflictDoNothing({
      target: [personalMcpServers.ownerUserId, personalMcpServers.name],
    })
    .returning({ id: personalMcpServers.id });

  if (!created) {
    throw new Error(
      `You already have a personal MCP server named '${input.name}'.`,
    );
  }

  console.log(
    `[custom-mcp-servers] created personal '${input.name}' by user ${auth.userId}`,
  );

  const integrationId = customMcpConnectionId(created.id);
  captureIntegrationLifecycleEvent(
    'integration_enabled',
    integrationId,
    auth.userId,
  );
  if (input.authType !== 'oauth') {
    captureIntegrationLifecycleEvent(
      'integration_connected',
      integrationId,
      auth.userId,
    );
  }

  return { id: created.id };
}

async function createDeploymentMcpServer(
  auth: UserAuthSuccess,
  input: CustomMcpServerInput,
) {
  const [countRow] = await db.select({ value: count() }).from(customMcpServers);

  if ((countRow?.value ?? 0) >= MAX_CUSTOM_MCP_SERVERS) {
    throw new Error(
      `At most ${MAX_CUSTOM_MCP_SERVERS} custom MCP servers are supported.`,
    );
  }

  const columns =
    input.transport === 'remote' ? remoteColumns(input) : stdioColumns(input);

  const [created] = await db
    .insert(customMcpServers)
    .values({
      name: input.name,
      ...columns,
      createdByUserId: auth.userId,
    })
    .onConflictDoNothing({ target: [customMcpServers.name] })
    .returning({ id: customMcpServers.id });

  if (!created) {
    throw new Error(
      `A custom MCP server named '${input.name}' already exists.`,
    );
  }

  console.log(
    `[custom-mcp-servers] created '${input.name}' (${input.transport}) by user ${auth.userId}`,
  );

  const integrationId = customMcpConnectionId(created.id);
  captureIntegrationLifecycleEvent(
    'integration_enabled',
    integrationId,
    auth.userId,
  );
  if (input.transport === 'stdio' || input.authType !== 'oauth') {
    captureIntegrationLifecycleEvent(
      'integration_connected',
      integrationId,
      auth.userId,
    );
  }

  return { id: created.id };
}

export async function updateCustomMcpServerCommand(
  auth: UserAuthSuccess,
  input: { id: string; server: CustomMcpServerInput },
) {
  assertCustomMcpEnabled();
  const manageable = await loadManageableServer(auth, input.id);

  if (manageable.ownerUserId) {
    return updatePersonalMcpServer(auth, manageable, input.server);
  }
  // A member may edit the remote server they added; only an administrator
  // may turn a server into, or edit, a local (stdio) one.
  if (input.server.transport === 'stdio' || manageable.isStdio) {
    assertAdmin(auth);
  }

  const existing = await db.query.customMcpServers.findFirst({
    where: eq(customMcpServers.id, input.id),
  });

  if (!existing) {
    throw new Error(NOT_FOUND_MESSAGE);
  }

  if (existing.name !== input.server.name) {
    throw new Error('Custom MCP server names cannot be changed.');
  }

  const columns =
    input.server.transport === 'remote'
      ? remoteColumns(input.server, {
          headers: existing.headers,
          manualClientSecret: existing.manualClientSecret,
        })
      : stdioColumns(input.server, { stdioEnv: existing.stdio?.env ?? null });

  // Editing the URL or auth mode of a connected server re-targets the stored
  // credentials: without this reset, the proxy would inject the old server's
  // Bearer token into the new URL on the next task — a one-field
  // credential-exfiltration primitive. Force a reconnect instead.
  const credentialTargetChanged =
    columns.url !== existing.url || columns.authType !== existing.authType;

  let removedConnection = false;
  await db.transaction(async (tx) => {
    await tx
      .update(customMcpServers)
      .set({
        ...columns,
        ...(credentialTargetChanged
          ? { oauthServerMetadata: null, oauthServerMetadataFetchedAt: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(customMcpServers.id, input.id));

    if (credentialTargetChanged) {
      const deleted = await tx
        .delete(mcpConnections)
        .where(customMcpConnectionWhere(manageable))
        .returning({ id: mcpConnections.id });
      removedConnection = deleted.length > 0;
    }
  });

  console.log(
    `[custom-mcp-servers] updated '${existing.name}' by user ${auth.userId}` +
      (credentialTargetChanged
        ? ' (credential target changed; tokens cleared)'
        : ''),
  );

  if (removedConnection) {
    captureIntegrationLifecycleEvent(
      'integration_removed',
      customMcpConnectionId(input.id),
      auth.userId,
    );
  }

  return { credentialsCleared: credentialTargetChanged };
}

export async function deleteCustomMcpServerCommand(
  auth: UserAuthSuccess,
  input: { id: string },
) {
  const found = await findCustomMcpServerById(input.id);
  if (!found) {
    return { deleted: false };
  }
  const existing = await loadManageableServer(auth, input.id);

  await db.transaction(async (tx) => {
    await tx.delete(mcpConnections).where(customMcpConnectionWhere(existing));
    if (existing.ownerUserId) {
      await tx
        .delete(personalMcpServers)
        .where(eq(personalMcpServers.id, input.id));
    } else {
      await tx
        .delete(customMcpServers)
        .where(eq(customMcpServers.id, input.id));
    }
  });

  console.log(
    `[custom-mcp-servers] deleted '${existing.name}' by user ${auth.userId}`,
  );

  captureIntegrationLifecycleEvent(
    'integration_removed',
    customMcpConnectionId(input.id),
    auth.userId,
  );

  return { deleted: true };
}

type ListedCustomMcpTool = {
  name: string;
  description: string | null;
  enabled: boolean;
};

const CUSTOM_MCP_PROTOCOL_VERSION = '2025-06-18';

async function callCustomMcpServer(input: {
  url: string;
  headers: Record<string, string>;
  method: string;
  params: unknown;
  sessionId?: string | null;
  protocolVersion?: string;
  requestId: number;
}): Promise<{
  payload: unknown;
  sessionId: string | null;
  response: Response;
}> {
  const response = await safeFetch(input.url, {
    allowedPrivateCidrs: Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(input.sessionId ? { 'mcp-session-id': input.sessionId } : {}),
      ...(input.protocolVersion
        ? { 'mcp-protocol-version': input.protocolVersion }
        : {}),
      ...input.headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: input.requestId,
      method: input.method,
      params: input.params,
    }),
  });

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Custom MCP server request '${input.method}' failed (${response.status} ${response.statusText})`,
    );
  }

  return {
    payload: parseMcpJsonRpcPayload(
      bodyText,
      response.headers.get('content-type'),
    ),
    sessionId: response.headers.get('mcp-session-id'),
    response,
  };
}

/**
 * Best-effort `notifications/initialized` between `initialize` and
 * `tools/list`: the MCP lifecycle requires it, and strict servers refuse
 * requests until the client confirms initialization, while lenient ones
 * simply ignore it. Failures are non-fatal; if the server truly required the
 * notification, the following `tools/list` fails loudly on its own.
 */
async function sendCustomMcpInitializedNotification(input: {
  url: string;
  headers: Record<string, string>;
  sessionId: string | null;
  protocolVersion: string;
}): Promise<void> {
  try {
    await safeFetch(input.url, {
      allowedPrivateCidrs: Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(input.sessionId ? { 'mcp-session-id': input.sessionId } : {}),
        'mcp-protocol-version': input.protocolVersion,
        ...input.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
  } catch {
    // Non-fatal; see above.
  }
}

/**
 * List the tools a custom remote server exposes, flagged with the stored
 * deny-list state. The fetch runs control-plane-side through the SSRF guard
 * with the server's real credentials (which never reach the browser).
 */
export async function listCustomMcpServerToolsCommand(
  auth: UserAuthSuccess,
  input: { id: string },
): Promise<{ tools: ListedCustomMcpTool[] }> {
  assertCustomMcpEnabled();
  const server = await loadManageableServer(auth, input.id);

  if (!server.url || server.isStdio) {
    throw new Error(
      'Local (stdio) servers run inside the task sandbox; their tools cannot be listed from Settings.',
    );
  }

  const headers: Record<string, string> = {};

  if (server.authType === 'static_headers' && server.headers) {
    for (const [name, encryptedValue] of Object.entries(server.headers)) {
      headers[name] = decrypt(encryptedValue);
    }
  } else if (server.authType === 'oauth') {
    const connection = await db.query.mcpConnections.findFirst({
      where: customMcpConnectionWhere(server),
      columns: { id: true },
    });

    const accessToken = connection
      ? await getValidAccessToken(connection.id, server.url)
      : null;

    if (!accessToken) {
      throw new Error(
        `'${server.name}' needs to be connected before tools can be managed.`,
      );
    }

    headers['authorization'] = `Bearer ${accessToken}`;
  }

  // Streamable-http servers may require an initialized session before
  // answering tools/list; try the session-less call first and fall back.
  let toolsPayload: unknown;

  try {
    const direct = await callCustomMcpServer({
      url: server.url,
      headers,
      method: 'tools/list',
      params: {},
      requestId: 1,
    });

    const directResult =
      direct.payload &&
      typeof direct.payload === 'object' &&
      'result' in direct.payload
        ? (direct.payload as { result?: { tools?: unknown } }).result
        : undefined;

    if (!directResult || !Array.isArray(directResult.tools)) {
      throw new Error('Custom MCP server requires initialization.');
    }

    toolsPayload = direct.payload;
  } catch {
    const initialized = await callCustomMcpServer({
      url: server.url,
      headers,
      method: 'initialize',
      params: {
        protocolVersion: CUSTOM_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Roomote', version: '1.0.0' },
      },
      requestId: 1,
    });

    const initializedResult =
      initialized.payload &&
      typeof initialized.payload === 'object' &&
      'result' in initialized.payload
        ? (initialized.payload as { result?: { protocolVersion?: unknown } })
            .result
        : undefined;
    const protocolVersion =
      typeof initializedResult?.protocolVersion === 'string'
        ? initializedResult.protocolVersion
        : CUSTOM_MCP_PROTOCOL_VERSION;

    await sendCustomMcpInitializedNotification({
      url: server.url,
      headers,
      sessionId: initialized.sessionId,
      protocolVersion,
    });

    const listed = await callCustomMcpServer({
      url: server.url,
      headers,
      method: 'tools/list',
      params: {},
      sessionId: initialized.sessionId,
      protocolVersion,
      requestId: 2,
    });
    toolsPayload = listed.payload;
  }

  const result =
    toolsPayload && typeof toolsPayload === 'object' && 'result' in toolsPayload
      ? (toolsPayload as { result?: { tools?: unknown } }).result
      : undefined;

  if (!result || !Array.isArray(result.tools)) {
    throw new Error(
      `'${server.name}' did not return a tool list. Check that the URL points at a streamable-HTTP MCP endpoint.`,
    );
  }

  const disabled = new Set(server.disabledTools ?? []);

  return {
    tools: result.tools
      .filter(
        (tool): tool is { name: string; description?: string } =>
          Boolean(tool) &&
          typeof tool === 'object' &&
          typeof (tool as { name?: unknown }).name === 'string',
      )
      .map((tool) => ({
        name: tool.name,
        description:
          typeof tool.description === 'string' ? tool.description : null,
        enabled: !disabled.has(tool.name),
      })),
  };
}

/**
 * Mint (or reset) the pending OAuth connection that belongs to a custom
 * server (the owner's own row for a personal server) and return the initiate
 * URL, mirroring connectMcpCommand.
 */
export async function connectCustomMcpServerCommand(
  auth: UserAuthSuccess,
  input: { id: string; redirectTo?: string },
) {
  assertCustomMcpEnabled();
  const server = await loadManageableServer(auth, input.id);

  if (server.authType !== 'oauth' || !server.url) {
    throw new Error('This custom MCP server does not use OAuth.');
  }

  if (
    input.redirectTo &&
    (!input.redirectTo.startsWith('/') || input.redirectTo.startsWith('//'))
  ) {
    throw new Error('redirectTo must be a relative path');
  }

  const { connectionId } = await prepareCustomMcpOAuthConnection(server, {
    resetClient: true,
  });

  // Relative path so the browser stays on its current domain.
  return input.redirectTo
    ? `/api/mcp-oauth/initiate/${connectionId}?redirectTo=${encodeURIComponent(input.redirectTo)}`
    : `/api/mcp-oauth/initiate/${connectionId}`;
}

/** Drop the stored OAuth connection (tokens) without deleting the server. */
export async function disconnectCustomMcpServerCommand(
  auth: UserAuthSuccess,
  input: { id: string },
) {
  const server = await loadManageableServer(auth, input.id);

  const deleted = await db
    .delete(mcpConnections)
    .where(customMcpConnectionWhere(server))
    .returning({ id: mcpConnections.id });

  if (deleted.length > 0) {
    captureIntegrationLifecycleEvent(
      'integration_removed',
      customMcpConnectionId(input.id),
      auth.userId,
    );
  }

  return { disconnected: true };
}

export async function setCustomMcpServerEnabledCommand(
  auth: UserAuthSuccess,
  input: { id: string; enabled: boolean },
) {
  assertCustomMcpEnabled();
  const server = await loadManageableServer(auth, input.id);
  const set = { enabled: input.enabled, updatedAt: new Date() };

  if (server.ownerUserId) {
    await db
      .update(personalMcpServers)
      .set(set)
      .where(eq(personalMcpServers.id, input.id));
  } else {
    await db
      .update(customMcpServers)
      .set(set)
      .where(eq(customMcpServers.id, input.id));
  }

  captureIntegrationLifecycleEvent(
    input.enabled ? 'integration_enabled' : 'integration_disabled',
    customMcpConnectionId(input.id),
    auth.userId,
  );

  return { enabled: input.enabled };
}

export async function setCustomMcpServerDisabledToolsCommand(
  auth: UserAuthSuccess,
  input: { id: string; disabledTools: string[] },
) {
  assertCustomMcpEnabled();
  const server = await loadManageableServer(auth, input.id);

  // Deliberately no enabled filter: adjusting the deny list on a disabled
  // server is a natural part of preparing it for re-enablement.
  const set = { disabledTools: input.disabledTools, updatedAt: new Date() };

  if (server.ownerUserId) {
    await db
      .update(personalMcpServers)
      .set(set)
      .where(eq(personalMcpServers.id, input.id));
  } else {
    await db
      .update(customMcpServers)
      .set(set)
      .where(eq(customMcpServers.id, input.id));
  }

  return { disabledTools: input.disabledTools };
}

async function updatePersonalMcpServer(
  auth: UserAuthSuccess,
  existing: ResolvedCustomMcpServer,
  input: CustomMcpServerInput,
) {
  if (input.transport !== 'remote') {
    throw new Error('Personal MCP servers must be remote.');
  }
  if (existing.name !== input.name) {
    throw new Error('Custom MCP server names cannot be changed.');
  }

  const {
    stdio: _stdio,
    url,
    ...columns
  } = remoteColumns(input, {
    headers: existing.headers,
    manualClientSecret: existing.manualClientSecret,
  });

  // Same rule as deployment servers: a new URL or auth mode must never
  // inherit the old target's tokens.
  const credentialTargetChanged =
    url !== existing.url || columns.authType !== existing.authType;

  let removedConnection = false;
  await db.transaction(async (tx) => {
    await tx
      .update(personalMcpServers)
      .set({
        url,
        ...columns,
        ...(credentialTargetChanged
          ? { oauthServerMetadata: null, oauthServerMetadataFetchedAt: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(personalMcpServers.id, existing.id));

    if (credentialTargetChanged) {
      const deleted = await tx
        .delete(mcpConnections)
        .where(customMcpConnectionWhere(existing))
        .returning({ id: mcpConnections.id });
      removedConnection = deleted.length > 0;
    }
  });

  console.log(
    `[custom-mcp-servers] updated personal '${existing.name}' by user ${auth.userId}` +
      (credentialTargetChanged
        ? ' (credential target changed; tokens cleared)'
        : ''),
  );

  if (removedConnection) {
    captureIntegrationLifecycleEvent(
      'integration_removed',
      customMcpConnectionId(existing.id),
      auth.userId,
    );
  }

  return { credentialsCleared: credentialTargetChanged };
}

/**
 * Share a personal server with everyone, or take a shared one private, the
 * way an integration key's visibility changes. The row moves between the two
 * tables and keeps its id, so its proxy URL and its connection survive; the
 * connection changes hands in the same transaction so tokens are never
 * reachable under the wrong scope, not even briefly. A shared server goes
 * private to the member who added it, and only a remote one can.
 */
export async function setCustomMcpServerVisibilityCommand(
  auth: UserAuthSuccess,
  input: { id: string; visibility: CustomMcpServerVisibility },
) {
  assertCustomMcpEnabled();
  const server = await loadManageableServer(auth, input.id);
  const current: CustomMcpServerVisibility = server.ownerUserId
    ? 'owner'
    : 'deployment';
  if (current === input.visibility) return { visibility: current };

  if (input.visibility === 'owner') {
    const ownerUserId = server.createdByUserId;
    if (!ownerUserId) {
      throw new Error(
        'This server has no owner to move it to. Remove it and add a personal one instead.',
      );
    }
    if (server.isStdio || !server.url) {
      throw new Error('Local (stdio) servers cannot be personal.');
    }
    const url = server.url;

    await db.transaction(async (tx) => {
      const [countRow] = await tx
        .select({ value: count() })
        .from(personalMcpServers)
        .where(eq(personalMcpServers.ownerUserId, ownerUserId));
      if ((countRow?.value ?? 0) >= MAX_PERSONAL_MCP_SERVERS) {
        throw new Error(
          `At most ${MAX_PERSONAL_MCP_SERVERS} personal MCP servers are supported.`,
        );
      }
      const [moved] = await tx
        .insert(personalMcpServers)
        .values({
          id: server.id,
          ownerUserId,
          name: server.name,
          url,
          authType: server.authType,
          headers: server.headers,
          disabledTools: server.disabledTools,
          manualClientId: server.manualClientId,
          manualClientSecret: server.manualClientSecret,
          oauthServerMetadata: server.oauthServerMetadata,
          oauthResourceIndicatorDisabled: server.oauthResourceIndicatorDisabled,
          enabled: server.enabled,
        })
        .onConflictDoNothing({
          target: [personalMcpServers.ownerUserId, personalMcpServers.name],
        })
        .returning({ id: personalMcpServers.id });
      if (!moved) {
        throw new Error(
          `Its owner already has a personal MCP server named '${server.name}'.`,
        );
      }
      await tx
        .update(mcpConnections)
        .set({ userId: ownerUserId, updatedAt: new Date() })
        .where(customMcpConnectionWhere(server));
      await tx
        .delete(customMcpServers)
        .where(eq(customMcpServers.id, server.id));
    });
  } else {
    const ownerUserId = server.ownerUserId!;
    await db.transaction(async (tx) => {
      const [countRow] = await tx
        .select({ value: count() })
        .from(customMcpServers);
      if ((countRow?.value ?? 0) >= MAX_CUSTOM_MCP_SERVERS) {
        throw new Error(
          `At most ${MAX_CUSTOM_MCP_SERVERS} custom MCP servers are supported.`,
        );
      }
      const [moved] = await tx
        .insert(customMcpServers)
        .values({
          id: server.id,
          name: server.name,
          url: server.url,
          authType: server.authType,
          headers: server.headers,
          disabledTools: server.disabledTools,
          manualClientId: server.manualClientId,
          manualClientSecret: server.manualClientSecret,
          oauthServerMetadata: server.oauthServerMetadata,
          oauthResourceIndicatorDisabled: server.oauthResourceIndicatorDisabled,
          enabled: server.enabled,
          createdByUserId: ownerUserId,
        })
        .onConflictDoNothing({ target: [customMcpServers.name] })
        .returning({ id: customMcpServers.id });
      if (!moved) {
        throw new Error(
          `A shared MCP server named '${server.name}' already exists.`,
        );
      }
      await tx
        .update(mcpConnections)
        .set({ userId: null, updatedAt: new Date() })
        .where(customMcpConnectionWhere(server));
      await tx
        .delete(personalMcpServers)
        .where(eq(personalMcpServers.id, server.id));
    });
  }

  console.log(
    `[custom-mcp-servers] '${server.name}' is now ${input.visibility} (by user ${auth.userId})`,
  );

  return { visibility: input.visibility };
}
