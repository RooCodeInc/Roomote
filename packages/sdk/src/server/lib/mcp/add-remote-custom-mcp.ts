import { randomUUID } from 'node:crypto';

import {
  and,
  count,
  customMcpServers,
  db,
  eq,
  isNull,
  mcpConnections,
  mcpOauthReplays,
  sql,
  users,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { Env, isCustomMcpDisabled } from '@roomote/env';
import {
  MAX_CUSTOM_MCP_SERVERS,
  customMcpConnectionId,
  customMcpRemoteServerInputSchema,
  parseMcpJsonRpcPayload,
  type OAuthServerMetadata,
} from '@roomote/types';

import { createMcpOauthReplay, getValidAccessToken } from './data';
import { createBoundedCustomMcpFetch } from './custom-fetch';
import { discoverOAuthEndpoints } from './oauth';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const OAUTH_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const SETTINGS_PATH = '/settings/integrations';

type RemoteMcpTool = { name: string; description: string | null };
type ServerResultIdentity = {
  integrationId: string;
  name: string;
  usage: string;
};

export type AddRemoteCustomMcpResult =
  | (ServerResultIdentity & {
      status: 'connected';
      tools: RemoteMcpTool[];
      reused: boolean;
    })
  | (ServerResultIdentity & {
      status: 'authorization_required';
      authorizeUrl: string;
      reused: boolean;
    })
  | {
      status: 'needs_static_headers';
      name: string;
      settingsUrl: string;
      reused: false;
    }
  | (ServerResultIdentity & {
      status: 'needs_static_headers';
      settingsUrl: string;
      reused: true;
    })
  | (ServerResultIdentity & {
      status: 'client_registration_required';
      authorizeUrl?: string;
      settingsUrl: string;
      reused: boolean;
    })
  | (ServerResultIdentity & {
      status: 'disabled';
      settingsUrl: string;
      reused: true;
    });

type RemoteMcpProbe =
  | { status: 'connected'; tools: RemoteMcpTool[] }
  | { status: 'oauth'; metadata: OAuthServerMetadata }
  | { status: 'needs_static_headers' };

function publicUrl(path: string): string {
  return new URL(path, Env.R_PUBLIC_URL ?? Env.R_APP_URL).toString();
}

function serverResultIdentity(
  server: typeof customMcpServers.$inferSelect,
): ServerResultIdentity {
  return {
    integrationId: server.name,
    name: server.name,
    usage: `Use integrationId '${server.name}' with find_integration_tools and call_integration_tool. Do not use a server UUID as the integration ID.`,
  };
}

function canonicalizeRemoteMcpUrl(value: string): string {
  return new URL(value).toString();
}

function normalizeFastRemoteMcpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('Remote MCP server URLs must use HTTPS.');
  }
  return url.toString();
}

function normalizeFastRemoteMcpName(value: string): string {
  const collapsed = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/-+/g, '-');
  const withoutLeadingDash = collapsed.startsWith('-')
    ? collapsed.slice(1)
    : collapsed;
  const truncated = withoutLeadingDash.slice(0, 64);
  return truncated.endsWith('-') ? truncated.slice(0, -1) : truncated;
}

function findMatchingRemoteMcpServer(
  servers: Array<typeof customMcpServers.$inferSelect>,
  name: string,
  normalizedUrl: string,
) {
  const nameMatch = servers.find((server) => server.name === name);
  const urlMatch = servers.find(
    (server) =>
      server.url && canonicalizeRemoteMcpUrl(server.url) === normalizedUrl,
  );
  if (nameMatch && urlMatch && nameMatch.id !== urlMatch.id) {
    throw new Error(
      'The requested name and URL match different custom MCP servers. Review them in Settings.',
    );
  }
  return nameMatch ?? urlMatch;
}

function parseTools(payload: unknown): RemoteMcpTool[] | null {
  const result =
    payload && typeof payload === 'object' && 'result' in payload
      ? (payload as { result?: { tools?: unknown } }).result
      : undefined;
  if (!result || !Array.isArray(result.tools)) return null;

  return result.tools.flatMap((tool) => {
    if (
      !tool ||
      typeof tool !== 'object' ||
      typeof (tool as { name?: unknown }).name !== 'string'
    ) {
      return [];
    }
    const value = tool as { name: string; description?: unknown };
    return [
      {
        name: value.name,
        description:
          typeof value.description === 'string' ? value.description : null,
      },
    ];
  });
}

async function callRemoteMcp(input: {
  url: string;
  headers?: Record<string, string>;
  method: string;
  params: unknown;
  requestId: number;
  sessionId?: string | null;
  protocolVersion?: string;
}) {
  const response = await createBoundedCustomMcpFetch()(input.url, {
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
  const body = new TextDecoder().decode(await response.arrayBuffer());
  return {
    response,
    payload: response.ok
      ? parseMcpJsonRpcPayload(body, response.headers.get('content-type'))
      : null,
    sessionId: response.headers.get('mcp-session-id'),
  };
}

async function listRemoteMcpTools(
  url: string,
  headers: Record<string, string> = {},
  session?: { sessionId: string | null; protocolVersion: string },
): Promise<RemoteMcpTool[]> {
  if (session) {
    try {
      await createBoundedCustomMcpFetch()(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(session.sessionId ? { 'mcp-session-id': session.sessionId } : {}),
          'mcp-protocol-version': session.protocolVersion,
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      });
    } catch {
      // Strict servers enforce this on the following tools/list request.
    }
    const listed = await callRemoteMcp({
      url,
      headers,
      method: 'tools/list',
      params: {},
      requestId: 2,
      sessionId: session.sessionId,
      protocolVersion: session.protocolVersion,
    });
    if (!listed.response.ok) {
      throw new Error(
        `Custom MCP tools/list failed (${listed.response.status}).`,
      );
    }
    const tools = parseTools(listed.payload);
    if (!tools) throw new Error('Custom MCP server did not return tools.');
    return tools;
  }

  const direct = await callRemoteMcp({
    url,
    headers,
    method: 'tools/list',
    params: {},
    requestId: 1,
  });
  if (direct.response.ok) {
    const tools = parseTools(direct.payload);
    if (tools) return tools;
  }

  const initialized = await callRemoteMcp({
    url,
    headers,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Roomote', version: '1.0.0' },
    },
    requestId: 1,
  });
  if (!initialized.response.ok) {
    throw new Error(
      `Custom MCP initialize failed (${initialized.response.status}).`,
    );
  }
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
      : MCP_PROTOCOL_VERSION;

  return listRemoteMcpTools(url, headers, {
    sessionId: initialized.sessionId,
    protocolVersion,
  });
}

async function probeRemoteMcp(url: string): Promise<RemoteMcpProbe> {
  const initialized = await callRemoteMcp({
    url,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Roomote', version: '1.0.0' },
    },
    requestId: 1,
  });

  if (
    initialized.response.status === 401 ||
    initialized.response.status === 403
  ) {
    const boundedFetch = createBoundedCustomMcpFetch();
    let indeterminateFailure = false;
    let successfulMetadataResponse = false;
    const fetchImpl = async (
      requestUrl: string,
      init?: Parameters<typeof boundedFetch>[1],
    ) => {
      try {
        const response = await boundedFetch(requestUrl, init);
        const isResourceRequest =
          canonicalizeRemoteMcpUrl(requestUrl) ===
          canonicalizeRemoteMcpUrl(url);
        if (!isResourceRequest && response.ok) {
          successfulMetadataResponse = true;
        }
        if (
          !response.ok &&
          !(isResourceRequest && [401, 403].includes(response.status)) &&
          ![404, 410].includes(response.status)
        ) {
          indeterminateFailure = true;
        }
        return response;
      } catch (error) {
        indeterminateFailure = true;
        throw error;
      }
    };
    try {
      const metadata = await discoverOAuthEndpoints(url, {
        fetchImpl,
        resource: url,
      });
      return { status: 'oauth', metadata };
    } catch (error) {
      if (indeterminateFailure || successfulMetadataResponse) throw error;
      return { status: 'needs_static_headers' };
    }
  }

  if (!initialized.response.ok) {
    throw new Error(
      `The remote MCP endpoint returned ${initialized.response.status}.`,
    );
  }

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
      : MCP_PROTOCOL_VERSION;
  return {
    status: 'connected',
    tools: await listRemoteMcpTools(
      url,
      {},
      {
        sessionId: initialized.sessionId,
        protocolVersion,
      },
    ),
  };
}

async function prepareOAuthReplay(input: {
  connectionId: string;
  mcpId: string;
  sessionId: string;
  userId: string;
}): Promise<string> {
  const existing = await db.query.mcpOauthReplays.findFirst({
    where: and(
      eq(mcpOauthReplays.userId, input.userId),
      eq(mcpOauthReplays.mcpId, input.mcpId),
      eq(mcpOauthReplays.connectionId, input.connectionId),
      eq(mcpOauthReplays.sessionId, input.sessionId),
    ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
  if (existing && existing.expiresAt > new Date()) {
    return publicUrl(
      `/api/mcp-oauth/replay/${encodeURIComponent(existing.token)}`,
    );
  }

  const token = randomUUID();
  const redirectTo = `/sessions/${encodeURIComponent(input.sessionId)}`;
  await createMcpOauthReplay({
    token,
    userId: input.userId,
    mcpId: input.mcpId,
    connectionRole: 'default',
    connectionId: input.connectionId,
    sessionId: input.sessionId,
    redirectTo,
    expiresAt: new Date(Date.now() + OAUTH_REPLAY_TTL_MS),
  });
  return publicUrl(`/api/mcp-oauth/replay/${encodeURIComponent(token)}`);
}

export async function prepareDeploymentCustomMcpOAuthConnection(
  serverId: string,
  options: { resetClient?: boolean } = {},
) {
  const mcpId = customMcpConnectionId(serverId);
  const [connection] = await db
    .insert(mcpConnections)
    .values({
      userId: null,
      mcpId,
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
        ...(options.resetClient ? { authConfig: {} } : {}),
        enabled: false,
        authStatus: 'pending',
        updatedAt: new Date(),
      },
    })
    .returning({ id: mcpConnections.id });
  if (!connection) throw new Error('Failed to prepare MCP authorization.');
  return { connectionId: connection.id, mcpId };
}

async function resultForServer(input: {
  server: typeof customMcpServers.$inferSelect;
  userId: string;
  sessionId: string;
  reused: boolean;
}): Promise<AddRemoteCustomMcpResult> {
  const { server } = input;
  if (!server.url) throw new Error('The matching custom MCP is not remote.');
  if (!server.enabled) {
    return {
      status: 'disabled',
      ...serverResultIdentity(server),
      settingsUrl: publicUrl(SETTINGS_PATH),
      reused: true,
    };
  }

  if (server.authType === 'none') {
    return {
      status: 'connected',
      ...serverResultIdentity(server),
      tools: await listRemoteMcpTools(server.url),
      reused: input.reused,
    };
  }
  if (server.authType === 'static_headers') {
    if (server.headers && Object.keys(server.headers).length > 0) {
      return {
        status: 'connected',
        ...serverResultIdentity(server),
        tools: await listRemoteMcpTools(
          server.url,
          Object.fromEntries(
            Object.entries(server.headers).map(([name, value]) => [
              name,
              decrypt(value),
            ]),
          ),
        ),
        reused: input.reused,
      };
    }
    return {
      status: 'needs_static_headers',
      ...serverResultIdentity(server),
      settingsUrl: publicUrl(SETTINGS_PATH),
      reused: input.reused,
    };
  }

  let oauthServerMetadata = server.oauthServerMetadata;
  if (!oauthServerMetadata) {
    oauthServerMetadata = await discoverOAuthEndpoints(server.url, {
      fetchImpl: createBoundedCustomMcpFetch(),
      resource: server.url,
    });
    await db
      .update(customMcpServers)
      .set({
        oauthServerMetadata,
        oauthServerMetadataFetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(customMcpServers.id, server.id));
  }

  const existingConnection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, customMcpConnectionId(server.id)),
      isNull(mcpConnections.userId),
    ),
  });
  if (existingConnection?.authStatus === 'error' && !server.manualClientId) {
    return {
      status: 'client_registration_required',
      ...serverResultIdentity(server),
      settingsUrl: publicUrl(SETTINGS_PATH),
      reused: input.reused,
    };
  }
  if (existingConnection?.authStatus === 'authenticated') {
    const accessToken = await getValidAccessToken(
      existingConnection.id,
      server.url,
    );
    if (accessToken) {
      return {
        status: 'connected',
        ...serverResultIdentity(server),
        tools: await listRemoteMcpTools(server.url, {
          authorization: `Bearer ${accessToken}`,
        }),
        reused: input.reused,
      };
    }
  }

  const { connectionId, mcpId } =
    await prepareDeploymentCustomMcpOAuthConnection(server.id);
  const authorizeUrl = await prepareOAuthReplay({
    connectionId,
    mcpId,
    sessionId: input.sessionId,
    userId: input.userId,
  });
  if (!server.manualClientId && !oauthServerMetadata.registration_endpoint) {
    return {
      status: 'client_registration_required',
      ...serverResultIdentity(server),
      authorizeUrl,
      settingsUrl: publicUrl(SETTINGS_PATH),
      reused: input.reused,
    };
  }
  return {
    status: 'authorization_required',
    ...serverResultIdentity(server),
    authorizeUrl,
    reused: input.reused,
  };
}

export async function addRemoteCustomMcpForFast(input: {
  userId: string;
  sessionId: string;
  name: string;
  url: string;
}): Promise<AddRemoteCustomMcpResult> {
  if (isCustomMcpDisabled(Env.R_CUSTOM_MCP_DISABLED)) {
    throw new Error(
      'Custom MCP servers are disabled by the deployment operator.',
    );
  }
  const user = await db.query.users.findFirst({
    where: eq(users.id, input.userId),
    columns: { role: true, deletedAt: true },
  });
  if (!user || user.deletedAt || user.role !== 'admin') {
    throw new Error(
      'Only deployment administrators can add custom MCP servers.',
    );
  }

  const parsed = customMcpRemoteServerInputSchema.parse({
    transport: 'remote',
    name: normalizeFastRemoteMcpName(input.name),
    url: input.url,
    authType: 'none',
  });
  const normalizedUrl = normalizeFastRemoteMcpUrl(parsed.url);
  const existing = findMatchingRemoteMcpServer(
    await db.query.customMcpServers.findMany(),
    parsed.name,
    normalizedUrl,
  );
  if (existing) {
    return resultForServer({
      server: existing,
      userId: input.userId,
      sessionId: input.sessionId,
      reused: true,
    });
  }

  const probe = await probeRemoteMcp(normalizedUrl);
  if (probe.status === 'needs_static_headers') {
    return {
      status: 'needs_static_headers',
      name: parsed.name,
      settingsUrl: publicUrl(SETTINGS_PATH),
      reused: false,
    };
  }
  const selected = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${normalizedUrl}, 0))`,
    );
    const lockedExisting = findMatchingRemoteMcpServer(
      await tx.query.customMcpServers.findMany(),
      parsed.name,
      normalizedUrl,
    );
    if (lockedExisting) {
      return { server: lockedExisting, reused: true as const };
    }

    const [countRow] = await tx
      .select({ value: count() })
      .from(customMcpServers);
    if ((countRow?.value ?? 0) >= MAX_CUSTOM_MCP_SERVERS) {
      throw new Error(
        `At most ${MAX_CUSTOM_MCP_SERVERS} custom MCP servers are supported.`,
      );
    }
    const authType =
      probe.status === 'oauth' ? ('oauth' as const) : ('none' as const);
    const [created] = await tx
      .insert(customMcpServers)
      .values({
        name: parsed.name,
        url: normalizedUrl,
        authType,
        createdByUserId: input.userId,
        ...(probe.status === 'oauth'
          ? {
              oauthServerMetadata: probe.metadata,
              oauthServerMetadataFetchedAt: new Date(),
            }
          : {}),
      })
      .onConflictDoNothing({ target: [customMcpServers.name] })
      .returning();
    if (!created) {
      throw new Error(
        `A custom MCP server named '${parsed.name}' already exists.`,
      );
    }
    return { server: created, reused: false as const };
  });

  if (selected.reused) {
    return resultForServer({
      server: selected.server,
      userId: input.userId,
      sessionId: input.sessionId,
      reused: true,
    });
  }

  if (probe.status === 'connected') {
    return {
      status: 'connected',
      ...serverResultIdentity(selected.server),
      tools: probe.tools,
      reused: false,
    };
  }
  return resultForServer({
    server: selected.server,
    userId: input.userId,
    sessionId: input.sessionId,
    reused: false,
  });
}
