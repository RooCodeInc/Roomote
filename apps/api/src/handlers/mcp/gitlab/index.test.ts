import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  db,
  deploymentSecrets,
  eq,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '@roomote/db/server';
import { encryptJSON } from '@roomote/db/encryption';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GitLabOAuthConnection } from '@roomote/gitlab';
import type { Variables } from '../../../types';
import { createGitlabMcp, schemas } from './index';
import { mcpRouting } from '../routing';

const mocks = vi.hoisted(() => ({
  env: { R_CURATED_INTEGRATIONS_DISABLED: false },
  baseUrl: 'https://gitlab.example',
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
  resolveGitLabBaseUrl: async () => mocks.baseUrl,
  getGitLabOAuthConnection: mocks.connection,
  resolveGitLabOAuthAccessToken: mocks.token,
}));
const gitlab =
  await vi.importActual<typeof import('@roomote/gitlab')>('@roomote/gitlab');
const secretName = 'gitlab_deployment_oauth_connection';
let previousSecret: string | null | undefined;
let connection: GitLabOAuthConnection;
let userId: string;
let repositoryId: string;
let fullName: string;
let externalId: string;
let mrObject: Record<string, unknown>;
let discussion: Record<string, unknown>;
let fileResponse: () => Response;
let providerResponse: ((url: URL, init?: RequestInit) => Response) | undefined;
let traffic: { url: string; init?: RequestInit }[];

async function saveConnection(changes: Partial<GitLabOAuthConnection> = {}) {
  connection = { ...connection, ...changes };
  await db
    .insert(deploymentSecrets)
    .values({ name: secretName, value: encryptJSON(connection) })
    .onConflictDoUpdate({
      target: deploymentSecrets.name,
      set: { value: encryptJSON(connection) },
    });
}
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
    arguments: { project_id: fullName, ...args },
  });
}
function mrCall(
  name = 'get_merge_request',
  args: Record<string, unknown> = {},
) {
  return call(name, { merge_request_iid: '7', ...args });
}
const commit = 'a'.repeat(40);
function readFile(args: Record<string, unknown> = {}) {
  return call('get_file_contents', {
    file_path: 'src/example.ts',
    ref: commit,
    ...args,
  });
}
async function payload(response: Response) {
  expect(response.status).toBe(200);
  return JSON.parse((await response.json()).result.content[0].text);
}
beforeEach(async () => {
  previousSecret = (
    await db.query.deploymentSecrets.findFirst({
      where: eq(deploymentSecrets.name, secretName),
    })
  )?.value;
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
  mrObject = {
    id: 70,
    iid: 7,
    project_id: Number(externalId),
    title: 'A merge request',
    state: 'opened',
  };
  discussion = {
    id: 'thread',
    notes: [
      { noteable_id: 70, noteable_iid: 7, noteable_type: 'MergeRequest' },
    ],
  };
  fileResponse = () => new Response('first\nsecond\nthird\n');
  providerResponse = undefined;
  traffic = [];
  mocks.baseUrl = 'https://gitlab.example';
  mocks.env.R_CURATED_INTEGRATIONS_DISABLED = false;
  mocks.token
    .mockReset()
    .mockImplementation(gitlab.resolveGitLabOAuthAccessToken);
  mocks.connection
    .mockReset()
    .mockImplementation(gitlab.getGitLabOAuthConnection);
  connection = {
    baseUrl: mocks.baseUrl,
    status: 'active',
    scopes: ['api'],
    clientId: 'client-id',
    clientSecret: 'client-secret',
    accountId: '42',
    username: 'bot',
    accessToken: 'refreshed-oauth-token',
    refreshToken: 'refresh-secret',
    expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
  };
  await saveConnection();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      traffic.push({ url: url.toString(), init });
      if (providerResponse) return providerResponse(url, init);
      if (url.pathname.includes('/repository/files/')) return fileResponse();
      if (init?.method === 'POST')
        return Response.json({ id: 90 }, { status: 201 });
      if (url.pathname.endsWith('/discussions/thread'))
        return Response.json(discussion);
      if (/\/(tree|search|commits|diffs|notes|discussions)$/.test(url.pathname))
        return Response.json([]);
      if (url.pathname.includes('/repository/commits/'))
        return Response.json({ id: commit });
      return Response.json(mrObject);
    }),
  );
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await db.delete(repositories).where(eq(repositories.id, repositoryId));
  await db.delete(users).where(eq(users.id, userId));
  if (previousSecret !== undefined) {
    await db
      .update(deploymentSecrets)
      .set({ value: previousSecret })
      .where(eq(deploymentSecrets.name, secretName));
  } else
    await db
      .delete(deploymentSecrets)
      .where(eq(deploymentSecrets.name, secretName));
});

describe.each(['/gitlab', '/gitlab/'])('mounted routing %s', (path) => {
  it.each(['tools/list', 'tools/call'])(
    'blocks direct %s while curated integrations are disabled',
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
      expect((await send('/gitlab')).status).toBe(200);
      expect(traffic).toHaveLength(method === 'tools/list' ? 0 : 2);
    },
  );
});

it('advertises twelve native strict tools without provider traffic or credential refresh', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  const { result } = await response.json();
  expect(result.tools).toHaveLength(12);
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
  ).toBe(100);
  expect(traffic).toEqual([]);
  expect(mocks.token).not.toHaveBeenCalled();
});

it('rechecks live undeleted membership and rejects unauthenticated, unknown, run and service actors', async () => {
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
  const unauthenticated = new Hono<{ Variables: Variables }>();
  unauthenticated.route('/gitlab', createGitlabMcp());
  expect(
    (await unauthenticated.request('/gitlab', { method: 'POST', body: '{}' }))
      .status,
  ).toBe(403);
  expect(traffic).toEqual([]);
});

it.each([
  { isActive: false },
  { host: 'other.example' },
  { sourceControlProvider: 'gitea' as const },
])(
  'rejects a repository outside the active provider/host boundary: %j',
  async (change) => {
    await db
      .update(repositories)
      .set(change)
      .where(eq(repositories.id, repositoryId));
    expect((await mrCall()).status).toBe(400);
    expect((await readFile()).status).toBe(400);
    expect(traffic).toEqual([]);
    expect(mocks.token).not.toHaveBeenCalled();
  },
);
it.each([
  ['delete_project', {}],
  ['request', { path: '/user' }],
  ['update_merge_request', { target_branch: 'main' }],
  ['update_merge_request', { state_event: 'merge' }],
  ['update_merge_request', {}],
  ['get_merge_request', { project_id: 'https://attacker.invalid/group/repo' }],
  ['get_merge_request', { project_id: 0 }],
  ['get_merge_request', { project_id: '0001' }],
  ['get_merge_request', { merge_request_iid: '../1' }],
  ['get_merge_request', { merge_request_iid: '9007199254740992' }],
  ['mr_discussions', { page: 0 }],
  ['mr_discussions', { per_page: 101 }],
  [
    'create_merge_request_discussion_note',
    { body: 'hello', discussion_id: '../other' },
  ],
  [
    'create_merge_request_note',
    { body: 'hello', headers: { Authorization: 'evil' } },
  ],
] as const)(
  'rejects forbidden %s arguments %j before HTTP',
  async (name, args) => {
    expect((await mrCall(name, args)).status).toBe(400);
    expect(traffic).toEqual([]);
  },
);

it('uses freshly resolved OAuth and canonical IDs, never caller headers or metadata', async () => {
  expect((await mrCall()).status).toBe(200);
  await saveConnection({ accessToken: 'rotated-token' });
  expect(
    (await mrCall('get_merge_request', { project_id: Number(externalId) }))
      .status,
  ).toBe(200);
  for (const [index, token] of [
    'refreshed-oauth-token',
    'rotated-token',
  ].entries()) {
    const item = traffic[index]!;
    expect(item.url).toBe(
      `https://gitlab.example/api/v4/projects/${externalId}/merge_requests/7`,
    );
    const headers = new Headers(item.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    for (const key of [
      'mcp-session-id',
      'x-gitlab-api-url',
      'private-token',
      'job-token',
    ])
      expect(headers.has(key)).toBe(false);
    expect(item.init?.redirect).toBe('error');
  }
  expect(
    (
      await request('tools/call', {
        name: 'get_merge_request',
        arguments: { project_id: externalId, merge_request_iid: '7' },
        _meta: {},
      })
    ).status,
  ).toBe(400);
  expect(mocks.token).toHaveBeenCalledTimes(2);
});

it('refreshes the real encrypted OAuth connection and preserves self-managed API prefixes', async () => {
  mocks.baseUrl = 'https://gitlab.example/gitlab';
  await saveConnection({
    baseUrl: mocks.baseUrl,
    expiresAt: new Date(0).toISOString(),
  });
  providerResponse = (url) =>
    url.pathname.endsWith('/oauth/token')
      ? Response.json({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 7200,
          scope: 'api',
        })
      : Response.json(mrObject);
  expect((await mrCall()).status).toBe(200);
  expect(traffic.map((item) => item.url)).toEqual([
    'https://gitlab.example/gitlab/oauth/token',
    `https://gitlab.example/gitlab/api/v4/projects/${externalId}/merge_requests/7`,
  ]);
  expect(
    new URLSearchParams(String(traffic[0]?.init?.body)).get('grant_type'),
  ).toBe('refresh_token');
  expect(new Headers(traffic[1]?.init?.headers).get('authorization')).toBe(
    'Bearer new-access-token',
  );
  expect(traffic.every((item) => item.init?.redirect === 'error')).toBe(true);
  expect(await gitlab.getGitLabOAuthConnection()).toMatchObject({
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
  });
});

it.each([
  { baseUrl: 'https://other.example' },
  { baseUrl: 'https://gitlab.example/other-prefix' },
  { status: 'reauthorization_required' as const },
  { scopes: ['read_api'] },
])(
  'rejects disconnected or wrong-host/scoped OAuth before token resolution: %j',
  async (change) => {
    await saveConnection(change);
    expect((await mrCall()).status).toBe(400);
    expect((await request()).status).toBe(400);
    expect(mocks.token).not.toHaveBeenCalled();
    expect(traffic).toEqual([]);
  },
);
it('rejects removed connections and scope loss during refresh', async () => {
  await db
    .delete(deploymentSecrets)
    .where(eq(deploymentSecrets.name, secretName));
  expect((await mrCall()).status).toBe(400);
  expect(traffic).toEqual([]);
  await saveConnection({ expiresAt: new Date(0).toISOString() });
  providerResponse = () =>
    Response.json({
      access_token: 'reduced-scope-token',
      scope: 'read_api',
      expires_in: 7200,
    });
  expect((await mrCall()).status).toBe(400);
  expect(traffic).toHaveLength(1);
  expect(traffic[0]?.url).toBe('https://gitlab.example/oauth/token');
});

it.each([
  'project',
  'iid',
  'id',
  'noteable',
  'type',
  'discussion',
  'empty',
  'mixed',
])(
  'checks MR/discussion ownership before any write: %s mismatch',
  async (mismatch) => {
    if (mismatch === 'project') mrObject.project_id = 1;
    if (mismatch === 'iid') mrObject.iid = 99;
    if (mismatch === 'id') mrObject.id = undefined;
    if (mismatch === 'discussion') discussion.id = 'other';
    if (mismatch === 'noteable')
      discussion.notes = [
        { noteable_id: 999, noteable_iid: 7, noteable_type: 'MergeRequest' },
      ];
    if (mismatch === 'type')
      discussion.notes = [
        { noteable_id: 70, noteable_iid: 7, noteable_type: 'Issue' },
      ];
    if (mismatch === 'empty') discussion.notes = [];
    if (mismatch === 'mixed')
      discussion.notes = [
        ...(discussion.notes as unknown[]),
        { noteable_id: 70, noteable_iid: 8, noteable_type: 'MergeRequest' },
      ];
    expect(
      (
        await mrCall('create_merge_request_discussion_note', {
          discussion_id: 'thread',
          body: 'hello',
        })
      ).status,
    ).toBe(400);
    expect(traffic.every((item) => item.init?.method === 'GET')).toBe(true);
  },
);
it.each(['update_merge_request', 'create_merge_request_note'])(
  'checks project ownership for %s, not only replies',
  async (name) => {
    mrObject.project_id = 1;
    expect(
      (
        await mrCall(
          name,
          name === 'update_merge_request' ? { title: 'new' } : { body: 'new' },
        )
      ).status,
    ).toBe(400);
    expect(traffic).toHaveLength(1);
    expect(traffic[0]?.init?.method).toBe('GET');
  },
);
it.each([
  [
    'update_merge_request',
    { title: 'new', description: '', state_event: 'reopen' },
    '',
    'PUT',
  ],
  ['update_merge_request', { state_event: 'close' }, '', 'PUT'],
  ['create_merge_request_note', { body: 'hello' }, '/notes', 'POST'],
  [
    'create_merge_request_discussion_note',
    { body: 'hello', discussion_id: 'thread' },
    '/discussions/thread/notes',
    'POST',
  ],
] as const)(
  'dispatches %s %j after ownership checks',
  async (name, args, suffix, method) => {
    expect((await mrCall(name, args)).status).toBe(200);
    expect(traffic[0]?.url).toBe(
      `https://gitlab.example/api/v4/projects/${externalId}/merge_requests/7`,
    );
    const write = traffic.at(-1)!;
    expect(write.url).toBe(
      `https://gitlab.example/api/v4/projects/${externalId}/merge_requests/7${suffix}`,
    );
    expect(write.init?.method).toBe(method);
    const { discussion_id: _discussion, ...body } = args as Record<
      string,
      unknown
    >;
    expect(JSON.parse(String(write.init?.body))).toEqual(body);
  },
);

it('does not impose speculative title, body, path, or page-number caps', async () => {
  expect(
    (
      await mrCall('update_merge_request', {
        title: 'x'.repeat(256),
        description: 'x'.repeat(32001),
      })
    ).status,
  ).toBe(200);
  expect(
    (await mrCall('create_merge_request_note', { body: 'x'.repeat(32001) }))
      .status,
  ).toBe(200);
  expect((await readFile({ file_path: 'x'.repeat(1025) })).status).toBe(200);
  expect(
    (await mrCall('mr_discussions', { page: 1001, per_page: 100 })).status,
  ).toBe(200);
  expect(new URL(traffic.at(-1)!.url).searchParams.get('page')).toBe('1001');
});

it.each([
  [
    'get_repository_tree',
    { path: 'src', ref: 'main', recursive: true },
    '/repository/tree',
    { pagination: 'keyset', path: 'src', ref: 'main', recursive: 'true' },
  ],
  [
    'search_project_code',
    { search: 'class Example', ref: 'main', page: 2 },
    '/search',
    { search: 'class Example', scope: 'blobs', ref: 'main', page: '2' },
  ],
  [
    'list_commits',
    { ref_name: 'main', path: 'src/example.ts' },
    '/repository/commits',
    { ref_name: 'main', path: 'src/example.ts', page: '1' },
  ],
  [
    'list_merge_request_diffs',
    { merge_request_iid: '7' },
    '/merge_requests/7/diffs',
    { page: '1' },
  ],
  [
    'get_merge_request_notes',
    { merge_request_iid: '7' },
    '/merge_requests/7/notes',
    { page: '1' },
  ],
  [
    'mr_discussions',
    { merge_request_iid: '7' },
    '/merge_requests/7/discussions',
    { page: '1' },
  ],
] as const)(
  'reads one bounded %s page using native project routes',
  async (name, args, suffix, expectedParams) => {
    providerResponse = () =>
      Response.json([{ id: 'item', diff: '@@ diff @@', notes: [] }], {
        headers: { 'x-next-page': '3' },
      });
    expect(
      await payload(await call(name, { ...args, per_page: 100 })),
    ).toMatchObject({ items: [{ id: 'item' }] });
    expect(traffic).toHaveLength(1);
    const url = new URL(traffic[0]!.url);
    expect(url.pathname).toBe(`/api/v4/projects/${externalId}${suffix}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      per_page: '100',
      ...expectedParams,
    });
  },
);
it('reads commit detail for an encoded branch/ref and preserves provider metadata', async () => {
  providerResponse = () =>
    Response.json({
      id: commit,
      parent_ids: [],
      message: 'message',
      stats: { total: 2 },
    });
  expect(
    await payload(await call('get_commit', { sha: 'feature/scoped' })),
  ).toMatchObject({ id: commit, stats: { total: 2 } });
  expect(traffic[0]?.url).toBe(
    `https://gitlab.example/api/v4/projects/${externalId}/repository/commits/feature%2Fscoped`,
  );
});

it('returns MR details including state, description and diff references through the existing client', async () => {
  mrObject = {
    ...mrObject,
    state: 'closed',
    description: 'MR description',
    diff_refs: { base_sha: 'b'.repeat(40), head_sha: commit },
  };
  expect(await payload(await mrCall())).toEqual(mrObject);
  expect(traffic).toHaveLength(1);
  expect(traffic[0]?.init?.method).toBe('GET');
});
it('exposes numeric and keyset continuation without following any response URL', async () => {
  providerResponse = () =>
    Response.json([], {
      headers: {
        'x-next-page': '2',
        link: '<https://evil.invalid/path?page_token=eyJpZCI6MX0%3D>; rel="next"',
      },
    });
  expect(await payload(await call('list_commits'))).toEqual({
    items: [],
    next_page: 2,
  });
  const tree = await payload(await call('get_repository_tree'));
  expect(tree).toEqual({ items: [], next_page_token: 'eyJpZCI6MX0=' });
  expect(
    (
      await call('get_repository_tree', {
        pagination: 'keyset',
        page_token: tree.next_page_token,
      })
    ).status,
  ).toBe(200);
  expect(new URL(traffic.at(-1)!.url).searchParams.get('page_token')).toBe(
    'eyJpZCI6MX0=',
  );
  expect(
    traffic.every((item) =>
      item.url.startsWith(
        `https://gitlab.example/api/v4/projects/${externalId}/`,
      ),
    ),
  ).toBe(true);
  expect(
    (await call('get_repository_tree', { page_token: 'https://evil.invalid' }))
      .status,
  ).toBe(400);
});
it.each([400, 403, 404, 405, 501])(
  'returns a clear unavailable search error (%s), never broadens scope',
  async (status) => {
    providerResponse = () =>
      new Response('refresh-secret private error', { status });
    const response = await call('search_project_code', { search: 'test' });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('Project code search is unavailable');
    expect(text).not.toContain('refresh-secret');
    expect(traffic).toHaveLength(1);
  },
);

it('supports only initialize, notification, list and call RPC methods', async () => {
  expect(
    (await (await request('initialize')).json()).result.capabilities,
  ).toEqual({ tools: {} });
  expect((await request('notifications/initialized')).status).toBe(202);
  expect((await request('resources/list')).status).toBe(400);
  expect(traffic).toEqual([]);
});
it('bounds a provider stall to the request deadline and suppresses its error', async () => {
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
  const response = await mrCall();
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('timeout secret');
}, 30000);
it.each([301, 302, 307, 308, 401, 500])(
  'rejects provider redirects/errors %s without leaking response bodies',
  async (status) => {
    providerResponse = () =>
      new Response('refreshed-oauth-token secret error', {
        status,
        headers: { location: 'https://evil.invalid' },
      });
    const response = await mrCall();
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('refreshed-oauth-token');
    expect(traffic).toHaveLength(1);
    expect(traffic[0]?.init?.redirect).toBe('error');
  },
);
it('bounds request and serialized response bytes, including JSON escaping', async () => {
  expect(
    (await mrCall('create_merge_request_note', { body: 'x'.repeat(70000) }))
      .status,
  ).toBe(413);
  expect(traffic).toEqual([]);
  providerResponse = () =>
    Response.json({ ...mrObject, description: 'x'.repeat(MAX_BYTES) });
  expect((await mrCall()).status).toBe(400);
  fileResponse = () => new Response('"'.repeat(300000));
  providerResponse = undefined;
  expect((await readFile()).status).toBe(400);
});
const MAX_BYTES = 1024 * 1024;
it.each(['refreshed-oauth-token', 'refresh-secret', 'client-secret'])(
  'suppresses provider payloads reflecting credential %s',
  async (secret) => {
    providerResponse = () =>
      Response.json({ ...mrObject, description: secret });
    const response = await mrCall();
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(secret);
  },
);
it('validates bounded page responses rather than reporting malformed or oversized pages as complete', async () => {
  for (const value of [
    { error: 'not a page' },
    Array.from({ length: 21 }, () => ({})),
  ]) {
    providerResponse = () => Response.json(value);
    expect((await call('list_commits')).status).toBe(400);
  }
});

it('suppresses JSON-escaped credentials before wrapping the MCP text result', async () => {
  await saveConnection({ clientSecret: 'quoted-"client-secret' });
  providerResponse = () =>
    Response.json({ ...mrObject, description: connection.clientSecret });
  const response = await mrCall();
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('quoted-');
});

it('reads an immutable raw file window using canonical project ID and original bytes', async () => {
  expect(
    await payload(
      await readFile({ file_path: 'src/file name.ts', offset: 1, limit: 1 }),
    ),
  ).toEqual({
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
  expect(traffic[0]?.url).toBe(
    `https://gitlab.example/api/v4/projects/${externalId}/repository/files/src%2Ffile%20name.ts/raw?ref=${commit}&lfs=false`,
  );
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
  { limit: 2001 },
  { limit: 0 },
  { url: 'https://evil.invalid' },
  { headers: {} },
])('rejects unsafe file arguments %j without HTTP', async (args) => {
  expect((await readFile(args)).status).toBe(400);
  expect(traffic).toEqual([]);
});
it('returns default truncation and explicit continuation without newline normalization', async () => {
  fileResponse = () => new Response('line\r\n'.repeat(2001));
  const first = await payload(await readFile());
  expect(first).toMatchObject({
    lines_returned: 2000,
    total_lines: 2001,
    next_offset: 2000,
    truncated: true,
    content: 'line\r\n'.repeat(2000),
  });
  expect(
    await payload(await readFile({ offset: first.next_offset })),
  ).toMatchObject({
    lines_returned: 1,
    next_offset: null,
    content: 'line\r\n',
    ref: commit,
  });
});
it.each(['', 'without final newline', '\ufeffwith BOM\n'])(
  'preserves bounded text %j',
  async (content) => {
    fileResponse = () => new Response(content);
    expect(await payload(await readFile())).toMatchObject({
      content,
      size_bytes: Buffer.byteLength(content),
      truncated: false,
      next_offset: null,
    });
  },
);
it('cancels oversized streams even for a one-line window without returning partial content', async () => {
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
  expect(pulled).toBeLessThan(20);
});
it('rejects declared oversize and counts UTF-8 bytes, while accepting the exact limit', async () => {
  const cancel = vi.fn();
  fileResponse = () =>
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': String(MAX_BYTES + 1) },
    });
  expect((await readFile()).status).toBe(400);
  expect(cancel).toHaveBeenCalled();
  fileResponse = () => new Response('\u00e9'.repeat(524289));
  expect((await readFile({ limit: 1 })).status).toBe(400);
  fileResponse = () => new Response('a\n'.repeat(524288));
  expect((await readFile({ limit: 1 })).status).toBe(200);
});
it.each([new Uint8Array([0xff, 0xfe]), new Uint8Array([65, 0, 66])])(
  'rejects invalid UTF-8 or binary files',
  async (bytes) => {
    fileResponse = () => new Response(bytes);
    const response = await readFile();
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain(
      'No file content was returned',
    );
  },
);
