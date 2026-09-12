import { randomUUID } from 'node:crypto';
import {
  db,
  eq,
  inArray,
  sql,
  userFactory,
  sessionFactory,
  users,
  sessions,
  resolveOwnedSessionSecret,
  type SessionSecretContext,
} from '@roomote/db/server';
import {
  createSessionSecret,
  prepareSessionSecret,
  listSessionSecretApprovals,
  listSessionSecrets,
  revokeSessionSecret,
} from '../session-secrets';

const secret = 'Test-Key/A+b=<"&>123';
const policy = {
  label: 'Test credential',
  origin: 'https://api.example.com',
  headerName: 'authorization' as const,
  headerPrefix: 'Bearer ' as const,
};
let context: SessionSecretContext;
let secretRef: string;
let userIds: string[];
let sessionIds: string[];

async function session(userId: string) {
  const row = await sessionFactory.create({
    ownerKind: 'user',
    ownerUserId: userId,
  });
  sessionIds.push(row.id);
  return row.id;
}

beforeEach(async () => {
  userIds = [];
  sessionIds = [];
  const owner = await userFactory.create();
  userIds.push(owner.id);
  context = { userId: owner.id, sessionId: await session(owner.id) };
  const pending = await prepareSessionSecret(context, policy);
  ({ secretRef } = await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret,
  }));
});

afterEach(async () => {
  await db.delete(sessions).where(inArray(sessions.id, sessionIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

it('persists immutable nonsecret approvals, defaults TTL and finalizes exactly once under a race', async () => {
  const pending = await prepareSessionSecret(context, policy);
  expect(
    Date.parse(pending.expiresAt) - Date.parse(pending.createdAt),
  ).toBeGreaterThanOrEqual(24 * 3600_000 - 1000);
  expect(pending.allowedMethods).toEqual(['GET', 'HEAD']);
  expect(Object.keys(pending).sort()).toEqual([
    'allowedMethods',
    'createdAt',
    'expiresAt',
    'headerName',
    'headerPrefix',
    'label',
    'origin',
    'pendingRef',
  ]);
  for (const extra of [
    { origin: 'https://evil.example' },
    { label: 'changed' },
    { expiresAt: new Date().toISOString() },
    { headerName: 'api-key' },
    { userId: context.userId },
    { sessionId: context.sessionId },
  ]) {
    await expect(
      createSessionSecret(context, {
        pendingRef: pending.pendingRef,
        secret,
        ...extra,
      }),
    ).rejects.toThrow('Secret request unavailable');
  }
  expect((await listSessionSecretApprovals(context)).pending).toEqual([
    pending,
  ]);
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      createSessionSecret(context, { pendingRef: pending.pendingRef, secret }),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
  const approvals = await listSessionSecretApprovals(context);
  expect(approvals.pending).toEqual([]);
  expect(approvals.secrets).toHaveLength(2);
  expect(
    approvals.secrets.find((row) => row.secretRef !== secretRef),
  ).toMatchObject({ ...policy, expiresAt: pending.expiresAt });
  expect(JSON.stringify(approvals)).not.toContain(secret);
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
    createSessionSecret(actor, {
      pendingRef: kind === 'unknown' ? randomUUID() : pending.pendingRef,
      secret,
    }),
  ).rejects.toThrow('Secret request unavailable');
});

it('rejects unknown fields and invalid TTLs without consuming approvals on validation failure', async () => {
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
    createSessionSecret(context, { pendingRef: pending.pendingRef, secret }),
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

it('encrypts SQL storage, lists metadata only and wipes ciphertext on revoke', async () => {
  const raw = await db.execute<{ value: string }>(
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
    expect.objectContaining({ secretRef, ...policy, revokedAt: null }),
  ]);
  expect(listed[0]!.allowedMethods).toEqual(['GET', 'HEAD']);
  expect(Object.keys(listed[0]!).sort()).toEqual([
    'allowedMethods',
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
  const revoked = await db.execute(
    sql`select value, revoked_at from session_secrets where id = ${secretRef}`,
  );
  expect(revoked[0]).toMatchObject({
    value: null,
    revoked_at: expect.any(String),
  });
  await expect(resolveOwnedSessionSecret(context, secretRef)).rejects.toThrow(
    'Secret unavailable',
  );
});

it.each([
  'member',
  'admin',
  'actorless',
  'nonexistent-session',
  'deleted-owner',
] as const)(
  'denies creation, listing, revocation and decryption for %s',
  async (kind) => {
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
    await expect(prepareSessionSecret(actor, policy)).rejects.toThrow(
      'Secret request unavailable',
    );
    await expect(
      createSessionSecret(actor, { pendingRef: pending.pendingRef, secret }),
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
    const raw = await db.execute(
      sql`select value from session_secrets where id = ${secretRef}`,
    );
    expect(raw[0]!.value).toBeTruthy();
  },
);

it('binds references to the Session even for the same owner and rejects unknown references', async () => {
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
  }
});

it('uses SQL expiry to deny decryption', async () => {
  await db.execute(
    sql`update session_secrets set expires_at = clock_timestamp() - interval '1 second' where id = ${secretRef}`,
  );
  await expect(resolveOwnedSessionSecret(context, secretRef)).rejects.toThrow(
    'Secret unavailable',
  );
});

it('blocks creation and use after archive while retaining owner list and revoke access', async () => {
  await db
    .update(sessions)
    .set({ archivedAt: new Date() })
    .where(eq(sessions.id, context.sessionId));
  await expect(resolveOwnedSessionSecret(context, secretRef)).rejects.toThrow(
    'Secret unavailable',
  );
  await expect(prepareSessionSecret(context, policy)).rejects.toThrow(
    'Secret request unavailable',
  );
  expect(await listSessionSecrets(context)).toHaveLength(1);
  await revokeSessionSecret(context, { secretRef });
  expect((await listSessionSecrets(context))[0]!.revokedAt).not.toBeNull();
});

it('rejects unsafe origins with the real egress validator and normalizes default HTTPS ports', async () => {
  for (const origin of [
    'http://api.example.com',
    'https://127.0.0.1',
    'https://169.254.169.254',
    'https://[::1]',
    'https://user:pass@api.example.com',
    `${policy.origin}/v1`,
    `${policy.origin}?token=private`,
    `${policy.origin}#fragment`,
    'https://api%2eexample.com',
    'https://api.example.com\\@evil.example',
  ]) {
    await expect(
      prepareSessionSecret(context, { ...policy, origin }),
    ).rejects.toThrow('Secret request unavailable');
  }
  expect(
    await prepareSessionSecret(context, {
      ...policy,
      origin: 'https://api.github.com:443',
      headerName: 'x-api-key',
      headerPrefix: '',
    }),
  ).toMatchObject({ origin: 'https://api.github.com', headerPrefix: '' });
});
