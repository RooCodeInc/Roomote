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
  resolveOwnedServiceCredential,
  type ServiceCredentialContext,
} from '@roomote/db/server';
import {
  createIntegration,
  createServiceCredential,
  prepareServiceCredential,
  listIntegrations,
  listServiceCredentialApprovals,
  listServiceCredentials,
  revokeIntegration,
  revokeServiceCredential,
} from '../service-credentials';

const secret = 'Test-Key/A+b=<"&>123';
const policy = {
  label: 'Test credential',
  origin: 'https://api.example.com',
  headerName: 'authorization' as const,
  headerPrefix: 'Bearer ' as const,
};
let context: ServiceCredentialContext;
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
  const pending = await prepareServiceCredential(context, policy);
  ({ secretRef } = await createServiceCredential(context, {
    pendingRef: pending.pendingRef,
    secret,
  }));
});

afterEach(async () => {
  await db.delete(sessions).where(inArray(sessions.id, sessionIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

it('persists immutable nonsecret approvals, waits 24 hours for the key, and finalizes exactly once under a race', async () => {
  const pending = await prepareServiceCredential(context, policy);
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
    'lifetimeHours',
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
      createServiceCredential(context, {
        pendingRef: pending.pendingRef,
        secret,
        ...extra,
      }),
    ).rejects.toThrow('Secret request unavailable');
  }
  expect((await listServiceCredentialApprovals(context)).pending).toEqual([
    pending,
  ]);
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      createServiceCredential(context, {
        pendingRef: pending.pendingRef,
        secret,
      }),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
  const approvals = await listServiceCredentialApprovals(context);
  expect(approvals.pending).toEqual([]);
  expect(approvals.secrets).toHaveLength(2);
  expect(
    approvals.secrets.find((row) => row.secretRef !== secretRef),
  ).toMatchObject({ ...policy, expiresAt: null });
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
  const pending = await prepareServiceCredential(context, policy);
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
      sql`update service_credential_approvals set expires_at = clock_timestamp() - interval '1 second' where id = ${pending.pendingRef}`,
    );
  await expect(
    createServiceCredential(actor, {
      pendingRef: kind === 'unknown' ? randomUUID() : pending.pendingRef,
      secret,
    }),
  ).rejects.toThrow('Secret request unavailable');
});

it('rejects unknown fields and invalid lifetimes without consuming approvals on validation failure', async () => {
  for (const extra of [
    { secret },
    { sessionId: context.sessionId },
    { lifetimeHours: 0 },
    { lifetimeHours: 8761 },
    { lifetimeHours: 1.5 },
    { expiresAt: new Date().toISOString() },
  ]) {
    await expect(
      prepareServiceCredential(context, { ...policy, ...extra }),
    ).rejects.toThrow('Secret request unavailable');
  }
  const pending = await prepareServiceCredential(context, {
    ...policy,
    label: secret,
    lifetimeHours: 720,
  });
  await expect(
    createServiceCredential(context, {
      pendingRef: pending.pendingRef,
      secret,
    }),
  ).rejects.toThrow('Secret request unavailable');
  expect((await listServiceCredentialApprovals(context)).pending).toEqual([
    pending,
  ]);
  const raw = await db.execute(
    sql`select * from service_credential_approvals where id = ${pending.pendingRef}`,
  );
  expect(raw[0]!.consumed_at).toBeNull();
  expect(raw[0]).not.toHaveProperty('value');
  expect(raw[0]).not.toHaveProperty('secret');
});

it('encrypts SQL storage, lists metadata only and wipes ciphertext on revoke', async () => {
  const raw = await db.execute<{ value: string }>(
    sql`select value from service_credentials where id = ${secretRef}`,
  );
  expect(raw[0]!.value).toBeTruthy();
  expect(raw[0]!.value).not.toContain(secret);
  expect(await resolveOwnedServiceCredential(context, secretRef)).toMatchObject(
    {
      secretRef,
      value: secret,
    },
  );
  const listed = await listServiceCredentials(context);
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
  await revokeServiceCredential(context, { secretRef });
  const revoked = await db.execute(
    sql`select value, revoked_at from service_credentials where id = ${secretRef}`,
  );
  expect(revoked[0]).toMatchObject({
    value: null,
    revoked_at: expect.any(String),
  });
  await expect(
    resolveOwnedServiceCredential(context, secretRef),
  ).rejects.toThrow('Secret unavailable');
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
    const pending = await prepareServiceCredential(context, policy);
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
    await expect(prepareServiceCredential(actor, policy)).rejects.toThrow(
      'Secret request unavailable',
    );
    await expect(
      createServiceCredential(actor, {
        pendingRef: pending.pendingRef,
        secret,
      }),
    ).rejects.toThrow('Secret request unavailable');
    await expect(listServiceCredentialApprovals(actor)).rejects.toThrow(
      'Secret request unavailable',
    );
    await expect(listServiceCredentials(actor)).rejects.toThrow(
      'Secret request unavailable',
    );
    await expect(revokeServiceCredential(actor, { secretRef })).rejects.toThrow(
      'Secret request unavailable',
    );
    await expect(
      resolveOwnedServiceCredential(actor, secretRef),
    ).rejects.toThrow('Secret unavailable');
    const raw = await db.execute(
      sql`select value from service_credentials where id = ${secretRef}`,
    );
    expect(raw[0]!.value).toBeTruthy();
  },
);

it('shares an integration across every Session of its owner and rejects other owners and unknown references', async () => {
  const other = { ...context, sessionId: await session(context.userId!) };
  expect(
    (await listServiceCredentials(other)).map((item) => item.secretRef),
  ).toEqual([secretRef]);
  expect((await resolveOwnedServiceCredential(other, secretRef)).value).toBe(
    secret,
  );
  const stranger = await userFactory.create();
  userIds.push(stranger.id);
  const foreign = {
    userId: stranger.id,
    sessionId: await session(stranger.id),
  };
  expect(await listServiceCredentials(foreign)).toEqual([]);
  for (const [actor, ref] of [
    [foreign, secretRef],
    [context, randomUUID()],
  ] as const) {
    await expect(resolveOwnedServiceCredential(actor, ref)).rejects.toThrow(
      'Secret unavailable',
    );
    await expect(
      revokeServiceCredential(actor, { secretRef: ref }),
    ).rejects.toThrow('Secret request unavailable');
  }
  // Revoking from any owned Session retires it everywhere.
  await revokeServiceCredential(other, { secretRef });
  await expect(
    resolveOwnedServiceCredential(context, secretRef),
  ).rejects.toThrow('Secret unavailable');
});

it('keeps integrations until revoked unless a lifetime is set, and manages them from Settings', async () => {
  expect((await listServiceCredentials(context))[0]!.expiresAt).toBeNull();
  const timed = await prepareServiceCredential(context, {
    ...policy,
    label: 'Temporary',
    lifetimeHours: 2,
  });
  expect(timed.lifetimeHours).toBe(2);
  const saved = await createServiceCredential(context, {
    pendingRef: timed.pendingRef,
    secret,
  });
  expect(
    Date.parse(saved.expiresAt!) - Date.parse(saved.createdAt),
  ).toBeGreaterThanOrEqual(2 * 3600_000 - 1000);

  const added = await createIntegration(context.userId!, {
    label: 'From settings',
    origin: 'https://settings.example.com',
    headerName: 'x-api-key',
    headerPrefix: '',
    allowedMethods: ['GET', 'POST'],
    secret,
  });
  expect(added).toMatchObject({
    origin: 'https://settings.example.com',
    allowedMethods: ['GET', 'POST'],
    expiresAt: null,
  });
  await expect(
    createIntegration(context.userId!, {
      label: 'Bad',
      origin: 'http://insecure.example.com',
      headerName: 'authorization',
      headerPrefix: 'Bearer ',
      secret,
    }),
  ).rejects.toThrow('Secret request unavailable');
  await expect(
    createIntegration(context.userId!, {
      label: 'Bad',
      origin: 'https://api.example.com',
      headerName: 'x-api-key',
      headerPrefix: 'Bearer ',
      secret,
    }),
  ).rejects.toThrow('Secret request unavailable');

  // The Session sees what Settings added, and Settings sees what the Session approved.
  expect(
    (await listServiceCredentials(context)).map((item) => item.label).sort(),
  ).toEqual(['From settings', 'Temporary', 'Test credential']);
  expect(
    (await listIntegrations(context.userId!)).map((item) => item.secretRef),
  ).toContain(added.secretRef);
  expect(
    (await resolveOwnedServiceCredential(context, added.secretRef)).value,
  ).toBe(secret);
  const stranger = await userFactory.create();
  userIds.push(stranger.id);
  expect(await listIntegrations(stranger.id)).toEqual([]);
  await expect(
    revokeIntegration(stranger.id, { secretRef: added.secretRef }),
  ).rejects.toThrow('Secret request unavailable');
  await revokeIntegration(context.userId!, { secretRef: added.secretRef });
  await expect(
    resolveOwnedServiceCredential(context, added.secretRef),
  ).rejects.toThrow('Secret unavailable');
});

it('uses SQL expiry to deny decryption', async () => {
  await db.execute(
    sql`update service_credentials set expires_at = clock_timestamp() - interval '1 second' where id = ${secretRef}`,
  );
  await expect(
    resolveOwnedServiceCredential(context, secretRef),
  ).rejects.toThrow('Secret unavailable');
});

it('blocks creation and use after archive while retaining owner list and revoke access', async () => {
  await db
    .update(sessions)
    .set({ archivedAt: new Date() })
    .where(eq(sessions.id, context.sessionId));
  await expect(
    resolveOwnedServiceCredential(context, secretRef),
  ).rejects.toThrow('Secret unavailable');
  await expect(prepareServiceCredential(context, policy)).rejects.toThrow(
    'Secret request unavailable',
  );
  expect(await listServiceCredentials(context)).toHaveLength(1);
  await revokeServiceCredential(context, { secretRef });
  // A revoked integration leaves every listing.
  expect(await listServiceCredentials(context)).toHaveLength(0);
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
      prepareServiceCredential(context, { ...policy, origin }),
    ).rejects.toThrow('Secret request unavailable');
  }
  expect(
    await prepareServiceCredential(context, {
      ...policy,
      origin: 'https://api.github.com:443',
      headerName: 'x-api-key',
      headerPrefix: '',
    }),
  ).toMatchObject({ origin: 'https://api.github.com', headerPrefix: '' });
});
