import { randomUUID } from 'node:crypto';

import {
  db,
  eq,
  inArray,
  sql,
  userFactory,
  users,
  sessions,
  resolveOwnedSessionSecret,
  type SessionSecretContext,
} from '@roomote/db/server';
import type { SessionSecretPrepare } from '@roomote/types';

import { safeFetch } from '../safe-fetch';
import {
  createSessionSecret as finalize,
  prepareSessionSecret,
  listSessionSecretApprovals,
  listSessionSecrets,
  revokeSessionSecret,
  requestWithSessionSecret,
} from '../session-secrets';

vi.mock('../safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../safe-fetch')>()),
  safeFetch: vi.fn(),
}));

const secret = 'Test-Key/A+b=<"&>123';
const origin = 'https://api.example.com';
const unavailable = { success: false, error: 'Secret request unavailable' };
const fetchMock = vi.mocked(safeFetch);
let context: SessionSecretContext;
let secretRef: string;
let userIds: string[];
let sessionIds: string[];

function input(
  overrides: Partial<SessionSecretPrepare & { secret: string }> = {},
): SessionSecretPrepare & { secret: string } {
  return {
    label: 'Test credential',
    secret,
    origin,
    headerName: 'authorization',
    headerPrefix: 'Bearer ',
    ttlHours: 24,
    ...overrides,
  };
}

async function createSessionSecret(
  actor: SessionSecretContext,
  args: ReturnType<typeof input>,
) {
  const { secret: value, ...policy } = args;
  const pending = await prepareSessionSecret(actor, policy);
  return finalize(actor, { pendingRef: pending.pendingRef, secret: value });
}

async function session(userId: string) {
  const [row] = await db
    .insert(sessions)
    .values({
      title: 'Session secret test',
      ownerKind: 'user',
      ownerUserId: userId,
      sourceSurface: 'web',
      sourceTrigger: 'manual',
      activityAt: Date.now(),
    })
    .returning();
  sessionIds.push(row!.id);
  return row!.id;
}

function request(overrides: Record<string, unknown> = {}, actor = context) {
  return requestWithSessionSecret(actor, {
    secretRef,
    method: 'GET',
    path: '/v1/items',
    ...overrides,
  });
}

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response('{"ok":true}'));
  userIds = [];
  sessionIds = [];
  const owner = await userFactory.create();
  userIds.push(owner.id);
  context = { userId: owner.id, sessionId: await session(owner.id) };
  ({ secretRef } = await createSessionSecret(context, input()));
});

afterEach(async () => {
  vi.useRealTimers();
  await db.execute(
    sql`delete from session_secret_audit where actor_user_id in ${userIds} or secret_ref = ${secretRef}`,
  );
  await db.delete(sessions).where(inArray(sessions.id, sessionIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

describe('session secret storage and ownership (real database)', () => {
  it('persists immutable nonsecret approvals, defaults TTL, and finalizes exactly once under a race', async () => {
    const { secret: _secret, ttlHours: _ttl, ...policy } = input();
    const pending = await prepareSessionSecret(context, policy);
    expect(
      Date.parse(pending.expiresAt) - Date.parse(pending.createdAt),
    ).toBeGreaterThanOrEqual(24 * 3600_000 - 1000);
    expect(Object.keys(pending).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'headerName',
      'headerPrefix',
      'label',
      'origin',
      'pendingRef',
    ]);
    expect(await listSessionSecretApprovals(context)).toMatchObject({
      pending: [pending],
      secrets: [{ secretRef }],
    });
    for (const extra of [
      { origin: 'https://evil.example' },
      { label: 'changed' },
      { expiresAt: new Date().toISOString() },
      { headerName: 'api-key' },
      { userId: context.userId },
    ]) {
      await expect(
        finalize(context, { pendingRef: pending.pendingRef, secret, ...extra }),
      ).rejects.toThrow('Secret request unavailable');
    }
    expect((await listSessionSecretApprovals(context)).pending).toEqual([
      pending,
    ]);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        finalize(context, { pendingRef: pending.pendingRef, secret }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
    const approvals = await listSessionSecretApprovals(context);
    expect(approvals.pending).toEqual([]);
    expect(approvals.secrets).toHaveLength(2);
    const created = approvals.secrets.find(
      (row) => row.secretRef !== secretRef,
    )!;
    expect(created).toMatchObject(policy);
    expect(created.expiresAt).toBe(pending.expiresAt);
    expect(JSON.stringify(approvals)).not.toContain(secret);
    await expect(
      finalize(context, { pendingRef: pending.pendingRef, secret }),
    ).rejects.toThrow('Secret request unavailable');
  });

  it.each([
    'cross-session',
    'other-owner',
    'transferred-owner',
    'deleted-owner',
    'deleted-session',
    'archived',
    'expired',
    'unknown',
  ] as const)('denies pending finalization for %s', async (kind) => {
    const { secret: _secret, ...policy } = input();
    const pending = await prepareSessionSecret(context, policy);
    const actor = { ...context };
    if (kind === 'cross-session')
      actor.sessionId = await session(context.userId!);
    if (kind === 'other-owner' || kind === 'transferred-owner') {
      const other = await userFactory.create();
      userIds.push(other.id);
      actor.userId = other.id;
      if (kind === 'transferred-owner')
        await db
          .update(sessions)
          .set({ ownerUserId: other.id })
          .where(eq(sessions.id, context.sessionId));
    }
    if (kind === 'deleted-owner')
      await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, context.userId!));
    if (kind === 'deleted-session')
      await db.delete(sessions).where(eq(sessions.id, context.sessionId));
    if (kind === 'archived')
      await db
        .update(sessions)
        .set({ archivedAt: new Date() })
        .where(eq(sessions.id, context.sessionId));
    if (kind === 'expired')
      await db.execute(
        sql`update session_secret_approvals set expires_at = clock_timestamp() - interval '1 second' where id = ${pending.pendingRef}`,
      );
    await expect(
      finalize(actor, {
        pendingRef: kind === 'unknown' ? randomUUID() : pending.pendingRef,
        secret,
      }),
    ).rejects.toThrow('Secret request unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown prepare fields and invalid TTLs without storing secrets or consuming on validation failure', async () => {
    const { secret: _secret, ...policy } = input();
    for (const extra of [
      { secret },
      { sessionId: context.sessionId },
      { ttlHours: 0 },
      { ttlHours: 721 },
      { ttlHours: 1.5 },
      { expiresAt: new Date().toISOString() },
    ]) {
      await expect(
        prepareSessionSecret(context, { ...policy, ...extra }),
      ).rejects.toThrow('Secret request unavailable');
    }
    const pending = await prepareSessionSecret(context, {
      ...policy,
      label: secret,
      ttlHours: 720,
    });
    await expect(
      finalize(context, { pendingRef: pending.pendingRef, secret }),
    ).rejects.toThrow('Secret request unavailable');
    expect((await listSessionSecretApprovals(context)).pending).toEqual([
      pending,
    ]);
    const raw = await db.execute(
      sql`select * from session_secret_approvals where id = ${pending.pendingRef}`,
    );
    expect(raw[0]!.consumed_at).toBeNull();
    expect(raw[0]).not.toHaveProperty('value');
    expect(raw[0]).not.toHaveProperty('secret');
  });

  it('encrypts raw SQL storage, decrypts for the owner, lists metadata only, and wipes ciphertext on revoke', async () => {
    const raw = await db.execute<{ value: string | null }>(
      sql`select value from session_secrets where id = ${secretRef}`,
    );
    expect(raw[0]!.value).toBeTruthy();
    expect(raw[0]!.value).not.toContain(secret);
    expect(await resolveOwnedSessionSecret(context, secretRef)).toMatchObject({
      secretRef,
      value: secret,
    });
    const listed = await listSessionSecrets(context);
    expect(listed).toEqual([
      expect.objectContaining({ secretRef, origin, revokedAt: null }),
    ]);
    expect(Object.keys(listed[0]!).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'headerName',
      'headerPrefix',
      'label',
      'origin',
      'revokedAt',
      'secretRef',
    ]);
    expect(JSON.stringify(listed)).not.toContain(secret);
    await revokeSessionSecret(context, { secretRef });
    const revoked = await db.execute<{
      value: string | null;
      revoked_at: string;
    }>(
      sql`select value, revoked_at from session_secrets where id = ${secretRef}`,
    );
    expect(revoked[0]).toMatchObject({
      value: null,
      revoked_at: expect.any(String),
    });
    await expect(resolveOwnedSessionSecret(context, secretRef)).rejects.toThrow(
      'Secret unavailable',
    );
    expect(await request()).toEqual(unavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'member',
    'admin',
    'actorless',
    'nonexistent-session',
    'deleted-owner',
  ] as const)(
    'denies creation, listing, revocation, decryption and requests for %s',
    async (kind) => {
      const { secret: _secret, ...policy } = input();
      const pending = await prepareSessionSecret(context, policy);
      const actor = { ...context };
      if (kind === 'member' || kind === 'admin') {
        const other = await userFactory.create({ role: kind });
        userIds.push(other.id);
        actor.userId = other.id;
      } else if (kind === 'actorless') actor.userId = null;
      else if (kind === 'nonexistent-session') actor.sessionId = randomUUID();
      else
        await db
          .update(users)
          .set({ deletedAt: new Date() })
          .where(eq(users.id, context.userId!));

      await expect(createSessionSecret(actor, input())).rejects.toThrow(
        'Secret request unavailable',
      );
      await expect(
        finalize(actor, { pendingRef: pending.pendingRef, secret }),
      ).rejects.toThrow('Secret request unavailable');
      await expect(listSessionSecretApprovals(actor)).rejects.toThrow(
        'Secret request unavailable',
      );
      await expect(listSessionSecrets(actor)).rejects.toThrow(
        'Secret request unavailable',
      );
      await expect(revokeSessionSecret(actor, { secretRef })).rejects.toThrow(
        'Secret request unavailable',
      );
      await expect(resolveOwnedSessionSecret(actor, secretRef)).rejects.toThrow(
        'Secret unavailable',
      );
      expect(await request({}, actor)).toEqual(unavailable);
      expect(fetchMock).not.toHaveBeenCalled();
      const raw = await db.execute<{ value: string | null }>(
        sql`select value from session_secrets where id = ${secretRef}`,
      );
      expect(raw[0]!.value).toBeTruthy();
    },
  );

  it('binds references to their session even for the same owner and rejects unknown references', async () => {
    const other = { ...context, sessionId: await session(context.userId!) };
    expect(await listSessionSecrets(other)).toEqual([]);
    for (const [actor, ref] of [
      [other, secretRef],
      [context, randomUUID()],
    ] as const) {
      await expect(resolveOwnedSessionSecret(actor, ref)).rejects.toThrow(
        'Secret unavailable',
      );
      await expect(
        revokeSessionSecret(actor, { secretRef: ref }),
      ).rejects.toThrow('Secret request unavailable');
      expect(await request({ secretRef: ref }, actor)).toEqual(unavailable);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses real SQL expiry and rejects expired grants without an outbound request', async () => {
    await db.execute(
      sql`update session_secrets set expires_at = clock_timestamp() - interval '1 second' where id = ${secretRef}`,
    );
    await expect(resolveOwnedSessionSecret(context, secretRef)).rejects.toThrow(
      'Secret unavailable',
    );
    expect(await request()).toEqual(unavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks use and creation after archive while retaining owner list and revoke access', async () => {
    await db
      .update(sessions)
      .set({ archivedAt: new Date() })
      .where(eq(sessions.id, context.sessionId));
    expect(await request()).toEqual(unavailable);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(createSessionSecret(context, input())).rejects.toThrow(
      'Secret request unavailable',
    );
    expect(await listSessionSecrets(context)).toHaveLength(1);
    await revokeSessionSecret(context, { secretRef });
    expect((await listSessionSecrets(context))[0]!.revokedAt).not.toBeNull();
  });
});

describe('session secret requests', () => {
  it('uses a no-prefix API key with a normalized default HTTPS port and records successful dispatch', async () => {
    const grant = await createSessionSecret(
      context,
      input({
        origin: 'https://api.github.com:443',
        headerName: 'x-api-key',
        headerPrefix: '',
      }),
    );
    expect(grant.origin).toBe('https://api.github.com');
    expect(
      await request({
        secretRef: grant.secretRef,
        path: '/repos/octocat/Hello-World',
        accept: 'application/json',
      }),
    ).toEqual({ success: true, status: 200, body: '{"ok":true}' });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      new URL('https://api.github.com/repos/octocat/Hello-World'),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity',
          'x-api-key': secret,
        },
        signal: expect.any(AbortSignal),
      },
    );
    const audit = await db.execute<{ outcome: string }>(sql`
      select outcome from session_secret_audit where secret_ref = ${grant.secretRef} order by created_at
    `);
    expect(audit.map((row) => row.outcome)).toEqual(['started', 'succeeded']);
  });

  it.each(['GET', 'HEAD'])(
    'injects only the approved header for %s and returns no response headers',
    async (method) => {
      fetchMock.mockResolvedValueOnce(
        new Response('public response', {
          status: 200,
          headers: { 'x-upstream-secret': secret },
        }),
      );
      expect(
        await request({
          method,
          path: '/v1/items?limit=1',
          accept: 'text/plain',
        }),
      ).toEqual({
        success: true,
        status: 200,
        body: method === 'GET' ? 'public response' : '',
      });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        new URL(`${origin}/v1/items?limit=1`),
        {
          method,
          headers: {
            accept: 'text/plain',
            'accept-encoding': 'identity',
            authorization: `Bearer ${secret}`,
          },
          signal: expect.any(AbortSignal),
        },
      );
    },
  );

  it('rejects mutating methods and caller-supplied context, body, headers or network policy', async () => {
    for (const overrides of [
      { method: 'POST' },
      { method: 'PUT' },
      { method: 'DELETE' },
      { sessionId: context.sessionId },
      { userId: context.userId },
      { body: secret },
      { headers: { authorization: secret } },
      { origin: 'https://evil.example' },
      { allowedPrivateCidrs: ['0.0.0.0/0'] },
    ])
      expect(await request(overrides)).toEqual(unavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe origins at creation with the real egress validator', async () => {
    for (const unsafe of [
      'http://api.example.com',
      'https://127.0.0.1',
      'https://169.254.169.254',
      'https://[::1]',
      'https://user:pass@api.example.com',
      `${origin}/v1`,
      `${origin}?token=private`,
      `${origin}#fragment`,
      'https://api%2eexample.com',
      'https://api.example.com\\@evil.example',
    ])
      await expect(
        createSessionSecret(context, input({ origin: unsafe })),
      ).rejects.toThrow('Secret request unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects absolute, traversal, nested-encoded, malformed and control-character paths', async () => {
    for (const path of [
      'https://evil.example/',
      '//evil.example/',
      '/\\evil.example',
      '/a/../b',
      '/a/./b',
      '/a//b',
      '/%2e%2e/private',
      '/%252e%252e/private',
      '/%252f%252fevil.example',
      '/%5cevil.example',
      '/broken%ZZ',
      '/%C0%AF',
      '/a%00b',
      '/a%0db',
      '/a#fragment',
      '/a b',
    ])
      expect(await request({ path }), path).toEqual(unavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('suppresses exact, case-insensitive, URL, base64, JSON and HTML echoes as whole bodies', async () => {
    const bytes = Buffer.from(secret);
    const echoes = [
      secret,
      secret.toUpperCase(),
      `Bearer ${secret}`,
      encodeURIComponent(secret),
      encodeURIComponent(encodeURIComponent(secret)),
      [...bytes].map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''),
      bytes.toString('base64'),
      bytes.toString('base64url'),
      bytes.toString('hex'),
      Buffer.from(`key=${secret}&other=1`).toString('base64'),
      Buffer.from(`keys=${secret}&other=1`).toString('base64'),
      Buffer.from(`keyss=${secret}&other=1`).toString('base64'),
      Buffer.from(
        JSON.stringify({ authorization: `Bearer ${secret}` }),
      ).toString('base64'),
      JSON.stringify(secret),
      [...secret]
        .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join(''),
      [...secret].map((c) => `&#${c.charCodeAt(0)};`).join(''),
      [...secret].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join(''),
      secret
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('/', '&sol;')
        .replaceAll('+', '&plus;')
        .replaceAll('=', '&equals;'),
    ];
    for (const echo of echoes) {
      fetchMock.mockResolvedValueOnce(new Response(`prefix ${echo} suffix`));
      expect(await request()).toEqual({
        success: true,
        status: 200,
        body: '[REDACTED]',
      });
    }
  });

  it('denies redirects, malformed/oversized Content-Length and invalid UTF-8 without leaking details', async () => {
    const cancel = vi.fn();
    for (const response of [
      new Response(null, {
        status: 302,
        headers: { location: `https://evil.example/?secret=${secret}` },
      }),
      ...['65537', '-1', 'not-a-number'].map(
        (length) =>
          new Response(new ReadableStream({ cancel }), {
            headers: { 'content-length': length },
          }),
      ),
      new Response(new Uint8Array([0xff])),
    ]) {
      fetchMock.mockResolvedValueOnce(response);
      expect(await request()).toEqual(unavailable);
    }
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it('suppresses an encoded header echo split across upstream chunks', async () => {
    const echo = Buffer.from(
      JSON.stringify({ authorization: `Bearer ${secret}` }),
    ).toString('base64');
    const chunks = [echo.slice(0, 17), echo.slice(17, 31), echo.slice(31)];
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk === undefined) controller.close();
            else controller.enqueue(new TextEncoder().encode(chunk));
          },
        }),
      ),
    );
    expect(await request()).toEqual({
      success: true,
      status: 200,
      body: '[REDACTED]',
    });
  });

  it('bounds actual UTF-8 bytes without Content-Length, not decoded characters', async () => {
    const cancel = vi.fn();
    let pulls = 0;
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(
                new TextEncoder().encode('\u00e9'.repeat(16_384)),
              );
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    expect(await request()).toEqual(unavailable);
    expect(pulls).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('allows exactly 64 KiB but cancels a stream once actual bytes exceed the bound despite a small declared length', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('a'.repeat(65536), {
        headers: { 'content-length': '65536' },
      }),
    );
    expect(await request()).toEqual({
      success: true,
      status: 200,
      body: 'a'.repeat(65536),
    });
    let pulls = 0;
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(new Uint8Array(32768));
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-length': '1' } },
      ),
    );
    expect(await request()).toEqual(unavailable);
    expect(pulls).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts a stalled body at the deadline without faking Date or SQL expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let notifyEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const cancel = vi.fn();
    fetchMock.mockImplementationOnce(async (_url, options) => {
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            options?.signal?.addEventListener(
              'abort',
              () => controller.error(new Error(secret)),
              { once: true },
            );
          },
          pull() {
            notifyEntered();
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      return new Response(body);
    });
    const result = request();
    await entered;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual(unavailable);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('times out before headers and cancels a late response without reading it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let notifyEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    let respond!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => {
      notifyEntered();
      // Model a pending DNS/connection operation that does not settle on abort.
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    });
    const result = request();
    await entered;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual(unavailable);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    const pull = vi.fn();
    const cancel = vi.fn();
    respond(
      new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('shares one 10s budget across waiting for headers and a stalled body', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let notifyEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const cancel = vi.fn();
    const pull = vi.fn();
    fetchMock.mockImplementationOnce(() => {
      notifyEntered();
      return new Promise<Response>((resolve) => {
        setTimeout(
          () =>
            resolve(
              new Response(
                new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
              ),
            ),
          6_000,
        );
      });
    });
    const result = request();
    await entered;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(pull).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(unavailable);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('suppresses results if the grant is revoked while the upstream is responding', async () => {
    fetchMock.mockImplementationOnce(async () => {
      await revokeSessionSecret(context, { secretRef });
      return new Response('previously authorized response');
    });
    expect(await request()).toEqual(unavailable);
  });

  it('rechecks live ownership when a Session changes owners during a request', async () => {
    const other = await userFactory.create();
    userIds.push(other.id);
    fetchMock.mockImplementationOnce(async () => {
      await db
        .update(sessions)
        .set({ ownerUserId: other.id })
        .where(eq(sessions.id, context.sessionId));
      return new Response('previously authorized response');
    });
    expect(await request()).toEqual(unavailable);
    expect(await request({}, { ...context, userId: other.id })).toEqual(
      unavailable,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stores only safe audit metadata for success, denial and sensitive upstream errors', async () => {
    const query = 'private-query-marker';
    fetchMock.mockResolvedValueOnce(new Response('private-body-marker'));
    expect(
      await request({ path: `/v1/private-path-marker?token=${query}` }),
    ).toMatchObject({ success: true });
    fetchMock.mockRejectedValueOnce(
      new Error(`private-error-marker ${secret}`),
    );
    expect(await request({ path: `/v1/items?token=${query}` })).toEqual(
      unavailable,
    );
    expect(await request({ path: '/%2e%2e/private' })).toEqual(unavailable);
    const rows = await db.execute(
      sql`select id, created_at as "createdAt", actor_user_id as "actorUserId", secret_ref as "secretRef", method, destination, outcome from session_secret_audit where secret_ref = ${secretRef}`,
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.outcome).sort()).toEqual([
      'denied',
      'failed',
      'started',
      'started',
      'succeeded',
    ]);
    for (const row of rows) {
      expect(row).toEqual({
        id: expect.any(String),
        createdAt: expect.any(String),
        actorUserId: context.userId,
        secretRef,
        method: 'GET',
        outcome: expect.any(String),
        destination: row.outcome === 'denied' ? null : origin,
      });
    }
    const serialized = JSON.stringify(rows);
    for (const forbidden of [
      secret,
      query,
      'private-path-marker',
      'private-body-marker',
      'private-error-marker',
      'authorization',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
