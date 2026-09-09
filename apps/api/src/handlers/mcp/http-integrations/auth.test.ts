import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  configureAuthClientEnv,
  createAuthToken,
  createMcpAccessToken,
  createPublicAuthToken,
  createRunToken,
  createSessionBrokerToken,
} from '@roomote/auth';
import {
  db,
  eq,
  inArray,
  taskFactory,
  taskRuns,
  tasks,
  userFactory,
  users,
  sessions,
  sessionTasks,
  fastAgentConversations,
  sessionFactory,
  sql,
} from '@roomote/db/server';
import {
  createSessionSecret,
  prepareSessionSecret,
  revokeSessionSecret,
} from '@roomote/sdk/server/session-secrets';
import { TaskPayloadKind } from '@roomote/types';
import { routePolicyMiddleware } from '../../../middleware/routePolicyMiddleware';
import { tokenAuthMiddleware } from '../../../middleware/tokenAuthMiddleware';
import type { Variables } from '../../../types';
import { findRoutePolicyRule } from '../../../route-policies';
import { fetch } from 'undici';
import {
  integrationRequest,
  loadHttpIntegrationsConfig,
  type HttpIntegrationsConfig,
} from './broker';
import { createHttpIntegrationsMcp } from './index';

const { enabled, destroy } = vi.hoisted(() => ({
  enabled: { value: true },
  destroy: vi.fn(async () => {}),
}));
vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();
  return {
    ...actual,
    Env: new Proxy(actual.Env, {
      get(target, key) {
        return key === 'R_HTTP_INTEGRATIONS_ENABLED'
          ? enabled.value
          : Reflect.get(target, key);
      },
    }),
  };
});

vi.mock('./broker', async (importOriginal) => {
  const original = await importOriginal<typeof import('./broker')>();
  return {
    ...original,
    integrationRequest: vi.fn(original.integrationRequest),
    loadHttpIntegrationsConfig: vi.fn(),
  };
});
vi.mock('undici', () => ({
  fetch: vi.fn(),
  Agent: vi.fn(
    class {
      destroy = destroy;
    },
  ),
}));

const config: HttpIntegrationsConfig = {
  integrations: [
    {
      id: 'example',
      description: 'Example read-only integration',
      origin: 'https://integration.example.test',
      rules: [{ method: 'GET', pathPrefix: '/items' }],
      credential: {
        header: 'X-Test-Broker-Credential',
        valueEnv: 'HTTP_TEST_AUTH_SECRET',
      },
    },
  ],
};
const userIds: string[] = [];
const taskIds: string[] = [];
const sessionIds: string[] = [];
const secretRefs: string[] = [];
const path = '/api/mcp/http-integrations';
let app: Hono<{ Variables: Variables }>;
const observedAuth = vi.fn();

it('inherits authenticated JSON-RPC route policy at both mount forms', () => {
  for (const route of [path, `${path}/`]) {
    expect(findRoutePolicyRule(route)).toMatchObject({
      policy: 'authenticated',
      errorFormat: 'json-rpc',
    });
  }
});

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  configureAuthClientEnv({
    jobAuthPrivateKey: privateKey,
    jobAuthPublicKey: publicKey,
  });
});

afterAll(() => configureAuthClientEnv(null));

beforeEach(() => {
  observedAuth.mockClear();
  enabled.value = true;
  vi.mocked(integrationRequest).mockClear();
  vi.mocked(loadHttpIntegrationsConfig)
    .mockReset()
    .mockImplementation(() => structuredClone(config));
  vi.mocked(fetch)
    .mockReset()
    .mockImplementation(async () => Response.json({ ok: true }) as never);
  vi.stubEnv(
    'HTTP_TEST_AUTH_SECRET',
    'test-only-credential-must-never-be-returned',
  );
  app = createApp();
});

function createApp() {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', tokenAuthMiddleware());
  app.use('*', async (c, next) => {
    observedAuth({
      authContext: c.get('authContext'),
      sessionBrokerAuth: c.get('sessionBrokerAuth'),
    });
    await next();
  });
  app.use('*', routePolicyMiddleware);
  app.route(path, createHttpIntegrationsMcp());
  return app;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete config.integrations[0]!.allowedUserIds;
  if (secretRefs.length)
    await db.execute(
      sql`delete from session_secret_audit where secret_ref in ${secretRefs.splice(0)}`,
    );
  if (sessionIds.length)
    await db.delete(sessions).where(inArray(sessions.id, sessionIds.splice(0)));
  if (taskIds.length)
    await db.delete(tasks).where(inArray(tasks.id, taskIds.splice(0)));
  if (userIds.length)
    await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

async function member() {
  const user = await userFactory.create({ role: 'member' });
  userIds.push(user.id);
  return user;
}

it.each([
  [path, true],
  [`${path}/`, true],
  [path, false],
  [`${path}/`, false],
])(
  'rejects oversized POST envelopes at %s (content-length: %s) before MCP or broker execution',
  async (route, contentLength) => {
    const actor = await member();
    const token = await createAuthToken({
      userId: actor.id,
      timeoutMs: 60_000,
    });
    const handleRequest = vi.spyOn(
      WebStandardStreamableHTTPServerTransport.prototype,
      'handleRequest',
    );
    const envelope = new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'caller-controlled-secret',
        method: 'tools/call',
        params: {
          name: 'integration_request',
          arguments: {
            integrationId: 'example',
            method: 'GET',
            path: '/items',
          },
        },
        padding: 'x'.repeat(2 * 1024 * 1024),
      }),
    );
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === envelope.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 64 * 1024, envelope.length);
        controller.enqueue(envelope.subarray(offset, end));
        offset = end;
      },
    });
    const request = new Request(`http://localhost${route}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(contentLength ? { 'content-length': String(envelope.length) } : {}),
      },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.has('content-length')).toBe(contentLength);
    const response = await app.request(request);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: 'HTTP integrations request body too large',
      },
    });
    expect(handleRequest).not.toHaveBeenCalled();
    // Credential lookup and upstream access are downstream of this broker boundary.
    expect(integrationRequest).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

async function run(ownerId: string, actingUserId: string | null) {
  const task = await taskFactory.create({ initiatorUserId: ownerId });
  taskIds.push(task.id);
  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: task.id,
      actingUserId,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: { repo: '', description: 'HTTP integrations route auth test' },
    })
    .returning({ id: taskRuns.id });
  return run!.id;
}

function post(
  token?: string,
  method = 'tools/list',
  params?: Record<string, unknown>,
  route = path,
) {
  return app.request(route, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  });
}

it('publishes optional nullable body fields without defaults and accepts native empty arguments', async () => {
  const actor = await member();
  const token = await createAuthToken({ userId: actor.id, timeoutMs: 60_000 });
  const listing = await (await post(token)).json();
  const schema = listing.result.tools.find(
    (tool: { name: string }) => tool.name === 'integration_request',
  ).inputSchema;
  expect(schema.required).toEqual(['integrationId', 'method', 'path']);
  expect(schema.additionalProperties).toBe(false);
  for (const name of ['body', 'contentType']) {
    const property = schema.properties[name];
    const types = [property, ...(property.anyOf ?? [])].flatMap(
      (item: { type?: string | string[] }) =>
        Array.isArray(item.type) ? item.type : [item.type],
    );
    expect(types).toContain('null');
    expect(property).not.toHaveProperty('default');
  }
  for (const fields of [
    {},
    { body: '', contentType: 'text/plain' },
    { body: null, contentType: null },
  ]) {
    const response = await post(token, 'tools/call', {
      name: 'integration_request',
      arguments: {
        integrationId: 'example',
        method: 'GET',
        path: '/items',
        ...fields,
      },
    });
    const payload = await response.json();
    expect(payload.result.isError).not.toBe(true);
    expect(vi.mocked(fetch).mock.lastCall![1]).not.toHaveProperty('body');
    expect(vi.mocked(fetch).mock.lastCall![1]?.headers).toEqual({
      'X-Test-Broker-Credential': 'test-only-credential-must-never-be-returned',
    });
    expect(JSON.stringify(payload)).not.toContain(
      'test-only-credential-must-never-be-returned',
    );
  }
});

it.each([path, `${path}/`])(
  'rejects missing authentication at %s',
  async (route) => {
    const response = await post(undefined, 'tools/list', undefined, route);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32001,
        message: 'Unauthorized: missing or invalid bearer token',
      },
    });
  },
);

it.each(['auth', 'run', 'deployment-run'] as const)(
  'allows a real %s token with an active member actor without leaking configuration',
  async (kind) => {
    const actor = await member();
    const owner = await member();
    const token =
      kind === 'auth'
        ? await createAuthToken({ userId: actor.id, timeoutMs: 60_000 })
        : await createRunToken({
            runId: await run(owner.id, actor.id),
            userId: kind === 'run' ? owner.id : null,
            timeoutMs: 60_000,
          });
    const toolsResponse = await post(token);
    expect(toolsResponse.status).toBe(200);
    const tools = await toolsResponse.json();
    expect(
      tools.result.tools.map((tool: { name: string }) => tool.name).sort(),
    ).toEqual([
      'integration_request',
      'list_integrations',
      'list_session_secrets',
      'prepare_session_secret',
    ]);
    const requestTool = tools.result.tools.find(
      (tool: { name: string }) => tool.name === 'integration_request',
    );
    expect(requestTool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(requestTool.inputSchema.properties).sort()).toEqual([
      'accept',
      'body',
      'contentType',
      'integrationId',
      'method',
      'path',
    ]);

    const listResponse = await post(token, 'tools/call', {
      name: 'list_integrations',
      arguments: {},
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json();
    expect(list.result.isError).not.toBe(true);
    expect(JSON.parse(list.result.content[0].text)).toEqual({
      integrations: [
        {
          id: 'example',
          description: config.integrations[0]!.description,
          origin: config.integrations[0]!.origin,
          rules: config.integrations[0]!.rules,
        },
      ],
    });
    for (const response of [tools, list]) {
      const serialized = JSON.stringify(response);
      for (const privateValue of [
        config.integrations[0]!.credential.header,
        config.integrations[0]!.credential.valueEnv,
        process.env.HTTP_TEST_AUTH_SECRET!,
        token,
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
    }
  },
);

it('rejects a correctly signed token for a deleted run', async () => {
  const actor = await member();
  const runId = await run(actor.id, actor.id);
  const token = await createRunToken({
    runId,
    userId: actor.id,
    timeoutMs: 60_000,
  });
  await db.delete(taskRuns).where(eq(taskRuns.id, runId));
  const response = await post(token);
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toMatchObject({
    error: { message: 'Task run not found for this MCP token' },
  });
});

it.each(['actorless', 'deleted-actor'] as const)(
  'rejects a previously valid run token after its live actor becomes %s',
  async (state) => {
    const owner = await member();
    const actor = await member();
    const runId = await run(owner.id, actor.id);
    const token = await createRunToken({
      runId,
      userId: owner.id,
      timeoutMs: 60_000,
    });
    expect((await post(token)).status).toBe(200);
    if (state === 'actorless') {
      await db
        .update(taskRuns)
        .set({ actingUserId: null })
        .where(eq(taskRuns.id, runId));
    } else {
      await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, actor.id));
    }
    const response = await post(token);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'HTTP integrations requires an active member actor' },
    });
  },
);

it.each(['unknown', 'deleted'] as const)(
  'rejects an auth token for a %s member',
  async (state) => {
    const actor = await member();
    const token = await createAuthToken({
      userId: state === 'unknown' ? randomUUID() : actor.id,
      timeoutMs: 60_000,
    });
    if (state === 'deleted')
      await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, actor.id));
    expect((await post(token)).status).toBe(401);
  },
);

it('rejects a real public MCP token for an active member at the route policy', async () => {
  const actor = await member();
  const token = await createMcpAccessToken({
    userId: actor.id,
    resource: 'http://localhost:3000/mcp',
    scopes: ['mcp:roomote'],
    timeoutMs: 60_000,
  });
  const response = await post(token);
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({
    error: { message: 'Forbidden: mcp_token_not_allowed' },
  });
});

it('rejects caller-supplied headers through the actual strict MCP request schema', async () => {
  const actor = await member();
  const token = await createAuthToken({ userId: actor.id, timeoutMs: 60_000 });
  const response = await post(token, 'tools/call', {
    name: 'integration_request',
    arguments: {
      integrationId: 'example',
      method: 'GET',
      path: '/items',
      headers: { Authorization: 'Bearer caller-controlled-secret' },
    },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0].text).toMatch(/unrecognized|unknown/i);
  expect(body.result.content[0].text).toContain('headers');
  expect(JSON.stringify(body)).not.toContain(
    process.env.HTTP_TEST_AUTH_SECRET!,
  );
});

it('filters discovery and rejects calls using the live actor, not the run token owner', async () => {
  const owner = await member();
  const allowed = await member();
  const other = await member();
  config.integrations[0]!.allowedUserIds = [allowed.id];
  app = createApp();
  const runId = await run(owner.id, allowed.id);
  const token = await createRunToken({
    runId,
    userId: owner.id,
    timeoutMs: 60_000,
  });
  const list = async () => {
    const result = await (
      await post(token, 'tools/call', {
        name: 'list_integrations',
        arguments: {},
      })
    ).json();
    return JSON.parse(result.result.content[0].text).integrations;
  };
  const call = async () =>
    (
      await post(token, 'tools/call', {
        name: 'integration_request',
        arguments: { integrationId: 'example', method: 'GET', path: '/items' },
      })
    ).json();
  expect(await list()).toHaveLength(1);
  expect((await call()).result.isError).not.toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  await db
    .update(taskRuns)
    .set({ actingUserId: other.id })
    .where(eq(taskRuns.id, runId));
  expect(await list()).toEqual([]);
  expect((await call()).result.isError).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  // Manifest changes only take effect when the endpoint is recreated.
  delete config.integrations[0]!.allowedUserIds;
  expect(await list()).toEqual([]);
  expect((await call()).result.isError).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  app = createApp();
  expect(await list()).toHaveLength(1);
  expect((await call()).result.isError).not.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('enforces allowlists for auth-token actors too', async () => {
  const actor = await member();
  config.integrations[0]!.allowedUserIds = [randomUUID()];
  app = createApp();
  const token = await createAuthToken({ userId: actor.id, timeoutMs: 60_000 });
  const list = await (
    await post(token, 'tools/call', {
      name: 'list_integrations',
      arguments: {},
    })
  ).json();
  expect(JSON.parse(list.result.content[0].text).integrations).toEqual([]);
  const call = await (
    await post(token, 'tools/call', {
      name: 'integration_request',
      arguments: { integrationId: 'example', method: 'GET', path: '/items' },
    })
  ).json();
  expect(call.result.isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

const sessionKey = 'test-only-session-key/A+b=123';
const sessionPolicy = {
  label: 'Session API key',
  origin: 'https://api.example.com',
  headerName: 'x-api-key' as const,
  headerPrefix: '' as const,
};

async function sessionGrant(
  existingOwner?: Awaited<ReturnType<typeof member>>,
) {
  const owner = existingOwner ?? (await member());
  const [fast] = await db
    .insert(fastAgentConversations)
    .values({
      userId: owner.id,
      surface: 'web',
      workspaceId: randomUUID(),
      conversationId: randomUUID(),
    })
    .returning();
  const session = await sessionFactory.create({
    ownerKind: 'user',
    ownerUserId: owner.id,
    fastConversationId: fast!.id,
  });
  sessionIds.push(session.id);
  const context = { userId: owner.id, sessionId: session.id };
  const pending = await prepareSessionSecret(context, sessionPolicy);
  const grant = await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret: sessionKey,
  });
  secretRefs.push(grant.secretRef);
  const runId = await run(owner.id, owner.id);
  const attached = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
  });
  await db.insert(sessionTasks).values({
    taskId: attached!.taskId,
    sessionId: session.id,
    origin: 'direct_launch',
  });
  return {
    owner,
    context,
    grant,
    runId,
    taskId: attached!.taskId,
    brokerToken: await createSessionBrokerToken({
      userId: owner.id,
      fastConversationId: fast!.id,
    }),
    runToken: await createRunToken({
      runId,
      userId: owner.id,
      timeoutMs: 60_000,
    }),
    authToken: await createAuthToken({ userId: owner.id, timeoutMs: 60_000 }),
  };
}

async function tool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await post(token, 'tools/call', { name, arguments: args });
  expect(response.status).toBe(200);
  return (await response.json()).result;
}

it.each(['broker', 'run'] as const)(
  'lists and calls real Session grants through signed %s auth, middleware and MCP',
  async (kind) => {
    // Neither a manifest nor per-service API environment credentials are required.
    enabled.value = false;
    vi.stubEnv('R_HTTP_INTEGRATIONS_CONFIG_PATH', undefined);
    vi.stubEnv('HTTP_TEST_AUTH_SECRET', undefined);
    const actual = await vi.importActual<typeof import('./broker')>('./broker');
    vi.mocked(loadHttpIntegrationsConfig)
      .mockReset()
      .mockImplementation(actual.loadHttpIntegrationsConfig);
    app = createApp();
    const fixture = await sessionGrant();
    const token = kind === 'broker' ? fixture.brokerToken : fixture.runToken;
    const toolsResponse = await post(token);
    expect(toolsResponse.status).toBe(200);
    const tools = await toolsResponse.json();
    expect(
      tools.result.tools.map((entry: { name: string }) => entry.name).sort(),
    ).toEqual([
      'integration_request',
      'list_integrations',
      'list_session_secrets',
      'prepare_session_secret',
    ]);
    const list = await tool(token, 'list_integrations');
    expect(JSON.parse(list.content[0].text)).toEqual({
      integrations: [
        {
          id: `session:${fixture.grant.secretRef}`,
          description: sessionPolicy.label,
          origin: sessionPolicy.origin,
          rules: [
            { method: 'GET', pathPrefix: '/' },
            { method: 'HEAD', pathPrefix: '/' },
          ],
          expiresAt: fixture.grant.expiresAt,
        },
      ],
    });
    const metadata = await tool(token, 'list_session_secrets');
    expect(JSON.parse(metadata.content[0].text)).toMatchObject({
      pending: [],
      secrets: [{ secretRef: fixture.grant.secretRef }],
    });
    const result = await tool(token, 'integration_request', {
      integrationId: `session:${fixture.grant.secretRef}`,
      method: 'GET',
      path: '/items',
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: 200,
      body: '{"ok":true}',
    });
    expect(vi.mocked(fetch).mock.lastCall![1]!.headers).toEqual({
      'x-api-key': sessionKey,
      accept: 'application/json',
      'accept-encoding': 'identity',
    });
    expect(JSON.stringify([tools, list, metadata, result])).not.toContain(
      sessionKey,
    );
    expect(vi.mocked(loadHttpIntegrationsConfig)).not.toHaveBeenCalled();
    expect(process.env.R_HTTP_INTEGRATIONS_CONFIG_PATH).toBeUndefined();
    expect(process.env.HTTP_TEST_AUTH_SECRET).toBeUndefined();
    expect(
      (
        await tool(token, 'integration_request', {
          integrationId: 'example',
          method: 'GET',
          path: '/items',
        })
      ).isError,
    ).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it('keeps broker authority separate from ordinary auth and restricts it to the exact API resource', async () => {
  const fixture = await sessionGrant();
  const scopedResponse = await post(fixture.brokerToken);
  expect(observedAuth.mock.lastCall![0]).toEqual({
    authContext: undefined,
    sessionBrokerAuth: {
      tokenType: 'session-broker',
      userId: fixture.owner.id,
      fastConversationId: expect.any(String),
    },
  });
  for (const route of [
    '/api/mcp/http-integrations/',
    '/api/mcp/http-integrations/other',
    '/api/mcp/github',
    '/api/mcp/roomote',
  ]) {
    const response = await post(
      fixture.brokerToken,
      'tools/list',
      undefined,
      route,
    );
    expect(response.status, route).toBe(401);
    expect(observedAuth.mock.lastCall![0]).toEqual({
      authContext: undefined,
      sessionBrokerAuth: undefined,
    });
  }
  expect((await post(fixture.authToken)).status).toBe(200);
  expect(observedAuth.mock.lastCall![0]).toEqual({
    authContext: { tokenType: 'auth', userId: fixture.owner.id, version: 1 },
    sessionBrokerAuth: undefined,
  });
  expect((await post(fixture.runToken)).status).toBe(200);
  expect(observedAuth.mock.lastCall![0]).toEqual({
    authContext: {
      tokenType: 'run',
      userId: fixture.owner.id,
      runId: fixture.runId,
      principal: 'user',
      version: 1,
    },
    sessionBrokerAuth: undefined,
  });
  expect(scopedResponse.status).toBe(200);
});

it.each(['broker', 'run'] as const)(
  'normalizes GET/HEAD wire bodies and rejects nonempty bodies through signed %s MCP calls',
  async (kind) => {
    const fixture = await sessionGrant();
    const token = kind === 'broker' ? fixture.brokerToken : fixture.runToken;
    for (const method of ['GET', 'HEAD']) {
      for (const fields of [
        {},
        { body: undefined },
        { body: null },
        { body: '' },
      ]) {
        vi.mocked(fetch).mockResolvedValueOnce(
          (method === 'HEAD'
            ? new Response(null)
            : Response.json({ ok: true })) as never,
        );
        const result = await tool(token, 'integration_request', {
          integrationId: `session:${fixture.grant.secretRef}`,
          method,
          path: '/items',
          ...fields,
          contentType: 'text/plain',
        });
        expect(result.isError).not.toBe(true);
        expect(vi.mocked(fetch).mock.lastCall![1]).not.toHaveProperty('body');
        expect(vi.mocked(fetch).mock.lastCall![1]!.headers).toEqual({
          'x-api-key': sessionKey,
          accept: 'application/json',
          'accept-encoding': 'identity',
        });
      }
      for (const body of [' ', '{}', 'null']) {
        expect(
          (
            await tool(token, 'integration_request', {
              integrationId: `session:${fixture.grant.secretRef}`,
              method,
              path: '/items',
              body,
            })
          ).isError,
        ).toBe(true);
      }
    }
    expect(fetch).toHaveBeenCalledTimes(8);
  },
);

it.each(['internal', 'public'] as const)(
  'denies %s user-only auth access to Session grants even with the owner identity and caller Session ID',
  async (kind) => {
    const fixture = await sessionGrant();
    if (kind === 'public')
      fixture.authToken = await createPublicAuthToken({
        userId: fixture.owner.id,
      });
    const list = await tool(fixture.authToken, 'list_integrations');
    expect(
      JSON.parse(list.content[0].text).integrations.map(
        (entry: { id: string }) => entry.id,
      ),
    ).toEqual(['example']);
    for (const name of ['list_session_secrets', 'prepare_session_secret']) {
      const result = await tool(
        fixture.authToken,
        name,
        name === 'prepare_session_secret' ? sessionPolicy : {},
      );
      expect(result.isError).toBe(true);
    }
    expect(
      (
        await tool(fixture.authToken, 'integration_request', {
          integrationId: `session:${fixture.grant.secretRef}`,
          method: 'GET',
          path: '/items',
        })
      ).isError,
    ).toBe(true);
    for (const token of [
      fixture.authToken,
      fixture.runToken,
      fixture.brokerToken,
    ]) {
      const result = await tool(token, 'integration_request', {
        integrationId: `session:${fixture.grant.secretRef}`,
        method: 'GET',
        path: '/items',
        sessionId: fixture.context.sessionId,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/unrecognized|unknown/i);
      expect(result.content[0].text).toContain('sessionId');
    }
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('denies a signed Fast token claiming the canonical Session UUID instead of its persisted conversation UUID', async () => {
  const fixture = await sessionGrant();
  const token = await createSessionBrokerToken({
    userId: fixture.owner.id,
    fastConversationId: fixture.context.sessionId,
  });
  const list = await tool(token, 'list_integrations');
  expect(
    JSON.parse(list.content[0].text).integrations.map(
      (entry: { id: string }) => entry.id,
    ),
  ).toEqual(['example']);
  expect((await tool(token, 'list_session_secrets')).isError).toBe(true);
  expect(
    (
      await tool(token, 'integration_request', {
        integrationId: `session:${fixture.grant.secretRef}`,
        method: 'GET',
        path: '/items',
      })
    ).isError,
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['broker', 'run'] as const)(
  'denies cross-selection between unrelated same-owner Sessions through signed %s MCP calls',
  async (kind) => {
    const a = await sessionGrant();
    const b = await sessionGrant(a.owner);
    for (const [current, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const token = kind === 'broker' ? current.brokerToken : current.runToken;
      const list = await tool(token, 'list_integrations');
      const ids = JSON.parse(list.content[0].text).integrations.map(
        (entry: { id: string }) => entry.id,
      );
      expect(ids).toContain(`session:${current.grant.secretRef}`);
      expect(ids).not.toContain(`session:${other.grant.secretRef}`);
      expect(
        (
          await tool(token, 'integration_request', {
            integrationId: `session:${other.grant.secretRef}`,
            method: 'GET',
            path: '/items',
          })
        ).isError,
      ).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(['before-call', 'in-flight'] as const)(
  're-resolves a signed run reattached from Session A to same-owner Session B (%s)',
  async (stage) => {
    const a = await sessionGrant();
    const b = await sessionGrant(a.owner);
    const args = {
      integrationId: `session:${a.grant.secretRef}`,
      method: 'GET',
      path: '/items',
    };
    const listIds = async () => {
      const result = await tool(a.runToken, 'list_integrations');
      return JSON.parse(result.content[0].text).integrations.map(
        (entry: { id: string }) => entry.id,
      );
    };
    expect(await listIds()).toContain(`session:${a.grant.secretRef}`);
    expect(
      (await tool(a.runToken, 'integration_request', args)).isError,
    ).not.toBe(true);
    vi.mocked(fetch).mockClear();
    const reattach = async () => {
      await db
        .update(sessionTasks)
        .set({ sessionId: b.context.sessionId })
        .where(eq(sessionTasks.taskId, a.taskId));
      expect(
        await db
          .select({ sessionId: sessionTasks.sessionId })
          .from(sessionTasks)
          .where(eq(sessionTasks.taskId, a.taskId)),
      ).toEqual([{ sessionId: b.context.sessionId }]);
    };
    if (stage === 'before-call') await reattach();
    else
      vi.mocked(fetch).mockImplementationOnce(async () => {
        await reattach();
        return Response.json({
          private: 'original-A-result-must-not-escape',
        }) as never;
      });
    const result = await tool(a.runToken, 'integration_request', args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(
      'original-A-result-must-not-escape',
    );
    expect(fetch).toHaveBeenCalledTimes(stage === 'in-flight' ? 1 : 0);
    expect(await listIds()).toEqual([
      'example',
      `session:${b.grant.secretRef}`,
    ]);
    expect((await tool(a.runToken, 'integration_request', args)).isError).toBe(
      true,
    );
    expect(fetch).toHaveBeenCalledTimes(stage === 'in-flight' ? 1 : 0);
    const metadata = await tool(a.runToken, 'list_session_secrets');
    expect(
      JSON.parse(metadata.content[0].text).secrets.map(
        (entry: { secretRef: string }) => entry.secretRef,
      ),
    ).toEqual([b.grant.secretRef]);
    expect(
      (
        await tool(a.runToken, 'integration_request', {
          ...args,
          integrationId: `session:${b.grant.secretRef}`,
        })
      ).isError,
    ).not.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(stage === 'in-flight' ? 2 : 1);
  },
);

it.each(['broker', 'run'] as const)(
  'reads fresh approvals and grants for %s while keeping operator configuration snapshotted',
  async (kind) => {
    const fixture = await sessionGrant();
    const token = kind === 'broker' ? fixture.brokerToken : fixture.runToken;
    expect(loadHttpIntegrationsConfig).toHaveBeenCalledOnce();
    const listIds = async () => {
      const result = await tool(token, 'list_integrations');
      return JSON.parse(result.content[0].text).integrations.map(
        (entry: { id: string }) => entry.id,
      );
    };
    expect(await listIds()).toEqual([
      'example',
      `session:${fixture.grant.secretRef}`,
    ]);
    vi.mocked(loadHttpIntegrationsConfig).mockReturnValue({ integrations: [] });
    const prepared = await tool(token, 'prepare_session_secret', {
      ...sessionPolicy,
      label: 'Second API key',
    });
    expect(prepared.isError).not.toBe(true);
    const { pending, sessionUrl } = JSON.parse(prepared.content[0].text);
    expect(sessionUrl).toContain(
      `/sessions/${fixture.context.sessionId}#session-secrets`,
    );
    expect(
      JSON.parse((await tool(token, 'list_session_secrets')).content[0].text)
        .pending,
    ).toEqual([pending]);
    const second = await createSessionSecret(fixture.context, {
      pendingRef: pending.pendingRef,
      secret: sessionKey,
    });
    secretRefs.push(second.secretRef);
    expect(await listIds()).toEqual(
      expect.arrayContaining([
        'example',
        `session:${fixture.grant.secretRef}`,
        `session:${second.secretRef}`,
      ]),
    );
    await revokeSessionSecret(fixture.context, {
      secretRef: fixture.grant.secretRef,
    });
    expect(await listIds()).toEqual(['example', `session:${second.secretRef}`]);
    expect(
      (
        await tool(token, 'integration_request', {
          integrationId: `session:${fixture.grant.secretRef}`,
          method: 'GET',
          path: '/',
        })
      ).isError,
    ).toBe(true);
    await db.execute(
      sql`update session_secrets set expires_at = clock_timestamp() - interval '1 second' where id = ${second.secretRef}`,
    );
    expect(await listIds()).toEqual(['example']);
    expect(
      (
        await tool(token, 'integration_request', {
          integrationId: `session:${second.secretRef}`,
          method: 'GET',
          path: '/',
        })
      ).isError,
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(loadHttpIntegrationsConfig).toHaveBeenCalledOnce();
  },
);

it.each(['collaborator', 'deployment'] as const)(
  'does not grant owner secrets to a %s token for the same run',
  async (kind) => {
    const fixture = await sessionGrant();
    const collaborator = await member();
    const token = await createRunToken({
      runId: fixture.runId,
      userId: kind === 'collaborator' ? collaborator.id : null,
      timeoutMs: 60_000,
    });
    const list = await tool(token, 'list_integrations');
    expect(
      JSON.parse(list.content[0].text).integrations.map(
        (entry: { id: string }) => entry.id,
      ),
    ).toEqual(['example']);
    expect((await tool(token, 'list_session_secrets')).isError).toBe(true);
    expect(
      (await tool(token, 'prepare_session_secret', sessionPolicy)).isError,
    ).toBe(true);
    expect(
      (
        await tool(token, 'integration_request', {
          integrationId: `session:${fixture.grant.secretRef}`,
          method: 'GET',
          path: '/items',
        })
      ).isError,
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const ownerList = await tool(fixture.runToken, 'list_integrations');
    expect(
      JSON.parse(ownerList.content[0].text).integrations.map(
        (entry: { id: string }) => entry.id,
      ),
    ).toContain(`session:${fixture.grant.secretRef}`);
  },
);

it('denies a still-valid signed run token after its live bound actor drifts', async () => {
  const fixture = await sessionGrant();
  const requestArgs = {
    integrationId: `session:${fixture.grant.secretRef}`,
    method: 'GET',
    path: '/items',
  };
  expect(
    (await tool(fixture.runToken, 'integration_request', requestArgs)).isError,
  ).not.toBe(true);
  const other = await member();
  await db
    .update(taskRuns)
    .set({ actingUserId: other.id })
    .where(eq(taskRuns.id, fixture.runId));
  const list = await tool(fixture.runToken, 'list_integrations');
  expect(
    JSON.parse(list.content[0].text).integrations.map(
      (entry: { id: string }) => entry.id,
    ),
  ).toEqual(['example']);
  expect((await tool(fixture.runToken, 'list_session_secrets')).isError).toBe(
    true,
  );
  expect(
    (await tool(fixture.runToken, 'integration_request', requestArgs)).isError,
  ).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
});
