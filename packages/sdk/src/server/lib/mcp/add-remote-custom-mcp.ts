import { randomUUID } from 'node:crypto';

import {
  and,
  db,
  eq,
  mcpConnections,
  mcpOauthReplays,
  sql,
  users,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { Env, isCustomMcpDisabled } from '@roomote/env';
import {
  DEFAULT_CUSTOM_MCP_SERVER_VISIBILITY,
  MAX_CUSTOM_MCP_SERVERS,
  MAX_PERSONAL_MCP_SERVERS,
  PRODUCT_NAME,
  customMcpConnectionId,
  customMcpRemoteServerInputSchema,
  parseMcpJsonRpcPayload,
  type OAuthClientInformation,
  type CustomMcpServerVisibility,
  type OAuthClientMetadata,
  type OAuthServerMetadata,
} from '@roomote/types';

import {
  createMcpOauthReplay,
  getClientInformation,
  getValidAccessToken,
  storeClientInformation,
  updateAuthStatus,
} from './data';
import { createBoundedCustomMcpFetch } from './custom-fetch';
import {
  canManageCustomMcpServer,
  customMcpConnectionWhere,
  customMcpServerStore,
  findCustomMcpServerById,
  storeCustomMcpServerMetadata,
  type CustomMcpServerScope,
  type ResolvedCustomMcpServer,
} from './custom-servers';
import {
  ClientRegistrationRejectedError,
  discoverOAuthEndpoints,
  discoverOAuthProtectedResourceMetadata,
  getPreferredTokenEndpointAuthMethod,
  registerOAuthClient,
} from './oauth';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const OAUTH_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const SETTINGS_PATH = '/integrations';
const PERSONAL_SETTINGS_PATH = '/settings/personal';

type RemoteMcpTool = { name: string; description: string | null };
type ServerResultIdentity = {
  integrationId: string;
  name: string;
  /** `owner`: private to the requesting member. `deployment`: shared with everyone. */
  visibility: CustomMcpServerVisibility;
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
      /** The provider's own explanation when it refused to register this deployment. */
      reason?: string;
      reused: boolean;
    })
  | (ServerResultIdentity & {
      status: 'disabled';
      settingsUrl: string;
      reused: true;
    })
  | (ServerResultIdentity & {
      /**
       * A shared server someone else added still needs setup only they or an
       * administrator can finish. No link is returned: it would not work for
       * this member.
       */
      status: 'pending_owner';
      reused: true;
    });

type RemoteMcpProbe =
  | { status: 'connected'; tools: RemoteMcpTool[] }
  | { status: 'oauth'; metadata: OAuthServerMetadata }
  | { status: 'needs_static_headers' };

function publicUrl(path: string): string {
  return new URL(path, Env.R_PUBLIC_URL ?? Env.R_APP_URL).toString();
}

function settingsUrlFor(server: { ownerUserId: string | null }): string {
  return publicUrl(server.ownerUserId ? PERSONAL_SETTINGS_PATH : SETTINGS_PATH);
}

function serverResultIdentity(server: {
  name: string;
  ownerUserId: string | null;
}): ServerResultIdentity {
  return {
    integrationId: server.name,
    name: server.name,
    visibility: server.ownerUserId ? 'owner' : 'deployment',
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

function findMatchingRemoteMcpServer<
  T extends { id: string; name: string; url: string | null },
>(servers: T[], name: string, normalizedUrl: string): T | undefined {
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

const REGISTRATION_REASON_MAX_CHARS = 300;
const CALLBACK_PATH = '/api/mcp-oauth/callback';

/**
 * The provider's own explanation of a refused client registration, in a
 * form safe to hand to the agent: the OAuth `error_description` (or `error`)
 * when the body is JSON, otherwise the plain text, with control characters
 * and markup delimiters (angle brackets, quotes, ampersands) removed and the
 * length bounded. Undefined when there is nothing usable.
 */
export function describeRegistrationRefusal(
  error: unknown,
): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const body =
    error instanceof ClientRegistrationRejectedError
      ? error.body
      : message.replace(/^OAuth client registration failed:\s*/, '');
  let text = body;
  try {
    const parsed = JSON.parse(body) as {
      error_description?: unknown;
      error?: unknown;
    } | null;
    const detail =
      typeof parsed?.error_description === 'string'
        ? parsed.error_description
        : typeof parsed?.error === 'string'
          ? parsed.error
          : '';
    if (detail) text = detail;
  } catch {
    // Plain-text body.
  }
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f<>"'&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > REGISTRATION_REASON_MAX_CHARS
    ? `${cleaned.slice(0, REGISTRATION_REASON_MAX_CHARS - 1)}…`
    : cleaned;
}

/**
 * Register this deployment with the server's authorization server now, so
 * the authorization link handed to the human is one that can succeed. A
 * provider that only accepts approved clients refuses here, which is the
 * fact the agent needs before suggesting the route. The initiate route
 * reuses the stored client and skips its own registration.
 */
async function ensureRegisteredClient(
  server: { name: string; url: string | null },
  connectionId: string,
  serverMetadata: OAuthServerMetadata,
): Promise<{ ok: true } | { ok: false; reason: string | undefined }> {
  const serverUrl = server.url;
  if (!serverUrl) {
    throw new Error('Remote MCP servers need a URL to register a client.');
  }
  const redirectUri = publicUrl(CALLBACK_PATH);
  if (
    await getClientInformation(connectionId, {
      expectedRedirectUri: redirectUri,
    })
  ) {
    return { ok: true };
  }
  const options = {
    fetchImpl: createBoundedCustomMcpFetch(),
    resource: serverUrl,
  };
  const protectedResourceMetadata =
    await discoverOAuthProtectedResourceMetadata(serverUrl, options);
  const requestedScope =
    protectedResourceMetadata?.scopes_supported?.join(' ') || undefined;
  const tokenEndpointAuthMethod =
    getPreferredTokenEndpointAuthMethod(serverMetadata);
  const clientMetadata: OAuthClientMetadata = {
    client_name: `${PRODUCT_NAME} - ${server.name}`,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    ...(requestedScope ? { scope: requestedScope } : {}),
  };
  let registered: OAuthClientInformation;
  try {
    registered = await registerOAuthClient(
      serverMetadata.registration_endpoint!,
      clientMetadata,
      options,
    );
  } catch (error) {
    // Only the provider's own decision is a refusal. A timeout, a guarded
    // fetch failure, or a 5xx is left unresolved so the next attempt retries
    // instead of routing this server to manual setup for good.
    if (error instanceof ClientRegistrationRejectedError && error.isRefusal) {
      return { ok: false, reason: describeRegistrationRefusal(error) };
    }
    const detail = describeRegistrationRefusal(error);
    throw new Error(
      `Could not register with the provider right now; try again later.${
        detail ? ` (${detail})` : ''
      }`,
    );
  }
  await storeClientInformation(
    connectionId,
    {
      ...registered,
      token_endpoint_auth_method:
        registered.token_endpoint_auth_method ?? tokenEndpointAuthMethod,
    },
    redirectUri,
  );
  return { ok: true };
}

export async function prepareDeploymentCustomMcpOAuthConnection(
  serverId: string,
  options: { resetClient?: boolean } = {},
) {
  return prepareCustomMcpOAuthConnection(
    { id: serverId, ownerUserId: null },
    options,
  );
}

/**
 * Mint or reset the pending OAuth connection that belongs to a server: the
 * deployment row for a shared server, the owner's own row for a personal one.
 */
export async function prepareCustomMcpOAuthConnection(
  server: { id: string; ownerUserId: string | null },
  options: { resetClient?: boolean } = {},
) {
  const mcpId = customMcpConnectionId(server.id);
  const [connection] = await db
    .insert(mcpConnections)
    .values({
      userId: server.ownerUserId,
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
  server: ResolvedCustomMcpServer;
  actor: { userId: string; isAdmin: boolean };
  sessionId: string;
  reused: boolean;
}): Promise<AddRemoteCustomMcpResult> {
  const { server, actor } = input;
  const serverUrl = server.url;
  if (!serverUrl) throw new Error('The matching custom MCP is not remote.');
  const identity = serverResultIdentity(server);
  const settingsUrl = settingsUrlFor(server);
  // Setup (headers, client registration, authorization) is for whoever may
  // manage the server. Another member who asks for the same shared server is
  // told it is waiting on its owner, never handed a link that cannot work.
  const canManage = canManageCustomMcpServer(server, actor);
  const pendingOwner = (): AddRemoteCustomMcpResult => ({
    status: 'pending_owner',
    ...identity,
    reused: true,
  });

  if (!server.enabled) {
    return canManage
      ? { status: 'disabled', ...identity, settingsUrl, reused: true }
      : pendingOwner();
  }

  if (server.authType === 'none') {
    return {
      status: 'connected',
      ...identity,
      tools: await listRemoteMcpTools(serverUrl),
      reused: input.reused,
    };
  }
  if (server.authType === 'static_headers') {
    if (server.headers && Object.keys(server.headers).length > 0) {
      return {
        status: 'connected',
        ...identity,
        tools: await listRemoteMcpTools(
          serverUrl,
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
    if (!canManage) return pendingOwner();
    return {
      status: 'needs_static_headers',
      ...identity,
      settingsUrl,
      reused: input.reused,
    };
  }

  const existingConnection = await db.query.mcpConnections.findFirst({
    where: customMcpConnectionWhere(server),
  });
  if (existingConnection?.authStatus === 'authenticated') {
    const accessToken = await getValidAccessToken(
      existingConnection.id,
      serverUrl,
    );
    if (accessToken) {
      return {
        status: 'connected',
        ...identity,
        tools: await listRemoteMcpTools(serverUrl, {
          authorization: `Bearer ${accessToken}`,
        }),
        reused: input.reused,
      };
    }
  }
  if (!canManage) return pendingOwner();

  let oauthServerMetadata = server.oauthServerMetadata;
  if (!oauthServerMetadata) {
    oauthServerMetadata = await discoverOAuthEndpoints(serverUrl, {
      fetchImpl: createBoundedCustomMcpFetch(),
      resource: serverUrl,
    });
    await storeCustomMcpServerMetadata(server, oauthServerMetadata);
  }

  if (existingConnection?.authStatus === 'error' && !server.manualClientId) {
    return {
      status: 'client_registration_required',
      ...identity,
      settingsUrl,
      reused: input.reused,
    };
  }

  const { connectionId, mcpId } = await prepareCustomMcpOAuthConnection(server);
  if (!server.manualClientId && !oauthServerMetadata.registration_endpoint) {
    return {
      status: 'client_registration_required',
      ...identity,
      authorizeUrl: await prepareOAuthReplay({
        connectionId,
        mcpId,
        sessionId: input.sessionId,
        userId: actor.userId,
      }),
      settingsUrl,
      reused: input.reused,
    };
  }
  if (!server.manualClientId) {
    const registration = await ensureRegisteredClient(
      server,
      connectionId,
      oauthServerMetadata,
    );
    if (!registration.ok) {
      await updateAuthStatus(connectionId, 'error', false);
      return {
        status: 'client_registration_required',
        ...identity,
        settingsUrl,
        ...(registration.reason ? { reason: registration.reason } : {}),
        reused: input.reused,
      };
    }
  }
  const authorizeUrl = await prepareOAuthReplay({
    connectionId,
    mcpId,
    sessionId: input.sessionId,
    userId: actor.userId,
  });
  return {
    status: 'authorization_required',
    ...identity,
    authorizeUrl,
    reused: input.reused,
  };
}

/** Resolve a freshly written or matched row into the shared server shape. */
async function requireServer(id: string): Promise<ResolvedCustomMcpServer> {
  const server = await findCustomMcpServerById(id);
  if (!server) throw new Error('The custom MCP server could not be loaded.');
  return server;
}

/**
 * Add, or find again, a remote MCP server for a Fast Session. Any active
 * member may call this, mirroring integration keys: `deployment` (the
 * default) shares the server with everyone, `owner` keeps it private to the
 * requesting member under Personal settings.
 */
export async function addRemoteCustomMcpForFast(input: {
  userId: string;
  sessionId: string;
  name: string;
  url: string;
  visibility?: CustomMcpServerVisibility;
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
  if (!user || user.deletedAt) {
    throw new Error('Only active members can add custom MCP servers.');
  }
  const actor = { userId: input.userId, isAdmin: user.role === 'admin' };
  const visibility = input.visibility ?? DEFAULT_CUSTOM_MCP_SERVER_VISIBILITY;

  const parsed = customMcpRemoteServerInputSchema.parse({
    transport: 'remote',
    name: normalizeFastRemoteMcpName(input.name),
    url: input.url,
    authType: 'none',
  });
  const normalizedUrl = normalizeFastRemoteMcpUrl(parsed.url);

  return addScopedRemoteMcp({
    ...input,
    actor,
    parsed,
    normalizedUrl,
    scope:
      visibility === 'owner'
        ? { visibility: 'owner', ownerUserId: actor.userId }
        : { visibility: 'deployment' },
  });
}

type AddRemoteMcpContext = {
  sessionId: string;
  actor: { userId: string; isAdmin: boolean };
  parsed: { name: string };
  normalizedUrl: string;
  scope: CustomMcpServerScope;
};

async function addScopedRemoteMcp(
  input: AddRemoteMcpContext,
): Promise<AddRemoteCustomMcpResult> {
  const { actor, parsed, normalizedUrl, scope } = input;
  const store = customMcpServerStore(scope);
  const existing = findMatchingRemoteMcpServer(
    await store.list(),
    parsed.name,
    normalizedUrl,
  );
  if (existing) {
    return resultForServer({
      server: await requireServer(existing.id),
      actor,
      sessionId: input.sessionId,
      reused: true,
    });
  }

  const probe = await probeRemoteMcp(normalizedUrl);
  if (probe.status === 'needs_static_headers') {
    return {
      status: 'needs_static_headers',
      name: parsed.name,
      settingsUrl: publicUrl(
        scope.visibility === 'owner' ? PERSONAL_SETTINGS_PATH : SETTINGS_PATH,
      ),
      reused: false,
    };
  }
  const selected = await db.transaction(async (tx) => {
    const lockKey =
      scope.visibility === 'owner'
        ? `${scope.ownerUserId}:${normalizedUrl}`
        : normalizedUrl;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    const transactionStore = customMcpServerStore(scope, tx);
    const scopedServers = await transactionStore.list();
    const lockedExisting = findMatchingRemoteMcpServer(
      scopedServers,
      parsed.name,
      normalizedUrl,
    );
    if (lockedExisting) {
      return { id: lockedExisting.id, reused: true as const };
    }
    const limit =
      scope.visibility === 'owner'
        ? MAX_PERSONAL_MCP_SERVERS
        : MAX_CUSTOM_MCP_SERVERS;
    if (scopedServers.length >= limit) {
      throw new Error(
        scope.visibility === 'owner'
          ? `At most ${limit} personal MCP servers are supported.`
          : `At most ${limit} custom MCP servers are supported.`,
      );
    }
    const created = await transactionStore.create({
      name: parsed.name,
      url: normalizedUrl,
      authType:
        probe.status === 'oauth' ? ('oauth' as const) : ('none' as const),
      createdByUserId: actor.userId,
      ...(probe.status === 'oauth'
        ? {
            oauthServerMetadata: probe.metadata,
            oauthServerMetadataFetchedAt: new Date(),
          }
        : {}),
    });
    if (!created) {
      throw new Error(
        scope.visibility === 'owner'
          ? `You already have a personal MCP server named '${parsed.name}'.`
          : `A custom MCP server named '${parsed.name}' already exists.`,
      );
    }
    return { id: created.id, reused: false as const };
  });

  if (!selected.reused && probe.status === 'connected') {
    return {
      status: 'connected',
      ...serverResultIdentity({
        name: parsed.name,
        ownerUserId: scope.visibility === 'owner' ? scope.ownerUserId : null,
      }),
      tools: probe.tools,
      reused: false,
    };
  }
  return resultForServer({
    server: await requireServer(selected.id),
    actor,
    sessionId: input.sessionId,
    reused: selected.reused,
  });
}
