import { randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { fetch, Agent } from 'undici';
import {
  db,
  eq,
  inArray,
  or,
  sql,
  users,
  sessions,
  tasks,
  taskRuns,
  sessionTasks,
  serviceCredentials,
  serviceCredentialAudit,
  credentialEgressAudit,
  credentialEgressRevocations,
  credentialEgressWorkloads,
  fastAgentConversations,
  userFactory,
  sessionFactory,
  taskFactory,
  runFactory,
  registerCredentialEgressWorkload,
  terminateCredentialEgressWorkload,
  type ServiceCredentialContext,
} from '@roomote/db/server';
import {
  createServiceCredential,
  prepareServiceCredential,
  revokeServiceCredential,
} from '@roomote/sdk/server/service-credentials';
import {
  RunStatus,
  CREDENTIAL_EGRESS_PROXY_PATH,
  CREDENTIAL_EGRESS_SUBSTITUTE_PREFIX,
  credentialEgressProxyBaseUrl,
  type CredentialEgressMethod,
} from '@roomote/types';
import { routePolicyMiddleware } from '../../../middleware/routePolicyMiddleware';
import { tokenAuthMiddleware } from '../../../middleware/tokenAuthMiddleware';
import { findRoutePolicyRule } from '../../../route-policies';
import type { Variables } from '../../../types';
import {
  createCredentialEgressProxy,
  presentedSubstitute,
  credentialEgressProxyHostAlias,
} from '../index';

const { destroy } = vi.hoisted(() => ({ destroy: vi.fn(async () => {}) }));
vi.mock('undici', () => ({
  fetch: vi.fn(),
  Agent: vi.fn(
    class {
      destroy = destroy;
    },
  ),
}));

const secret = 'Real-Upstream-Key/A+b=<"&>123';
const origin = 'https://1.1.1.1';
const base = CREDENTIAL_EGRESS_PROXY_PATH;

let app: Hono<{ Variables: Variables }>;
let ownerId: string;
let context: ServiceCredentialContext;
let sessionId: string;
let runId: number;
let secretRef: string;
let workloadId: string;
let substitute: string;
let userIds: string[];
let sessionIds: string[];
let taskIds: string[];
const minted: string[] = [];
const consoleOutput: string[] = [];

async function session(userId: string) {
  const [fast] = await db
    .insert(fastAgentConversations)
    .values({
      userId,
      surface: 'web',
      workspaceId: randomUUID(),
      conversationId: randomUUID(),
    })
    .returning();
  const row = await sessionFactory.create({
    ownerKind: 'user',
    ownerUserId: userId,
    fastConversationId: fast!.id,
  });
  sessionIds.push(row.id);
  return row;
}

async function run(userId: string, attachTo: string) {
  const task = await taskFactory.create({ initiatorUserId: ownerId });
  taskIds.push(task.id);
  const row = await runFactory.create({
    taskId: task.id,
    actingUserId: userId,
    status: RunStatus.Running,
  });
  await db.insert(sessionTasks).values({
    sessionId: attachTo,
    taskId: task.id,
    origin: 'direct_launch',
  });
  return row;
}

async function grant(
  input: {
    label?: string;
    origin?: string;
    headerName?: string;
    headerPrefix?: '' | 'Bearer ' | 'Basic ' | 'Token ';
    allowedMethods?: CredentialEgressMethod[];
  } = {},
) {
  const pending = await prepareServiceCredential(context, {
    label: input.label ?? 'Example API',
    origin: input.origin ?? origin,
    headerName: input.headerName ?? 'authorization',
    headerPrefix: input.headerPrefix ?? 'Bearer ',
    visibility: 'owner',
    ...(input.allowedMethods ? { allowedMethods: input.allowedMethods } : {}),
  });
  return createServiceCredential(context, {
    pendingRef: pending.pendingRef,
    secret,
    ...(input.allowedMethods ? { allowedMethods: input.allowedMethods } : {}),
  });
}

/** Register the run the way a connector-less controller would; returns substitutes by grant. */
async function register() {
  const registration = await registerCredentialEgressWorkload({
    runId,
    provider: 'modal',
    connectorIdentity: `roomote://api-proxy/${randomBytes(12).toString('hex')}`,
    leaseSeconds: 3600,
  });
  for (const issue of registration.substitutes) minted.push(issue.substitute);
  return registration;
}

async function substituteFor(ref: string) {
  const registration = await register();
  return registration.substitutes.find((issue) => issue.secretRef === ref)!
    .substitute;
}

function request(
  suffix = '/v1/items',
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    token?: string | null;
  } = {},
) {
  const token = init.token === undefined ? substitute : init.token;
  return app.request(`${base}${suffix}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(init.headers ?? {}),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

function sentHeaders(call = 0): Record<string, string> {
  return vi.mocked(fetch).mock.calls[call]![1]!.headers as Record<
    string,
    string
  >;
}

async function auditRows(ref = secretRef) {
  return db.execute<{
    phase: string;
    decision: string;
    reason: string | null;
    destination: string | null;
    workload_id: string | null;
  }>(
    sql`select phase, decision, reason, destination, workload_id from credential_egress_audit where secret_ref = ${ref} order by created_at, phase`,
  );
}

beforeEach(async () => {
  consoleOutput.length = 0;
  for (const level of ['log', 'error', 'warn', 'info', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map((arg) => String(arg)).join(' '));
    });
  vi.mocked(fetch)
    .mockReset()
    .mockResolvedValue(Response.json({ ok: true }) as never);
  destroy.mockClear();
  vi.mocked(Agent).mockClear();
  app = new Hono<{ Variables: Variables }>();
  app.use('*', tokenAuthMiddleware());
  app.use('*', routePolicyMiddleware);
  app.route(base, createCredentialEgressProxy());
  userIds = [];
  sessionIds = [];
  taskIds = [];
  minted.length = 0;
  ownerId = (await userFactory.create()).id;
  userIds.push(ownerId);
  const row = await session(ownerId);
  sessionId = row.id;
  context = { userId: ownerId, sessionId };
  runId = (await run(ownerId, sessionId)).id;
  ({ secretRef } = await grant());
  const registration = await register();
  workloadId = registration.workloadId;
  substitute = registration.substitutes[0]!.substitute;
});

afterEach(async () => {
  const output = consoleOutput.join('\n');
  expect(output).not.toContain(secret);
  for (const token of minted) expect(output).not.toContain(token);
  expect(output).not.toContain('private-');
  vi.restoreAllMocks();
  const ownWorkloads = db
    .select({ id: credentialEgressWorkloads.id })
    .from(credentialEgressWorkloads)
    .where(inArray(credentialEgressWorkloads.sessionId, sessionIds));
  const ownSecrets = db
    .select({ id: serviceCredentials.id })
    .from(serviceCredentials)
    .where(inArray(serviceCredentials.sessionId, sessionIds));
  await db
    .delete(credentialEgressAudit)
    .where(
      or(
        inArray(credentialEgressAudit.workloadId, ownWorkloads),
        inArray(credentialEgressAudit.secretRef, ownSecrets),
      ),
    );
  await db
    .delete(credentialEgressRevocations)
    .where(
      or(
        inArray(credentialEgressRevocations.workloadId, ownWorkloads),
        inArray(credentialEgressRevocations.secretRef, ownSecrets),
      ),
    );
  await db
    .delete(serviceCredentialAudit)
    .where(inArray(serviceCredentialAudit.secretRef, ownSecrets));
  await db.delete(sessions).where(inArray(sessions.id, sessionIds));
  await db.delete(tasks).where(inArray(tasks.id, taskIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

it('is a handler-authenticated public surface with one shared base URL', () => {
  expect(findRoutePolicyRule(`${base}/v1/items`)).toMatchObject({
    name: 'credential-egress-proxy',
    policy: 'webhook',
    // Unauthenticated callers are bounded before the handler touches the database.
    rateLimits: [{ keySource: 'client', limit: 300, windowSeconds: 60 }],
  });
  expect(credentialEgressProxyBaseUrl('https://api.roomote.test/')).toBe(
    `https://api.roomote.test${base}`,
  );
  expect(
    credentialEgressProxyBaseUrl(
      'https://api.roomote.test/',
      'egress.roomote.test',
    ),
  ).toBe('https://egress.roomote.test');
});

it('serves the same route at the root of a dedicated hostname through the full middleware chain', async () => {
  const proxy = createCredentialEgressProxy();
  app = new Hono<{ Variables: Variables }>();
  const policyPasses: string[] = [];
  app.use(
    '*',
    credentialEgressProxyHostAlias(
      (request) => app.fetch(request),
      'Egress.Roomote.Test',
    ),
  );
  // Registered ahead of the default-deny policy gate, like the real health routes.
  app.get('/health', (c) => c.text('ok'));
  app.use('*', tokenAuthMiddleware());
  app.use('*', async (c, next) => {
    policyPasses.push(new URL(c.req.url).pathname);
    await next();
  });
  app.use('*', routePolicyMiddleware);
  app.route(base, proxy);
  const aliased = await app.request(
    'https://egress.roomote.test/v1/items?x=1',
    { headers: { authorization: `Bearer ${substitute}` } },
  );
  expect(aliased.status).toBe(200);
  expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe(
    'https://1.1.1.1/v1/items?x=1',
  );
  // The aliased request reached the policy gate exactly once, on the
  // re-rooted path, so rate limits and policy apply as on the path form.
  expect(policyPasses).toEqual([`${base}/v1/items`]);
  // Other hosts and other paths are untouched.
  const other = await app.request('https://api.roomote.test/health');
  expect(await other.text()).toBe('ok');
  const viaPath = await app.request(
    `https://egress.roomote.test${base}/v1/items`,
    { headers: { authorization: `Bearer ${substitute}` } },
  );
  expect(viaPath.status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('reads an exact substitute after any single authentication scheme', () => {
  const token = `${CREDENTIAL_EGRESS_SUBSTITUTE_PREFIX}${'a'.repeat(43)}`;
  expect(presentedSubstitute(`Bearer ${token}`)).toBe(token);
  expect(presentedSubstitute(`bearer ${token}`)).toBe(token);
  expect(presentedSubstitute(`Basic ${token}`)).toBe(token);
  expect(presentedSubstitute(token)).toBe(token);
  expect(presentedSubstitute(`Bearer  ${token}`)).toBeNull();
  expect(presentedSubstitute(`12 ${token}`)).toBeNull();
  expect(presentedSubstitute(token.toUpperCase())).toBeNull();
  expect(presentedSubstitute(undefined)).toBeNull();
  expect(presentedSubstitute('Bearer not-a-substitute')).toBeNull();
});

it('forwards an allowed request with the real credential and relays a scrubbed response', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ items: [1, 2, 3] }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'upstream-42',
        'set-cookie': 'session=private-cookie-marker',
        'www-authenticate': 'Bearer realm="private-realm-marker"',
      },
    }) as never,
  );
  const response = await request('/v1/items?limit=3&q=private-query-marker', {
    headers: {
      accept: 'application/json',
      cookie: 'sandbox=private-cookie-marker',
      'x-forwarded-for': '203.0.113.9',
      'user-agent': 'stripe-node/12.0',
    },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ items: [1, 2, 3] });
  expect(response.headers.get('x-request-id')).toBe('upstream-42');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('www-authenticate')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');

  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = vi.mocked(fetch).mock.calls[0]!;
  expect(String(url)).toBe(
    'https://1.1.1.1/v1/items?limit=3&q=private-query-marker',
  );
  const sent = sentHeaders();
  expect(sent.authorization).toBe(`Bearer ${secret}`);
  expect(sent['accept-encoding']).toBe('identity');
  expect(sent.accept).toBe('application/json');
  expect(sent['user-agent']).toBe('stripe-node/12.0');
  expect(sent.cookie).toBeUndefined();
  expect(sent['x-forwarded-for']).toBeUndefined();
  expect(init!.redirect).toBe('manual');
  expect(Agent).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();

  const rows = await auditRows();
  expect(rows.map((row) => [row.phase, row.decision])).toEqual([
    ['request', 'allowed'],
    ['response', 'allowed'],
  ]);
  for (const row of rows)
    expect(row).toMatchObject({
      destination: '1.1.1.1:443',
      workload_id: workloadId,
    });
});

it('injects into the grant slot whichever slot the client used', async () => {
  const { secretRef: keyRef } = await grant({
    label: 'Keyed API',
    headerName: 'x-api-key',
    headerPrefix: '',
  });
  const keyed = await substituteFor(keyRef);
  const variants: Record<string, string>[] = [
    { 'x-api-key': keyed },
    { authorization: `Bearer ${keyed}` },
  ];
  for (const headers of variants) {
    vi.mocked(fetch).mockClear();
    const response = await request('/v1/keys', { token: null, headers });
    expect(response.status).toBe(200);
    expect(sentHeaders()['x-api-key']).toBe(secret);
    expect(sentHeaders().authorization).toBeUndefined();
  }
  expect((await auditRows(keyRef)).map((row) => row.decision)).toEqual([
    'allowed',
    'allowed',
    'allowed',
    'allowed',
  ]);
});

it('serves grants on service-specific headers and strips whichever header carried the token', async () => {
  const { secretRef: gitlabRef } = await grant({
    label: 'GitLab',
    headerName: 'PRIVATE-TOKEN',
    headerPrefix: '',
  });
  const gitlab = await substituteFor(gitlabRef);
  const variants: Record<string, string>[] = [
    { 'private-token': gitlab },
    { authorization: `Bearer ${gitlab}` },
    { 'x-anything-goes': gitlab },
  ];
  for (const headers of variants) {
    vi.mocked(fetch).mockClear();
    const response = await request('/v4/user', { token: null, headers });
    expect(response.status).toBe(200);
    const sent = sentHeaders();
    expect(sent['private-token']).toBe(secret);
    expect(sent.authorization).toBeUndefined();
    expect(sent['x-anything-goes']).toBeUndefined();
  }
});

it('routes each substitute to its own approved origin from one base URL', async () => {
  const { secretRef: otherRef } = await grant({
    label: 'Other API',
    origin: 'https://1.0.0.1',
    headerPrefix: 'Token ',
  });
  // Registering again rotates the workload generation, so both tokens must
  // come from the same registration.
  const registration = await register();
  const tokenFor = (ref: string) =>
    registration.substitutes.find((issue) => issue.secretRef === ref)!
      .substitute;
  await request('/v1/items', { token: tokenFor(secretRef) });
  await request('/v2/things', { token: tokenFor(otherRef) });
  expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
    'https://1.1.1.1/v1/items',
    'https://1.0.0.1/v2/things',
  ]);
  expect(sentHeaders(1).authorization).toBe(`Token ${secret}`);
});

it.each([
  ['missing header', { token: null }, 'missing_substitute'],
  ['not a substitute', { token: 'Real-Upstream-Key' }, 'missing_substitute'],
  [
    'two different substitutes',
    {
      headers: {
        'x-api-key': `${CREDENTIAL_EGRESS_SUBSTITUTE_PREFIX}${'z'.repeat(43)}`,
      },
    },
    'ambiguous_substitute',
  ],
] as const)(
  'denies %s without contacting the origin',
  async (_name, init, reason) => {
    const response = await request('/v1/items', init);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'credential_egress_denied',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(consoleOutput.join('\n')).toContain(`reason=${reason}`);
    expect(await auditRows()).toEqual([]);
  },
);

it('denies an unknown substitute without attributing an audit row', async () => {
  const response = await request('/v1/items', {
    token: `${CREDENTIAL_EGRESS_SUBSTITUTE_PREFIX}${'z'.repeat(43)}`,
  });
  expect(response.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect(consoleOutput.join('\n')).toContain(
    'grant=unknown, method=GET, reason=unknown_substitute',
  );
  expect(await auditRows()).toEqual([]);
});

it('enforces the grant method policy and forwards approved writes with their body', async () => {
  const denied = await request('/v1/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":"private-body-marker"}',
  });
  expect(denied.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect((await auditRows()).map((row) => row.reason)).toEqual([
    'method_not_allowed',
  ]);

  const { secretRef: writeRef } = await grant({
    label: 'Writable API',
    allowedMethods: ['GET', 'POST'],
  });
  const writable = await substituteFor(writeRef);
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ id: 'new' }, { status: 201 }) as never,
  );
  const created = await request('/v1/items', {
    token: writable,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":"widget"}',
  });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ id: 'new' });
  const [, init] = vi.mocked(fetch).mock.calls[0]!;
  expect(init!.method).toBe('POST');
  expect(Buffer.from(init!.body as ArrayBuffer).toString()).toBe(
    '{"name":"widget"}',
  );
  expect(sentHeaders()['content-type']).toBe('application/json');
  const options = await request('/v1/items', {
    method: 'OPTIONS',
    token: writable,
  });
  expect(options.status).toBe(405);
});

it('re-roots paths on the approved origin and refuses escapes', async () => {
  await request('/v1/./things/../items?x=1');
  expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe(
    'https://1.1.1.1/v1/items?x=1',
  );
  vi.mocked(fetch).mockClear();
  // Dot segments that climb above the mount are resolved by the URL layer
  // before routing, so they never reach the proxy; a protocol-relative path
  // does reach the handler and is refused there.
  const climbed = await request('/v1/../../evil');
  expect(climbed.status).toBe(404);
  const escaped = await request('//evil.example.com/steal');
  expect(escaped.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect(consoleOutput.join('\n')).toContain('reason=destination_mismatch');
});

it.each([
  [
    'revoked grant',
    'grant_revoked',
    () => revokeServiceCredential(context, { secretRef }),
  ],
  [
    'finished run',
    'session_unavailable',
    () =>
      db
        .update(taskRuns)
        .set({ status: RunStatus.Completed })
        .where(eq(taskRuns.id, runId)),
  ],
  [
    'terminated workload',
    'workload_inactive',
    () => terminateCredentialEgressWorkload(workloadId, 'stopped'),
  ],
  [
    'detached run',
    'session_unavailable',
    () => db.delete(sessionTasks).where(eq(sessionTasks.sessionId, sessionId)),
  ],
])('denies a %s', async (_name, reason, mutate) => {
  await mutate();
  const response = await request('/v1/items');
  expect(response.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect((await auditRows()).at(-1)).toMatchObject({
    phase: 'request',
    decision: 'denied',
    reason,
  });
});

it('withholds a response whose grant was revoked during the upstream exchange', async () => {
  vi.mocked(fetch).mockImplementationOnce(async () => {
    await revokeServiceCredential(context, { secretRef });
    return Response.json({ private: 'private-late-marker' }) as never;
  });
  const response = await request('/v1/items');
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain('private-late-marker');
  expect((await auditRows()).map((row) => [row.phase, row.decision])).toEqual([
    ['request', 'allowed'],
    ['response', 'denied'],
  ]);
});

it('refuses redirects so the credential never follows a Location header', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(null, {
      status: 302,
      headers: { location: 'https://elsewhere.example.com/private-path' },
    }) as never,
  );
  const response = await request('/v1/items');
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: 'credential_egress_upstream_rejected',
  });
  expect(consoleOutput.join('\n')).toContain('reason=redirect_refused');
});

it.each([
  ['body', () => new Response(`leaked ${secret}`, { status: 200 })],
  [
    'encoded body',
    () =>
      Response.json({
        echo: Buffer.from(`Bearer ${secret}`).toString('base64'),
      }),
  ],
  [
    'header',
    () =>
      new Response('ok', {
        status: 200,
        headers: { 'x-debug': `Bearer ${secret}` },
      }),
  ],
])(
  'withholds a response that echoes the credential in its %s',
  async (_name, upstream) => {
    vi.mocked(fetch).mockResolvedValueOnce(upstream() as never);
    const response = await request('/v1/items');
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(secret);
    expect(consoleOutput.join('\n')).toContain('reason=credential_echo');
  },
);

it('bounds the relayed response size', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response('x'.repeat(10), {
      status: 200,
      headers: { 'content-length': String(9 * 1024 * 1024) },
    }) as never,
  );
  const declared = await request('/v1/items');
  expect(declared.status).toBe(502);
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(new Uint8Array(8 * 1024 * 1024 + 1), { status: 200 }) as never,
  );
  const streamed = await request('/v1/items');
  expect(streamed.status).toBe(502);
  expect(
    consoleOutput.filter((line) => line.includes('reason=response_too_large')),
  ).toHaveLength(2);
});

it('relays HEAD and 204 without a body', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(null, { status: 200, headers: { etag: '"v1"' } }) as never,
  );
  const head = await request('/v1/items', { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('etag')).toBe('"v1"');
  expect(await head.text()).toBe('');
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(null, { status: 204 }) as never,
  );
  const empty = await request('/v1/items');
  expect(empty.status).toBe(204);
});

it('reports transport failures by class and code only', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(
    new TypeError('fetch failed private-error-marker', {
      cause: Object.assign(new Error('connect private-error-marker'), {
        code: 'ECONNREFUSED',
      }),
    }),
  );
  const response = await request('/v1/items');
  expect(response.status).toBe(502);
  expect(consoleOutput.join('\n')).toContain('reason=TypeError:ECONNREFUSED');
  expect(destroy).toHaveBeenCalledOnce();
});
