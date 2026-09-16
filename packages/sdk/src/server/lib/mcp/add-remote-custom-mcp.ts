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

import { createGuardedFetch } from '../safe-fetch';
import { createMcpOauthReplay, getValidAccessToken } from './data';
import { discoverOAuthEndpoints } from './oauth';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const OAUTH_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const SETTINGS_PATH = '/settings/integrations';

type RemoteMcpTool = { name: string; description: string | null };

export type AddRemoteCustomMcpResult =
  | {
      status: 'connected';
      id: string;
      name: string;
      tools: RemoteMcpTool[];
      reused: boolean;
    }
  | {
      status: 'authorization_required';
      id: string;
      name: string;
      authorizeUrl: string;
      reused: boolean;
    }
  | {
      status: 'needs_static_headers';
      id: string;
      name: string;
      settingsUrl: string;
      reused: boolean;
    }
  | {
      status: 'client_registration_required';
      id: string;
      name: string;
      authorizeUrl: string;
      settingsUrl: string;
      reused: boolean;
    }
  | {
      status: 'disabled';
      id: string;
      name: string;
      settingsUrl: string;
      reused: true;
    };

type RemoteMcpProbe =
  | { status: 'connected'; tools: RemoteMcpTool[] }
  | { status: 'oauth'; metadata: OAuthServerMetadata }
  | { status: 'needs_static_headers' };

function publicUrl(path: string): string {
  return new URL(path, Env.R_PUBLIC_URL ?? Env.R_APP_URL).toString();
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
  const guardedFetch = createGuardedFetch(
    Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS,
  );
  const response = await guardedFetch(input.url, {
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
  const body = await response.text();
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
): Promise<RemoteMcpTool[]> {
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

  try {
    const guardedFetch = createGuardedFetch(
      Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS,
    );
    await guardedFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(initialized.sessionId
          ? { 'mcp-session-id': initialized.sessionId }
          : {}),
        'mcp-protocol-version': protocolVersion,
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
    sessionId: initialized.sessionId,
    protocolVersion,
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

  if (initialized.response.status === 401) {
    try {
      const metadata = await discoverOAuthEndpoints(url, {
        fetchImpl: createGuardedFetch(Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS),
        resource: url,
      });
      return { status: 'oauth', metadata };
    } catch {
      return { status: 'needs_static_headers' };
    }
  }

  if (!initialized.response.ok) {
    throw new Error(
      `The remote MCP endpoint returned ${initialized.response.status}.`,
    );
  }

  return { status: 'connected', tools: await listRemoteMcpTools(url) };
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
      id: server.id,
      name: server.name,
      settingsUrl: publicUrl(SETTINGS_PATH),
      reused: true,
    };
  }

  if (server.authType === 'none') {
    return {
      status: 'connected',
      id: server.id,
      name: server.name,
      tools: await listRemoteMcpTools(server.url),
      reused: input.reused,
    };
  }
  if (server.authType === 'static_headers') {
    if (server.headers && Object.keys(server.headers).length > 0) {
      return {
        status: 'connected',
        id: server.id,
        name: server.name,
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
      id: server.id,
      name: server.name,
      settingsUrl: publicUrl(SETTINGS_PATH),
      reused: input.reused,
    };
  }

  let oauthServerMetadata = server.oauthServerMetadata;
  if (!oauthServerMetadata) {
    oauthServerMetadata = await discoverOAuthEndpoints(server.url, {
      fetchImpl: createGuardedFetch(Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS),
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
  if (existingConnection?.authStatus === 'authenticated') {
    const accessToken = await getValidAccessToken(
      existingConnection.id,
      server.url,
    );
    if (accessToken) {
      return {
        status: 'connected',
        id: server.id,
        name: server.name,
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
      id: server.id,
      name: server.name,
      authorizeUrl,
      settingsUrl: publicUrl(SETTINGS_PATH),
      reused: input.reused,
    };
  }
  return {
    status: 'authorization_required',
    id: server.id,
    name: server.name,
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
    name: input.name,
    url: input.url,
    authType: 'none',
  });
  const normalizedUrl = normalizeFastRemoteMcpUrl(parsed.url);
  const servers = await db.query.customMcpServers.findMany();
  const nameMatch = servers.find((server) => server.name === parsed.name);
  const urlMatch = servers.find(
    (server) =>
      server.url && canonicalizeRemoteMcpUrl(server.url) === normalizedUrl,
  );
  if (nameMatch && urlMatch && nameMatch.id !== urlMatch.id) {
    throw new Error(
      'The requested name and URL match different custom MCP servers. Review them in Settings.',
    );
  }
  const existing = nameMatch ?? urlMatch;
  if (existing) {
    if (
      nameMatch &&
      (!nameMatch.url ||
        canonicalizeRemoteMcpUrl(nameMatch.url) !== normalizedUrl)
    ) {
      throw new Error(
        'A custom MCP server already uses that name or URL with different configuration. Review it in Settings.',
      );
    }
    return resultForServer({
      server: existing,
      userId: input.userId,
      sessionId: input.sessionId,
      reused: true,
    });
  }

  const probe = await probeRemoteMcp(normalizedUrl);
  const [countRow] = await db.select({ value: count() }).from(customMcpServers);
  if ((countRow?.value ?? 0) >= MAX_CUSTOM_MCP_SERVERS) {
    throw new Error(
      `At most ${MAX_CUSTOM_MCP_SERVERS} custom MCP servers are supported.`,
    );
  }
  const authType =
    probe.status === 'oauth'
      ? ('oauth' as const)
      : probe.status === 'needs_static_headers'
        ? ('static_headers' as const)
        : ('none' as const);
  const [created] = await db
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

  if (probe.status === 'connected') {
    return {
      status: 'connected',
      id: created.id,
      name: created.name,
      tools: probe.tools,
      reused: false,
    };
  }
  return resultForServer({
    server: created,
    userId: input.userId,
    sessionId: input.sessionId,
    reused: false,
  });
}
