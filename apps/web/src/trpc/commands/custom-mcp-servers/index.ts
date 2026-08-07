import {
  and,
  count,
  customMcpServers,
  db,
  eq,
  isNull,
  mcpConnections,
} from '@roomote/db/server';
import { decrypt, encrypt } from '@roomote/db/encryption';
import { getValidAccessToken } from '@roomote/sdk/server';
import { safeFetch } from '@roomote/sdk/server/safe-fetch';
import {
  MAX_CUSTOM_MCP_SERVERS,
  customMcpConnectionId,
  parseMcpJsonRpcPayload,
  type CustomMcpRemoteServerInput,
  type CustomMcpServerInput,
  type CustomMcpStdioServerInput,
} from '@roomote/types';
import type { UserAuthSuccess } from '@/types';
import { Env, isCustomMcpDisabled } from '@/lib/server/env';

export const CUSTOM_MCP_DISABLED_MESSAGE =
  'Custom MCP servers are disabled by the deployment operator.';

function assertAdmin(auth: UserAuthSuccess) {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
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
  createdAt: Date;
  updatedAt: Date;
}

export async function listCustomMcpServersCommand(
  auth: UserAuthSuccess,
): Promise<CustomMcpServerListEntry[]> {
  assertAdmin(auth);

  const servers = await db.query.customMcpServers.findMany({
    orderBy: (table, { asc }) => [asc(table.name)],
  });

  const connectionRows =
    servers.length > 0
      ? await db.query.mcpConnections.findMany({
          where: (table, { inArray: whereInArray }) =>
            whereInArray(
              table.mcpId,
              servers.map((server) => customMcpConnectionId(server.id)),
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

export async function createCustomMcpServerCommand(
  auth: UserAuthSuccess,
  input: CustomMcpServerInput,
) {
  assertAdmin(auth);
  assertCustomMcpEnabled();

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

  return { id: created.id };
}

export async function updateCustomMcpServerCommand(
  auth: UserAuthSuccess,
  input: { id: string; server: CustomMcpServerInput },
) {
  assertAdmin(auth);
  assertCustomMcpEnabled();

  const existing = await db.query.customMcpServers.findFirst({
    where: eq(customMcpServers.id, input.id),
  });

  if (!existing) {
    throw new Error('Custom MCP server not found.');
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
      await tx
        .delete(mcpConnections)
        .where(eq(mcpConnections.mcpId, customMcpConnectionId(input.id)));
    }
  });

  console.log(
    `[custom-mcp-servers] updated '${existing.name}' by user ${auth.userId}` +
      (credentialTargetChanged
        ? ' (credential target changed; tokens cleared)'
        : ''),
  );

  return { credentialsCleared: credentialTargetChanged };
}

export async function deleteCustomMcpServerCommand(
  auth: UserAuthSuccess,
  input: { id: string },
) {
  assertAdmin(auth);

  const existing = await db.query.customMcpServers.findFirst({
    where: eq(customMcpServers.id, input.id),
    columns: { name: true },
  });

  if (!existing) {
    return { deleted: false };
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(mcpConnections)
      .where(eq(mcpConnections.mcpId, customMcpConnectionId(input.id)));
    await tx.delete(customMcpServers).where(eq(customMcpServers.id, input.id));
  });

  console.log(
    `[custom-mcp-servers] deleted '${existing.name}' by user ${auth.userId}`,
  );

  return { deleted: true };
}

type ListedCustomMcpTool = {
  name: string;
  description: string | null;
  enabled: boolean;
};

async function callCustomMcpServer(input: {
  url: string;
  headers: Record<string, string>;
  method: string;
  params: unknown;
  sessionId?: string | null;
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
 * List the tools a custom remote server exposes, flagged with the stored
 * deny-list state. The fetch runs control-plane-side through the SSRF guard
 * with the server's real credentials (which never reach the browser).
 */
export async function listCustomMcpServerToolsCommand(
  auth: UserAuthSuccess,
  input: { id: string },
): Promise<{ tools: ListedCustomMcpTool[] }> {
  assertAdmin(auth);
  assertCustomMcpEnabled();

  const server = await db.query.customMcpServers.findFirst({
    where: eq(customMcpServers.id, input.id),
  });

  if (!server) {
    throw new Error('Custom MCP server not found.');
  }

  if (!server.url || server.stdio) {
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
      where: and(
        eq(mcpConnections.mcpId, customMcpConnectionId(server.id)),
        isNull(mcpConnections.userId),
      ),
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
    toolsPayload = direct.payload;
  } catch {
    const initialized = await callCustomMcpServer({
      url: server.url,
      headers,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'Roomote', version: '1.0.0' },
      },
      requestId: 1,
    });

    const listed = await callCustomMcpServer({
      url: server.url,
      headers,
      method: 'tools/list',
      params: {},
      sessionId: initialized.sessionId,
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
 * Mint (or reset) the pending deployment-scoped OAuth connection for a
 * custom server and return the initiate URL, mirroring connectMcpCommand.
 */
export async function connectCustomMcpServerCommand(
  auth: UserAuthSuccess,
  input: { id: string; redirectTo?: string },
) {
  assertAdmin(auth);
  assertCustomMcpEnabled();

  const server = await db.query.customMcpServers.findFirst({
    where: eq(customMcpServers.id, input.id),
  });

  if (!server) {
    throw new Error('Custom MCP server not found.');
  }

  if (server.authType !== 'oauth' || !server.url) {
    throw new Error('This custom MCP server does not use OAuth.');
  }

  if (
    input.redirectTo &&
    (!input.redirectTo.startsWith('/') || input.redirectTo.startsWith('//'))
  ) {
    throw new Error('redirectTo must be a relative path');
  }

  const [connection] = await db
    .insert(mcpConnections)
    .values({
      userId: null,
      mcpId: customMcpConnectionId(server.id),
      connectionRole: 'default',
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

  // Relative path so the browser stays on its current domain.
  return input.redirectTo
    ? `/api/mcp-oauth/initiate/${connection.id}?redirectTo=${encodeURIComponent(input.redirectTo)}`
    : `/api/mcp-oauth/initiate/${connection.id}`;
}

/** Drop the stored OAuth connection (tokens) without deleting the server. */
export async function disconnectCustomMcpServerCommand(
  auth: UserAuthSuccess,
  input: { id: string },
) {
  assertAdmin(auth);

  await db
    .delete(mcpConnections)
    .where(eq(mcpConnections.mcpId, customMcpConnectionId(input.id)));

  return { disconnected: true };
}

export async function setCustomMcpServerEnabledCommand(
  auth: UserAuthSuccess,
  input: { id: string; enabled: boolean },
) {
  assertAdmin(auth);
  assertCustomMcpEnabled();

  const [updated] = await db
    .update(customMcpServers)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(eq(customMcpServers.id, input.id))
    .returning({ id: customMcpServers.id });

  if (!updated) {
    throw new Error('Custom MCP server not found.');
  }

  return { enabled: input.enabled };
}

export async function setCustomMcpServerDisabledToolsCommand(
  auth: UserAuthSuccess,
  input: { id: string; disabledTools: string[] },
) {
  assertAdmin(auth);
  assertCustomMcpEnabled();

  const [updated] = await db
    .update(customMcpServers)
    .set({
      disabledTools: input.disabledTools,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(customMcpServers.id, input.id),
        eq(customMcpServers.enabled, true),
      ),
    )
    .returning({ id: customMcpServers.id });

  if (!updated) {
    throw new Error('Custom MCP server not found or disabled.');
  }

  return { disabledTools: input.disabledTools };
}
