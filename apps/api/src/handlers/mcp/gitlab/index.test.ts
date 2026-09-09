import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  db,
  eq,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '@roomote/db/server';
import { ToolSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Variables } from '../../../types';
import { compatible, createGitlabMcp, schemas } from './index';
import fixture from './pinned-catalog.fixture.json';
import { mcpRouting } from '../routing';

const mocks = vi.hoisted(() => ({
  env: {
    GITLAB_MCP_SERVER_URL: 'https://mcp.example/mcp' as string | undefined,
    R_CURATED_INTEGRATIONS_DISABLED: false,
  },
  token: vi.fn(),
  connection: vi.fn(),
}));
vi.mock('../github', () => ({ createGithubMcp: () => new Hono() }));
vi.mock('../linear', () => ({ createLinearMcp: () => new Hono() }));
vi.mock('../roomote', () => ({ roomoteMcp: new Hono() }));
vi.mock('@roomote/env', async (original) => ({
  ...(await original<object>()),
  Env: mocks.env,
}));
vi.mock('@roomote/gitlab', async (original) => ({
  ...(await original<object>()),
  resolveGitLabBaseUrl: async () => 'https://gitlab.example',
  getGitLabOAuthConnection: mocks.connection,
  resolveGitLabOAuthAccessToken: mocks.token,
}));

const pinnedTools = fixture.tools.map((tool) => ToolSchema.parse(tool));

let userId: string;
let repositoryId: string;
let fullName: string;
let externalId: string;
let catalog: Tool[];
let upstreamVersion: string;
let mrObject: Record<string, unknown>;
let discussion: Record<string, unknown>;
let toolResult: Record<string, unknown>;
let fileResponse: () => Response;
let traffic: {
  url: string;
  init?: RequestInit;
  rpc?: Record<string, unknown>;
}[];

function app(
  auth: Variables['authContext'] = { tokenType: 'auth', userId, version: 1 },
) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('authContext', auth);
    await next();
  });
  app.route('/gitlab', createGitlabMcp());
  return app;
}
function request(
  method = 'tools/list',
  params: unknown = {},
  auth?: Variables['authContext'],
) {
  return app(auth).request('/gitlab', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-session-id': 'attacker-session',
      'X-GitLab-API-URL': 'https://attacker.invalid',
      Authorization: 'Bearer inbound-secret',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
function call(name = 'get_merge_request', args: Record<string, unknown> = {}) {
  return request('tools/call', {
    name,
    arguments: { project_id: fullName, merge_request_iid: '7', ...args },
  });
}
beforeEach(async () => {
  const user = await userFactory.create({ role: 'member' });
  userId = user.id;
  externalId = String(Math.floor(Math.random() * 1e12) + 1);
  fullName = `group/repo-${randomUUID()}`;
  const repo = await repositoryFactory.create({
    linkedByUserId: userId,
    sourceControlProvider: 'gitlab',
    host: 'gitlab.example',
    externalRepoId: externalId,
    fullName,
  });
  repositoryId = repo.id;
  catalog = structuredClone(pinnedTools);
  upstreamVersion = fixture.version;
  mrObject = { id: 70, iid: 7, project_id: Number(externalId) };
  discussion = {
    id: 'thread',
    notes: [
      { noteable_id: 70, noteable_iid: 7, noteable_type: 'MergeRequest' },
    ],
  };
  toolResult = { content: [{ type: 'text', text: 'result' }] };
  fileResponse = () => new Response('first\nsecond\nthird\n');
  traffic = [];
  mocks.env.GITLAB_MCP_SERVER_URL = 'https://mcp.example/mcp';
  mocks.env.R_CURATED_INTEGRATIONS_DISABLED = false;
  mocks.token.mockReset().mockResolvedValue('refreshed-oauth-token');
  mocks.connection.mockReset().mockResolvedValue({
    baseUrl: 'https://gitlab.example',
    status: 'active',
    scopes: ['api'],
  });
  let session = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const rpc = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      traffic.push({ url, init, rpc });
      if (url.includes('/repository/files/')) return fileResponse();
      if (url.startsWith('https://gitlab.example/api/v4/'))
        return Response.json(
          url.includes('/discussions/') ? discussion : mrObject,
        );
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      if (!rpc?.id && rpc?.id !== 0) return new Response(null, { status: 202 });
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'gitlab-mcp', version: upstreamVersion },
            }
          : rpc.method === 'tools/list'
            ? { tools: catalog }
            : toolResult;
      return Response.json(
        { jsonrpc: '2.0', id: rpc.id, result },
        {
          headers:
            rpc.method === 'initialize'
              ? { 'mcp-session-id': `fresh-${++session}` }
              : {},
        },
      );
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete(repositories).where(eq(repositories.id, repositoryId));
  await db.delete(users).where(eq(users.id, userId));
});

describe.each(['/gitlab', '/gitlab/'])('mounted routing %s', (path) => {
  it.each(['tools/list', 'tools/call'])(
    'blocks direct %s before credentials or upstream when curated integrations are disabled',
    async (method) => {
      const mounted = new Hono<{ Variables: Variables }>();
      mounted.use('*', async (c, next) => {
        c.set('authContext', { tokenType: 'auth', userId, version: 1 });
        await next();
      });
      mounted.route('/api/mcp-routing', mcpRouting);
      const send = (requestPath = path) =>
        mounted.request(`/api/mcp-routing${requestPath}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params:
              method === 'tools/list'
                ? {}
                : {
                    name: 'create_merge_request_note',
                    arguments: {
                      project_id: fullName,
                      merge_request_iid: '7',
                      body: 'hello',
                    },
                  },
          }),
        });

      mocks.env.R_CURATED_INTEGRATIONS_DISABLED = true;
      expect((await send()).status).toBe(404);
      expect(mocks.connection).not.toHaveBeenCalled();
      expect(mocks.token).not.toHaveBeenCalled();
      expect(traffic).toEqual([]);

      mocks.env.R_CURATED_INTEGRATIONS_DISABLED = false;
      // Hono's strict routing only mounts the handler at the bare path.
      expect((await send('/gitlab')).status).toBe(200);
      expect(mocks.connection).toHaveBeenCalledOnce();
      expect(mocks.token).toHaveBeenCalledOnce();
      expect(traffic.some((item) => item.rpc?.method === method)).toBe(true);
    },
  );
});

it('advertises only compatible pinned schemas with strict bounded inputs', async () => {
  catalog.push({ name: 'delete_project', inputSchema: { type: 'object' } });
  const response = await request();
  expect(response.status).toBe(200);
  const { result } = await response.json();
  expect(result.tools.map((tool: Tool) => tool.name).sort()).toEqual(
    Object.keys(schemas).sort(),
  );
  for (const tool of result.tools)
    expect(tool.inputSchema.additionalProperties).toBe(false);
  expect(
    result.tools.find((tool: Tool) => tool.name === 'update_merge_request')
      .inputSchema.properties,
  ).not.toHaveProperty('target_branch');
  expect(
    result.tools.find((tool: Tool) => tool.name === 'mr_discussions')
      .inputSchema.properties.per_page.maximum,
  ).toBe(50);
  expect(
    result.tools.some((tool: Tool) => tool.name === 'get_file_contents'),
  ).toBe(true);
  expect(traffic.filter((item) => item.init?.method === 'DELETE')).toHaveLength(
    1,
  );
});

it('rechecks a live actor and rejects deleted, unknown, run and service actors', async () => {
  expect((await request('initialize')).status).toBe(200);
  await db
    .update(users)
    .set({ deletedAt: new Date() })
    .where(eq(users.id, userId));
  const actors: Variables['authContext'][] = [
    { tokenType: 'auth', userId, version: 1 },
    { tokenType: 'auth', userId: randomUUID(), version: 1 },
    { tokenType: 'run', userId, runId: 123, principal: 'user', version: 1 },
    {
      tokenType: 'run',
      userId: null,
      runId: 123,
      principal: 'deployment',
      version: 1,
    },
  ];
  for (const actor of actors)
    expect((await request('tools/list', {}, actor)).status).toBe(403);
  expect(traffic).toEqual([]);
});

it.each([
  { isActive: false },
  { host: 'other.example' },
  { sourceControlProvider: 'gitea' as const },
])(
  'rejects repositories outside the active configured provider/host: %j',
  async (change) => {
    await db
      .update(repositories)
      .set(change)
      .where(eq(repositories.id, repositoryId));
    expect((await call()).status).toBe(400);
    expect(traffic).toEqual([]);
  },
);

it.each([
  ['delete_project', {}],
  ['get_file_contents', {}],
  ['update_merge_request', { target_branch: 'main' }],
  ['update_merge_request', { state_event: 'merge' }],
  ['update_merge_request', {}],
  ['get_merge_request', { project_id: 'https://attacker.invalid/group/repo' }],
  ['get_merge_request', { project_id: 0 }],
  ['get_merge_request', { merge_request_iid: '-1' }],
  ['mr_discussions', { page: 1001 }],
  ['mr_discussions', { per_page: 51 }],
  [
    'create_merge_request_discussion_note',
    { body: 'hello', discussion_id: '../other' },
  ],
  [
    'create_merge_request_note',
    { body: 'hello', headers: { Authorization: 'evil' } },
  ],
] as const)(
  'rejects forbidden %s arguments %j before provider access',
  async (name, args) => {
    expect((await call(name, args)).status).toBe(400);
    expect(traffic).toEqual([]);
  },
);

it('uses freshly resolved OAuth and isolated SDK sessions, never inbound headers or RPC metadata', async () => {
  mocks.token
    .mockResolvedValueOnce('rotated-one')
    .mockResolvedValueOnce('rotated-two');
  expect((await call()).status).toBe(200);
  const firstTraffic = traffic.splice(0);
  expect(
    (await call('get_merge_request', { project_id: Number(externalId) }))
      .status,
  ).toBe(200);
  for (const [requests, token] of [
    [firstTraffic, 'rotated-one'],
    [traffic, 'rotated-two'],
  ] as const) {
    const initialize = requests.find(
      (item) => item.rpc?.method === 'initialize',
    )!;
    expect(new Headers(initialize.init?.headers).has('mcp-session-id')).toBe(
      false,
    );
    for (const item of requests) {
      const headers = new Headers(item.init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${token}`);
      expect(headers.get('x-gitlab-api-url')).toBe(
        'https://gitlab.example/api/v4',
      );
      expect(headers.get('x-gitlab-allowed-project-ids')).toBe(externalId);
      expect(headers.get('mcp-session-id')).not.toBe('attacker-session');
    }
    expect(
      requests.find((item) => item.rpc?.method === 'tools/call')?.rpc?.params,
    ).toEqual({
      name: 'get_merge_request',
      arguments: { project_id: externalId, merge_request_iid: '7' },
    });
    expect(requests.some((item) => item.init?.method === 'DELETE')).toBe(true);
  }
  expect(
    (
      await request('tools/call', {
        name: 'get_merge_request',
        arguments: { project_id: externalId, merge_request_iid: '7' },
        _meta: { secret: 'no' },
      })
    ).status,
  ).toBe(400);
  expect(mocks.token).toHaveBeenCalledTimes(2);
});

it.each(['project', 'iid', 'noteable', 'discussion'])(
  'verifies nested MR/discussion identity before writes: %s mismatch',
  async (mismatch) => {
    if (mismatch === 'project') mrObject.project_id = 1;
    if (mismatch === 'iid') mrObject.iid = 99;
    if (mismatch === 'discussion') discussion.id = 'other';
    if (mismatch === 'noteable')
      discussion.notes = [
        { noteable_id: 999, noteable_iid: 7, noteable_type: 'MergeRequest' },
      ];
    expect(
      (
        await call('create_merge_request_discussion_note', {
          discussion_id: 'thread',
          body: 'hello',
        })
      ).status,
    ).toBe(400);
    expect(
      traffic.every((item) =>
        item.url.startsWith(
          `https://gitlab.example/api/v4/projects/${externalId}/merge_requests/7`,
        ),
      ),
    ).toBe(true);
    expect(traffic.some((item) => item.rpc?.method === 'tools/call')).toBe(
      false,
    );
  },
);

it.each([
  'update_merge_request',
  'create_merge_request_note',
  'create_merge_request_discussion_note',
])(
  'allows a bounded %s only after canonical ownership checks',
  async (name) => {
    const args =
      name === 'update_merge_request'
        ? { title: 'new', description: '', state_event: 'reopen' }
        : {
            body: 'hello',
            ...(name.includes('discussion') ? { discussion_id: 'thread' } : {}),
          };
    expect((await call(name, args)).status).toBe(200);
    expect(traffic[0]?.url).toBe(
      `https://gitlab.example/api/v4/projects/${externalId}/merge_requests/7`,
    );
    expect(
      traffic.find((item) => item.rpc?.method === 'tools/call')?.rpc?.params,
    ).toMatchObject({ name, arguments: args });
  },
);

it('fails closed on missing, changed, or incompatible capabilities', async () => {
  catalog = [];
  expect((await call()).status).toBe(400);
  catalog = structuredClone(pinnedTools);
  upstreamVersion = '2.1.61';
  expect((await call()).status).toBe(400);
  const tool = structuredClone(pinnedTools[0]!);
  tool.inputSchema.required = ['project_id', 'unexpected'];
  expect(compatible(tool)).toBe(false);
  tool.inputSchema.required = ['project_id'];
  tool.inputSchema.properties!.project_id = { type: 'number' };
  expect(compatible(tool)).toBe(false);
  expect(traffic.some((item) => item.rpc?.method === 'tools/call')).toBe(false);
});

it('has no capabilities for unsupported RPC methods and no upstream when disabled', async () => {
  const initialized = await (await request('initialize')).json();
  expect(initialized.result.capabilities).toEqual({ tools: {} });
  expect((await request('resources/list')).status).toBe(400);
  mocks.env.GITLAB_MCP_SERVER_URL = undefined;
  expect((await request()).status).toBe(404);
  expect(traffic).toEqual([]);
});

it('rejects unauthenticated callers and disconnected or wrong-host OAuth before credential resolution', async () => {
  const unauthenticated = new Hono<{ Variables: Variables }>();
  unauthenticated.route('/gitlab', createGitlabMcp());
  expect(
    (await unauthenticated.request('/gitlab', { method: 'POST', body: '{}' }))
      .status,
  ).toBe(403);
  for (const connection of [
    null,
    { baseUrl: 'https://other.example', status: 'active', scopes: ['api'] },
    {
      baseUrl: 'https://gitlab.example',
      status: 'reauthorization_required',
      scopes: ['api'],
    },
  ]) {
    mocks.connection.mockResolvedValue(connection);
    expect((await call()).status).toBe(400);
  }
  expect(mocks.token).not.toHaveBeenCalled();
  expect(traffic).toEqual([]);
});

it('bounds upstream stalls without exposing provider errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('upstream timeout secret')),
            { once: true },
          );
        }),
    ),
  );
  const response = await call();
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('timeout secret');
}, 30000);

it('enforces request and response bounds and suppresses upstream errors/secrets', async () => {
  expect(
    (await call('create_merge_request_note', { body: 'x'.repeat(70000) }))
      .status,
  ).toBe(413);
  toolResult = {
    content: [{ type: 'text', text: 'refreshed-oauth-token' }],
    isError: true,
  };
  const response = await call();
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('refreshed-oauth-token');
  toolResult = { content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] };
  expect((await call()).status).toBe(400);
  expect(traffic.every((item) => item.init?.redirect === 'error')).toBe(true);
});

const commit = 'a'.repeat(40);
function readFile(args: Record<string, unknown> = {}) {
  return request('tools/call', {
    name: 'get_file_contents',
    arguments: {
      project_id: fullName,
      file_path: 'src/example.ts',
      ref: commit,
      ...args,
    },
  });
}

it('accepts every exact generated pinned input schema and rejects confirmation-gated tools', async () => {
  expect(fixture.commit).toBe('bd9be9bde20b3254b2d4b59dc203a19a5d52e5d5');
  expect(pinnedTools).toHaveLength(12);
  for (const tool of pinnedTools) {
    expect(compatible(tool), tool.name).toBe(true);
    expect(
      compatible({
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...tool.inputSchema.properties,
            _confirmed: { type: 'boolean' },
          },
        },
      }),
    ).toBe(false);
  }
  catalog = catalog.map((tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        _confirmed: { type: 'boolean' },
      },
    },
  }));
  expect((await (await request()).json()).result.tools).toEqual([]);
  expect((await readFile()).status).toBe(400);
  expect(traffic.some((item) => item.url.includes('/repository/files/'))).toBe(
    false,
  );
});

it('continues bounded tree keyset pagination without following caller URLs', async () => {
  toolResult = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ items: [], next_page_token: 'eyJpZCI6MX0=' }),
      },
    ],
  };
  const params = { project_id: fullName, per_page: 25, path: 'src' };
  const response = await request('tools/call', {
    name: 'get_repository_tree',
    arguments: params,
  });
  expect(response.status).toBe(200);
  expect(
    JSON.parse((await response.json()).result.content[0].text).next_page_token,
  ).toBe('eyJpZCI6MX0=');
  expect(
    (
      await request('tools/call', {
        name: 'get_repository_tree',
        arguments: {
          ...params,
          pagination: 'keyset',
          page_token: 'eyJpZCI6MX0=',
        },
      })
    ).status,
  ).toBe(200);
  const calls = traffic.filter((item) => item.rpc?.method === 'tools/call');
  expect(calls[0]?.rpc?.params).toEqual({
    name: 'get_repository_tree',
    arguments: { ...params, project_id: externalId, pagination: 'keyset' },
  });
  expect(calls[1]?.rpc?.params).toMatchObject({
    arguments: {
      page_token: 'eyJpZCI6MX0=',
      pagination: 'keyset',
      per_page: 25,
    },
  });
  for (const extra of [
    { pagination: 'offset' },
    { page_token: 'x'.repeat(4097) },
    { page_token: 'https://evil.invalid' },
  ]) {
    expect(
      (
        await request('tools/call', {
          name: 'get_repository_tree',
          arguments: { ...params, ...extra },
        })
      ).status,
    ).toBe(400);
  }
  expect(
    traffic.filter((item) => item.rpc?.method === 'tools/call'),
  ).toHaveLength(2);
});

it('uses the bounded raw REST fallback with immutable SHA and canonical project, never whole-file MCP', async () => {
  const response = await readFile({
    file_path: 'src/file name.ts',
    offset: 1,
    limit: 1,
  });
  expect(response.status).toBe(200);
  expect(JSON.parse((await response.json()).result.content[0].text)).toEqual({
    project_id: externalId,
    file_path: 'src/file name.ts',
    ref: commit,
    size_bytes: 19,
    total_lines: 3,
    offset: 1,
    lines_returned: 1,
    next_offset: 2,
    truncated: true,
    content: 'second\n',
  });
  const raw = traffic.find((item) => item.url.includes('/repository/files/'))!;
  expect(raw.url).toBe(
    `https://gitlab.example/api/v4/projects/${externalId}/repository/files/src%2Ffile%20name.ts/raw?ref=${commit}&lfs=false`,
  );
  expect(new Headers(raw.init?.headers).get('authorization')).toBe(
    'Bearer refreshed-oauth-token',
  );
  expect(new Headers(raw.init?.headers).has('private-token')).toBe(false);
  expect(raw.init?.redirect).toBe('error');
  expect(traffic.some((item) => item.rpc?.method === 'tools/call')).toBe(false);
  expect(traffic.some((item) => item.init?.method === 'DELETE')).toBe(true);
});

it.each([
  { ref: 'main' },
  { ref: '123abc' },
  { ref: undefined },
  { file_path: '../secret' },
  { file_path: '/absolute' },
  { file_path: 'file\0name' },
  { file_path: 'https://evil.invalid/file' },
  { offset: -1 },
  { offset: 1000001 },
  { limit: 2001 },
  { limit: 0 },
  { url: 'https://evil.invalid' },
  { headers: {} },
])('rejects unsafe or unbounded file arguments %j', async (args) => {
  expect((await readFile(args)).status).toBe(400);
  expect(traffic).toEqual([]);
});

it('returns explicit default line truncation and preserves original newline bytes', async () => {
  fileResponse = () => new Response('line\r\n'.repeat(2001));
  const first = await readFile();
  expect(first.status).toBe(200);
  const payload = JSON.parse((await first.json()).result.content[0].text);
  expect(payload).toMatchObject({
    lines_returned: 2000,
    total_lines: 2001,
    next_offset: 2000,
    truncated: true,
    content: 'line\r\n'.repeat(2000),
  });
  const last = JSON.parse(
    (await (await readFile({ offset: payload.next_offset })).json()).result
      .content[0].text,
  );
  expect(last).toMatchObject({
    lines_returned: 1,
    next_offset: null,
    content: 'line\r\n',
    ref: commit,
  });
});

it.each(['', 'without final newline', '\ufeffwith BOM\n'])(
  'preserves a complete bounded text file: %j',
  async (content) => {
    fileResponse = () => new Response(content);
    const response = await readFile();
    expect(response.status).toBe(200);
    expect(
      JSON.parse((await response.json()).result.content[0].text),
    ).toMatchObject({
      content,
      size_bytes: Buffer.byteLength(content),
      truncated: false,
      next_offset: null,
    });
  },
);

it('rejects oversized streamed files even for one line, cancels the stream, and returns no partial content', async () => {
  let cancelled = false;
  let pulled = 0;
  fileResponse = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(65536).fill(97));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const response = await readFile({ limit: 1 });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('1 MiB');
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThan(22);
});

it('refuses declared oversized files before body download and counts UTF-8 bytes', async () => {
  const cancel = vi.fn();
  fileResponse = () =>
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': String(1024 * 1024 + 1) },
    });
  expect((await readFile()).status).toBe(400);
  expect(cancel).toHaveBeenCalled();
  fileResponse = () => new Response('é'.repeat(524289));
  expect((await readFile({ limit: 1 })).status).toBe(400);
  fileResponse = () => new Response('a\n'.repeat(524288));
  expect((await readFile({ limit: 1 })).status).toBe(200);
});

it.each([new Uint8Array([0xff, 0xfe]), new Uint8Array([65, 0, 66])])(
  'rejects invalid UTF-8 or binary files instead of decoding lossy content',
  async (bytes) => {
    fileResponse = () => new Response(bytes);
    const response = await readFile();
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain(
      'No file content was returned',
    );
  },
);

it('rejects file access after repository deactivation or upstream capability removal', async () => {
  catalog = catalog.filter((tool) => tool.name !== 'get_file_contents');
  expect((await readFile()).status).toBe(400);
  expect(traffic.some((item) => item.url.includes('/repository/files/'))).toBe(
    false,
  );
  traffic = [];
  await db
    .update(repositories)
    .set({ isActive: false })
    .where(eq(repositories.id, repositoryId));
  expect((await readFile()).status).toBe(400);
  expect(traffic).toEqual([]);
});
