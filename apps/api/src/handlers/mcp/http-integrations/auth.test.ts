import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  configureAuthClientEnv,
  createAuthToken,
  createMcpAccessToken,
  createRunToken,
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
} from '@roomote/db/server';
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

vi.mock('./broker', async (importOriginal) => {
  const original = await importOriginal<typeof import('./broker')>();
  return {
    ...original,
    integrationRequest: vi.fn(original.integrationRequest),
    loadHttpIntegrationsConfig: vi.fn(),
  };
});
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
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
const path = '/api/mcp/http-integrations';
let app: Hono<{ Variables: Variables }>;

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
  vi.mocked(integrationRequest).mockClear();
  vi.mocked(loadHttpIntegrationsConfig).mockReturnValue(config);
  vi.mocked(fetch)
    .mockReset()
    .mockImplementation(async () => Response.json({ ok: true }) as never);
  vi.stubEnv(
    'HTTP_TEST_AUTH_SECRET',
    'test-only-credential-must-never-be-returned',
  );
  app = new Hono<{ Variables: Variables }>();
  app.use('*', tokenAuthMiddleware());
  app.use('*', routePolicyMiddleware);
  app.route(path, createHttpIntegrationsMcp());
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete config.integrations[0]!.allowedUserIds;
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
    ).toEqual(['integration_request', 'list_integrations']);
    const requestTool = tools.result.tools.find(
      (tool: { name: string }) => tool.name === 'integration_request',
    );
    expect(requestTool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(requestTool.inputSchema.properties).sort()).toEqual([
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
  // Removing the list shares the integration with all active human actors.
  delete config.integrations[0]!.allowedUserIds;
  expect(await list()).toHaveLength(1);
  expect((await call()).result.isError).not.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('enforces allowlists for auth-token actors too', async () => {
  const actor = await member();
  config.integrations[0]!.allowedUserIds = [randomUUID()];
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
