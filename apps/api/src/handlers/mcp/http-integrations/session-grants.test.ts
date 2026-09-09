import { randomUUID } from 'node:crypto';
import { fetch, Agent } from 'undici';
import {
  db,
  eq,
  inArray,
  sql,
  users,
  sessions,
  tasks,
  taskRuns,
  sessionTasks,
  fastAgentConversations,
  userFactory,
  sessionFactory,
  taskFactory,
  runFactory,
  resolveSessionSecretContext,
  resolveOwnedSessionSecret,
  type SessionSecretContext,
} from '@roomote/db/server';
import {
  prepareSessionSecret,
  createSessionSecret,
  revokeSessionSecret,
} from '@roomote/sdk/server/session-secrets';
import { integrationRequest } from './broker';

const { destroy } = vi.hoisted(() => ({ destroy: vi.fn(async () => {}) }));
vi.mock('undici', () => ({
  fetch: vi.fn(),
  Agent: vi.fn(
    class {
      destroy = destroy;
    },
  ),
}));

const secret = 'Test-Key/A+b=<"&>123';
const origin = 'https://api.example.com';
type Auth = Parameters<typeof resolveSessionSecretContext>[0];
let ownerId: string;
let otherId: string;
let context: SessionSecretContext;
let secretRef: string;
let fastAuth: Extract<Auth, { tokenType: 'session-broker' }>;
let runAuth: Extract<Auth, { tokenType: 'run' }>;
let taskId: string;
let userIds: string[];
let sessionIds: string[];
let taskIds: string[];

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

async function run(userId: string | null, sessionId?: string) {
  const task = await taskFactory.create({ initiatorUserId: ownerId });
  taskIds.push(task.id);
  const row = await runFactory.create({
    taskId: task.id,
    actingUserId: userId,
  });
  if (sessionId)
    await db
      .insert(sessionTasks)
      .values({ sessionId, taskId: task.id, origin: 'direct_launch' });
  return row;
}

function request(
  overrides: Record<string, unknown> = {},
  auth: Auth = fastAuth,
) {
  return integrationRequest(
    { integrations: [] },
    `session-test:${context.sessionId}`,
    {
      integrationId: `session:${secretRef}`,
      method: 'GET',
      path: '/v1/items',
      ...overrides,
    },
    ownerId,
    undefined,
    () => resolveSessionSecretContext(auth),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(fetch)
    .mockReset()
    .mockResolvedValue(Response.json({ ok: true }) as never);
  userIds = [];
  sessionIds = [];
  taskIds = [];
  for (let i = 0; i < 2; i++) userIds.push((await userFactory.create()).id);
  [ownerId, otherId] = userIds as [string, string];
  const row = await session(ownerId);
  context = { userId: ownerId, sessionId: row.id };
  fastAuth = {
    tokenType: 'session-broker',
    userId: ownerId,
    fastConversationId: row.fastConversationId!,
  };
  const attached = await run(ownerId, row.id);
  taskId = attached.taskId;
  runAuth = { tokenType: 'run', runId: attached.id };
  const pending = await prepareSessionSecret(context, {
    label: 'API test credential',
    origin,
    headerName: 'authorization',
    headerPrefix: 'Bearer ',
  });
  ({ secretRef } = await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret,
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.execute(
    sql`delete from session_secret_audit where secret_ref = ${secretRef}`,
  );
  await db.delete(sessions).where(inArray(sessions.id, sessionIds));
  await db.delete(tasks).where(inArray(tasks.id, taskIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

it.each(['Fast', 'run'] as const)(
  'decrypts an owner grant inside the API for trusted %s context',
  async (kind) => {
    const auth = kind === 'Fast' ? fastAuth : runAuth;
    expect(await resolveSessionSecretContext(auth)).toMatchObject(context);
    const stored = await db.execute<{ value: string }>(
      sql`select value from session_secrets where id = ${secretRef}`,
    );
    expect(stored[0]!.value).not.toContain(secret);
    expect(await request({}, auth)).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      new URL(`${origin}/v1/items`),
      expect.objectContaining({
        redirect: 'manual',
        dispatcher: expect.anything(),
        signal: expect.any(AbortSignal),
        headers: {
          authorization: `Bearer ${secret}`,
          accept: 'application/json',
          'accept-encoding': 'identity',
        },
      }),
    );
    expect(Agent).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  },
);

it.each([
  'other-Fast-user',
  'other-run-actor',
  'unrelated-Fast',
  'unrelated-run',
  'unattached-run',
  'actorless',
  'deleted-owner',
  'archived',
  'changed-owner',
  'detached-run',
] as const)(
  'denies %s before transport using live database joins',
  async (kind) => {
    let auth: Auth = runAuth;
    if (kind === 'other-Fast-user') auth = { ...fastAuth, userId: otherId };
    if (kind === 'other-run-actor' || kind === 'actorless')
      await db
        .update(taskRuns)
        .set({ actingUserId: kind === 'actorless' ? null : otherId })
        .where(eq(taskRuns.id, runAuth.runId));
    if (kind === 'unrelated-Fast' || kind === 'unrelated-run') {
      const unrelated = await session(ownerId);
      auth =
        kind === 'unrelated-Fast'
          ? { ...fastAuth, fastConversationId: unrelated.fastConversationId! }
          : { tokenType: 'run', runId: (await run(ownerId, unrelated.id)).id };
    }
    if (kind === 'unattached-run')
      auth = { tokenType: 'run', runId: (await run(ownerId)).id };
    if (kind === 'deleted-owner')
      await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, ownerId));
    if (kind === 'archived')
      await db
        .update(sessions)
        .set({ archivedAt: new Date() })
        .where(eq(sessions.id, context.sessionId));
    if (kind === 'changed-owner')
      await db
        .update(sessions)
        .set({ ownerUserId: otherId })
        .where(eq(sessions.id, context.sessionId));
    if (kind === 'detached-run')
      await db.delete(sessionTasks).where(eq(sessionTasks.taskId, taskId));
    await expect(request({}, auth)).rejects.toThrow(
      /^Secret request unavailable$/,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(Agent).not.toHaveBeenCalled();
  },
);

it.each([
  ['run', 'revoked'],
  ['run', 'expired'],
  ['run', 'changed-owner'],
  ['run', 'changed-actor'],
  ['run', 'changed-membership'],
  ['run', 'archived'],
  ['run', 'deleted-owner'],
  ['Fast', 'changed-Fast-link'],
  ['Fast', 'revoked'],
  ['Fast', 'expired'],
  ['Fast', 'changed-owner'],
  ['Fast', 'archived'],
  ['Fast', 'deleted-owner'],
] as const)(
  'rechecks %s %s before dispatch and before releasing an in-flight response',
  async (actor, kind) => {
    const auth = actor === 'Fast' ? fastAuth : runAuth;
    const mutate = async () => {
      if (kind === 'revoked') await revokeSessionSecret(context, { secretRef });
      if (kind === 'expired')
        await db.execute(
          sql`update session_secrets set expires_at = clock_timestamp() - interval '1 second' where id = ${secretRef}`,
        );
      if (kind === 'changed-owner')
        await db
          .update(sessions)
          .set({ ownerUserId: otherId })
          .where(eq(sessions.id, context.sessionId));
      if (kind === 'changed-actor')
        await db
          .update(taskRuns)
          .set({ actingUserId: otherId })
          .where(eq(taskRuns.id, runAuth.runId));
      if (kind === 'changed-membership')
        await db
          .update(sessionTasks)
          .set({ sessionId: (await session(ownerId)).id })
          .where(eq(sessionTasks.taskId, taskId));
      if (kind === 'archived')
        await db
          .update(sessions)
          .set({ archivedAt: new Date() })
          .where(eq(sessions.id, context.sessionId));
      if (kind === 'deleted-owner')
        await db
          .update(users)
          .set({ deletedAt: new Date() })
          .where(eq(users.id, ownerId));
      if (kind === 'changed-Fast-link')
        await db
          .update(sessions)
          .set({ fastConversationId: null })
          .where(eq(sessions.id, context.sessionId));
    };
    vi.mocked(fetch).mockImplementationOnce(async () => {
      await mutate();
      return Response.json({ private: 'must not escape' }) as never;
    });
    await expect(request({}, auth)).rejects.toThrow(
      /^Secret request unavailable$/,
    );
    expect(fetch).toHaveBeenCalledOnce();
    await expect(request({}, auth)).rejects.toThrow(
      /^Secret request unavailable$/,
    );
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each(['GET', 'HEAD'])(
  'canonicalizes absent, undefined, null and empty %s bodies without content headers',
  async (method) => {
    for (const representation of [
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
      await request({ method, ...representation, contentType: 'text/plain' });
      const options = vi.mocked(fetch).mock.lastCall![1]!;
      expect(options).not.toHaveProperty('body');
      expect(options.headers).toEqual({
        authorization: `Bearer ${secret}`,
        accept: 'application/json',
        'accept-encoding': 'identity',
      });
      expect(options.redirect).toBe('manual');
    }
    for (const body of [' ', '\n', '{}', 'null', secret])
      await expect(request({ method, body })).rejects.toThrow(
        /^Secret request unavailable$/,
      );
    expect(fetch).toHaveBeenCalledTimes(4);
  },
);

it('rejects caller context, headers, network policy, writes and ambiguous paths before transport', async () => {
  for (const extra of [
    { sessionId: context.sessionId },
    { userId: ownerId },
    { headers: { authorization: secret } },
    { origin: 'https://evil.example' },
    { allowedPrivateCidrs: ['0.0.0.0/0'] },
    { method: 'POST' },
    ...[
      'https://evil.example/',
      '//evil.example/',
      '/a/../b',
      '/%252e%252e/private',
      '/%252f%252fevil.example',
      '/broken%ZZ',
      '/a%00b',
    ].map((path) => ({ path })),
  ])
    await expect(request(extra)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(Agent).not.toHaveBeenCalled();
  await expect(
    integrationRequest(
      { integrations: [] },
      'untrusted',
      { integrationId: `session:${secretRef}`, method: 'GET', path: '/' },
      ownerId,
    ),
  ).rejects.toThrow(/^Secret request unavailable$/);
});

it('allows exactly 64 KiB and rejects declared or actual oversized bytes, malformed lengths and invalid UTF-8', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response('a'.repeat(65536), {
      headers: { 'content-length': '65536' },
    }) as never,
  );
  expect(await request()).toMatchObject({ body: 'a'.repeat(65536) });
  for (const length of ['65537', '-1', 'not-a-number']) {
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        headers: { 'content-type': 'text/plain', 'content-length': length },
      }) as never,
    );
    await expect(request()).rejects.toThrow(/^Secret request unavailable$/);
    expect(cancel).toHaveBeenCalledOnce();
  }
  const cancel = vi.fn();
  let pulls = 0;
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(
      new ReadableStream(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(
              new TextEncoder().encode('\u00e9'.repeat(16384)),
            );
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
      { headers: { 'content-type': 'text/plain', 'content-length': '1' } },
    ) as never,
  );
  await expect(request()).rejects.toThrow(/^Secret request unavailable$/);
  expect(pulls).toBe(3);
  expect(cancel).toHaveBeenCalledOnce();
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(new Uint8Array([0xff]), {
      headers: { 'content-type': 'text/plain' },
    }) as never,
  );
  await expect(request()).rejects.toThrow(/^Secret request unavailable$/);
});

it('rejects redirects without following them and never discloses upstream errors', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(null, {
      status: 302,
      headers: { location: `https://evil.example/?secret=${secret}` },
    }) as never,
  );
  await expect(request()).rejects.toThrow(/^Secret request unavailable$/);
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.mocked(fetch).mock.lastCall![1]!.redirect).toBe('manual');
  vi.mocked(fetch).mockRejectedValueOnce(
    new Error(`private-error-marker ${secret}`),
  );
  await expect(request()).rejects.toThrow(/^Secret request unavailable$/);
});

it('rejects literal and encoded echoes including split chunks and allowlisted response headers', async () => {
  const bytes = Buffer.from(secret);
  for (const echo of [
    secret,
    secret.toUpperCase(),
    encodeURIComponent(encodeURIComponent(secret)),
    bytes.toString('base64'),
    bytes.toString('hex'),
    JSON.stringify(secret),
    [...secret].map((c) => `&#${c.charCodeAt(0)};`).join(''),
  ]) {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(`prefix ${echo} suffix`) as never,
    );
    await expect(request()).rejects.toThrow(/^Secret request unavailable$/);
  }
  const echo = Buffer.from(
    JSON.stringify({ authorization: `Bearer ${secret}` }),
  ).toString('base64');
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(c) {
          for (const part of [echo.slice(0, 17), echo.slice(17)])
            c.enqueue(new TextEncoder().encode(part));
          c.close();
        },
      }),
      { headers: { 'content-type': 'text/plain' } },
    ) as never,
  );
  await expect(request()).rejects.toThrow(/^Secret request unavailable$/);
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response('safe', {
      headers: { 'x-request-id': encodeURIComponent(secret) },
    }) as never,
  );
  await expect(request()).rejects.toThrow(/^Secret request unavailable$/);
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response('safe', {
      headers: {
        'set-cookie': secret,
        authorization: secret,
        'x-request-id': 'public-id',
      },
    }) as never,
  );
  expect(await request()).toEqual({
    status: 200,
    body: 'safe',
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      'x-request-id': 'public-id',
    },
  });
});

it('bounds the deadline by grant expiry and suppresses an aborted in-flight response', async () => {
  await db.execute(
    sql`update session_secrets set expires_at = clock_timestamp() + interval '5 seconds' where id = ${secretRef}`,
  );
  const abort = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(abort.signal);
  vi.mocked(fetch).mockImplementationOnce(async (_url, options) => {
    expect(options!.signal).toBe(abort.signal);
    abort.abort();
    return Response.json({
      private: 'must not escape after deadline',
    }) as never;
  });
  await expect(request()).rejects.toThrow(/^Secret request unavailable$/);
  expect(timeout).toHaveBeenCalledOnce();
  expect(timeout.mock.calls[0]![0]).toBeGreaterThan(0);
  expect(timeout.mock.calls[0]![0]).toBeLessThanOrEqual(5000);
  expect(destroy).toHaveBeenCalledOnce();
});

it('records only safe audit metadata for success and sensitive upstream failures', async () => {
  await request({ path: '/private-path-marker?token=private-query-marker' });
  vi.mocked(fetch).mockRejectedValueOnce(
    new Error(`private-error-marker ${secret}`),
  );
  await expect(request()).rejects.toThrow(/^Secret request unavailable$/);
  const rows = await db.execute(
    sql`select * from session_secret_audit where secret_ref = ${secretRef}`,
  );
  expect(rows.map((row) => row.outcome).sort()).toEqual([
    'failed',
    'started',
    'started',
    'succeeded',
  ]);
  for (const row of rows)
    expect(row).toMatchObject({
      actor_user_id: ownerId,
      secret_ref: secretRef,
      method: 'GET',
      destination: origin,
    });
  for (const forbidden of [
    secret,
    'private-path-marker',
    'private-query-marker',
    'private-error-marker',
    'authorization',
  ])
    expect(JSON.stringify(rows)).not.toContain(forbidden);
});

it.each(['fetch', 'body'] as const)(
  'settles a stalled %s even when upstream ignores abort',
  async (stage) => {
    const abort = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.mocked(fetch).mockImplementationOnce(async () => {
      if (stage === 'fetch') {
        started();
        return new Promise<never>(() => {});
      }
      return new Response(
        new ReadableStream({
          pull() {
            started();
          },
          cancel,
        }),
        {
          headers: { 'content-type': 'text/plain' },
        },
      ) as never;
    });
    const pending = request();
    const rejected = expect(pending).rejects.toThrow(
      /^Secret request unavailable$/,
    );
    await ready;
    abort.abort();
    await rejected;
    expect(destroy).toHaveBeenCalledOnce();
    if (stage === 'body') expect(cancel).toHaveBeenCalledOnce();
  },
);

it('audits malformed Session requests without retaining their arguments', async () => {
  await expect(
    request({ body: 'not-allowed', sessionId: 'caller-authority' }),
  ).rejects.toThrow(/^Secret request unavailable$/);
  expect(fetch).not.toHaveBeenCalled();
  const rows = await db.execute(
    sql`select * from session_secret_audit where secret_ref = ${secretRef}`,
  );
  expect(rows.map((row) => row.outcome)).toEqual(['denied']);
  expect(JSON.stringify(rows)).not.toContain('caller-authority');
  expect(JSON.stringify(rows)).not.toContain('not-allowed');
});

it('does not trust a resolved run context after its live actor changes', async () => {
  const resolved = await resolveSessionSecretContext(runAuth);
  await db
    .update(taskRuns)
    .set({ actingUserId: otherId })
    .where(eq(taskRuns.id, runAuth.runId));
  await expect(resolveOwnedSessionSecret(resolved, secretRef)).rejects.toThrow(
    'Secret unavailable',
  );
});

it('records failure, not success, when revoked during completion-audit persistence', async () => {
  await expect(
    integrationRequest(
      { integrations: [] },
      `audit-race:${context.sessionId}`,
      {
        integrationId: `session:${secretRef}`,
        method: 'GET',
        path: '/status',
      },
      ownerId,
      undefined,
      async () => {
        const completed = await db.execute(
          sql`select id from session_secret_audit where secret_ref = ${secretRef} and outcome = 'succeeded'`,
        );
        if (completed.length) await revokeSessionSecret(context, { secretRef });
        return resolveSessionSecretContext(fastAuth);
      },
    ),
  ).rejects.toThrow(/^Secret request unavailable$/);
  const rows = await db.execute(
    sql`select outcome from session_secret_audit where secret_ref = ${secretRef}`,
  );
  expect(rows.map((row) => row.outcome).sort()).toEqual(['failed', 'started']);
});
