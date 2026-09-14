import { randomUUID } from 'node:crypto';

import {
  db,
  eq,
  hashSessionEgressSubstitute,
  runFactory,
  sessionEgressSubstitutes,
  sessionEgressWorkloads,
  terminateSessionEgressWorkloadsForRun,
  terminateSessionEgressWorkload,
  taskRuns,
  sessionFactory,
  sessionTasks,
  sessions,
  tasks,
  userFactory,
  users,
  type SessionSecretContext,
} from '@roomote/db/server';
import { RunStatus, type RunTokenContext } from '@roomote/types';
import * as redisModule from '@roomote/redis';
import {
  publishSessionEgressDelivery,
  readSessionEgressDelivery,
} from '../session-egress-delivery';

import {
  authorize,
  issueSubstitutes,
  registerWorkload,
  registerProxyWorkload,
  authorizeProxy,
  renewProxyLease,
} from '../session-egress';
import {
  createSessionSecret,
  prepareSessionSecret,
  listSessionSecretApprovals,
} from '../session-secrets';
import * as safeFetch from '../safe-fetch';

const policy = {
  label: 'Test credential',
  origin: 'https://api.example.com',
  headerName: 'authorization',
  headerPrefix: 'Bearer ',
  allowedMethods: ['GET', 'POST'],
};
const secret = 'Sdk-Test-Credential-123456';
let context: SessionSecretContext;
let runId: number;
let taskId: string;
let connectorIdentity: string;

beforeEach(async () => {
  const owner = await userFactory.create();
  const session = await sessionFactory.create({
    ownerKind: 'user',
    ownerUserId: owner.id,
  });
  context = { userId: owner.id, sessionId: session.id };
  const run = await runFactory.create({
    actingUserId: owner.id,
    status: RunStatus.Running,
  });
  runId = run.id;
  taskId = run.taskId;
  connectorIdentity = randomUUID();
  await db
    .insert(sessionTasks)
    .values({ sessionId: session.id, taskId, origin: 'direct_launch' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(sessions).where(eq(sessions.id, context.sessionId));
  await db.delete(tasks).where(eq(tasks.id, taskId));
  await db.delete(users).where(eq(users.id, context.userId!));
});

it('registers exact prepared GET+POST consent and authorizes both methods without widening it', async () => {
  const pending = await prepareSessionSecret(context, policy);
  expect(pending.allowedMethods).toEqual(['GET', 'POST']);
  const { secretRef } = await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret,
    allowedMethods: pending.allowedMethods,
  });
  const registered = await registerWorkload({
    runId,
    provider: 'docker',
    connectorIdentity,
  });
  expect(registered.substitutes).toEqual([
    expect.objectContaining({ secretRef, allowedMethods: ['GET', 'POST'] }),
  ]);
  for (const method of ['GET', 'POST', 'DELETE']) {
    const result = await authorize({
      workloadId: registered.workloadId,
      connectorIdentity,
      substitute: registered.substitutes[0]!.substitute,
      destination: { host: 'api.example.com', port: 443 },
      method,
      path: '/v1/resource',
    });
    expect(result).toMatchObject(
      method === 'DELETE'
        ? { allowed: false, reason: 'method_not_allowed' }
        : { allowed: true },
    );
  }
});

it('requires matching proxy capability and substitute, without claiming physical-origin binding', async () => {
  const pending = await prepareSessionSecret(context, policy);
  await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret,
    allowedMethods: pending.allowedMethods,
  });
  const first = await registerProxyWorkload({ runId, provider: 'roomote' });
  const other = await runFactory.create({
    actingUserId: context.userId!,
    status: RunStatus.Running,
  });
  try {
    await db.insert(sessionTasks).values({
      sessionId: context.sessionId,
      taskId: other.taskId,
      origin: 'direct_launch',
    });
    const second = await registerProxyWorkload({
      runId: other.id,
      provider: 'roomote',
    });
    const request = {
      admissionMode: 'authenticated_proxy',
      workloadId: first.workloadId,
      proxyCapability: first.proxyCapability,
      substitute: first.substitutes[0]!.substitute,
      destination: { host: 'api.example.com', port: 443 },
      method: 'POST',
      path: '/records',
    };
    expect(await authorizeProxy(request)).toMatchObject({ allowed: true });
    // Copying both credentials replays logical identity A; no physical-origin claim.
    expect(
      await authorizeProxy(JSON.parse(JSON.stringify(request))),
    ).toMatchObject({ allowed: true });
    expect(
      await authorizeProxy({
        ...request,
        proxyCapability: second.proxyCapability,
      }),
    ).toMatchObject({ allowed: false });
    expect(
      await authorizeProxy({
        ...request,
        substitute: second.substitutes[0]!.substitute,
      }),
    ).toMatchObject({ allowed: false });
    expect(
      await authorizeProxy({ ...request, method: 'DELETE' }),
    ).toMatchObject({ allowed: false, reason: 'method_not_allowed' });
    expect(
      await authorizeProxy({
        ...request,
        destination: { host: 'elsewhere.example', port: 443 },
      }),
    ).toMatchObject({ allowed: false, reason: 'destination_mismatch' });
    const [stored] = await db
      .select()
      .from(sessionEgressWorkloads)
      .where(eq(sessionEgressWorkloads.id, first.workloadId));
    expect(JSON.stringify(stored)).not.toContain(first.proxyCapability);
    expect(
      await authorize({
        workloadId: first.workloadId,
        connectorIdentity: stored!.connectorIdentity,
        substitute: first.substitutes[0]!.substitute,
        destination: request.destination,
        method: 'POST',
        path: '/records',
      }),
    ).toMatchObject({ allowed: false });
  } finally {
    await db.delete(tasks).where(eq(tasks.id, other.taskId));
  }
});

it.each(['expiry', 'rotation', 'detach', 'owner', 'terminal'])(
  'invalidates proxy authorization at response/stream time after %s',
  async (mode) => {
    const pending = await prepareSessionSecret(context, policy);
    await createSessionSecret(context, {
      pendingRef: pending.pendingRef,
      secret,
      allowedMethods: pending.allowedMethods,
    });
    const registered = await registerProxyWorkload({
      runId,
      provider: 'roomote',
      capabilitySeconds: 60,
    });
    const request = {
      admissionMode: 'authenticated_proxy',
      workloadId: registered.workloadId,
      proxyCapability: registered.proxyCapability,
      substitute: registered.substitutes[0]!.substitute,
      destination: { host: 'api.example.com', port: 443 },
      method: 'GET',
      path: '/records',
    };
    expect(await authorizeProxy(request)).toMatchObject({
      allowed: true,
      expiresAt: registered.proxyCapabilityExpiresAt,
    });
    if (mode === 'expiry')
      await db
        .update(sessionEgressWorkloads)
        .set({ proxyCapabilityExpiresAt: new Date(0) })
        .where(eq(sessionEgressWorkloads.id, registered.workloadId));
    if (mode === 'rotation')
      await registerProxyWorkload({ runId, provider: 'roomote' });
    if (mode === 'detach')
      await db.delete(sessionTasks).where(eq(sessionTasks.taskId, taskId));
    if (mode === 'owner')
      await db
        .update(sessions)
        .set({ archivedAt: new Date() })
        .where(eq(sessions.id, context.sessionId));
    if (mode === 'terminal')
      await db
        .update(taskRuns)
        .set({ status: RunStatus.Completed })
        .where(eq(taskRuns.id, runId));
    for (const phase of ['response', 'stream'])
      expect(await authorizeProxy({ ...request, phase })).toMatchObject({
        allowed: false,
      });
  },
);

it('requires a matching proxy capability AND substitute, and preserves the distinct connector contract', async () => {
  const pending = await prepareSessionSecret(context, policy);
  await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret,
    allowedMethods: pending.allowedMethods,
  });
  const a = await registerProxyWorkload({
    runId,
    provider: 'roomote',
    capabilitySeconds: 60,
  });
  const request = {
    admissionMode: 'authenticated_proxy' as const,
    workloadId: a.workloadId,
    proxyCapability: a.proxyCapability,
    substitute: a.substitutes[0]!.substitute,
    destination: { host: 'api.example.com', port: 443 },
    method: 'POST',
    path: '/fixture',
  };
  expect(await authorizeProxy(request)).toMatchObject({ allowed: true });
  // Possession is the accepted identity proof: copying this pair is replayable.
  expect(
    await authorizeProxy(JSON.parse(JSON.stringify(request))),
  ).toMatchObject({ allowed: true });
  const [stored] = await db
    .select()
    .from(sessionEgressWorkloads)
    .where(eq(sessionEgressWorkloads.id, a.workloadId));
  expect(JSON.stringify(stored)).not.toContain(a.proxyCapability);
  expect(
    await authorize({
      ...request,
      admissionMode: undefined,
      proxyCapability: undefined,
      connectorIdentity: stored!.connectorIdentity,
    }),
  ).toMatchObject({ allowed: false });
  const second = await runFactory.create({
    actingUserId: context.userId!,
    status: RunStatus.Running,
  });
  try {
    await db.insert(sessionTasks).values({
      sessionId: context.sessionId,
      taskId: second.taskId,
      origin: 'direct_launch',
    });
    const b = await registerProxyWorkload({
      runId: second.id,
      provider: 'roomote',
    });
    expect(
      await authorizeProxy({ ...request, proxyCapability: b.proxyCapability }),
    ).toMatchObject({ allowed: false });
    expect(
      await authorizeProxy({
        ...request,
        substitute: b.substitutes[0]!.substitute,
      }),
    ).toMatchObject({ allowed: false });
    expect(
      await authorizeProxy({
        ...request,
        workloadId: b.workloadId,
        substitute: b.substitutes[0]!.substitute,
      }),
    ).toMatchObject({ allowed: false });
    await db
      .update(sessionEgressWorkloads)
      .set({ proxyCapabilityExpiresAt: new Date(0) })
      .where(eq(sessionEgressWorkloads.id, a.workloadId));
    for (const phase of ['request', 'response', 'stream'])
      expect(await authorizeProxy({ ...request, phase })).toMatchObject({
        allowed: false,
      });
  } finally {
    await db.delete(tasks).where(eq(tasks.id, second.taskId));
  }
});

it('rotates proxy capabilities and substitutes together without widening grants', async () => {
  const pending = await prepareSessionSecret(context, policy);
  await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret,
    allowedMethods: pending.allowedMethods,
  });
  const a = await registerProxyWorkload({ runId, provider: 'roomote' });
  const b = await registerProxyWorkload({ runId, provider: 'roomote' });
  const request = {
    admissionMode: 'authenticated_proxy',
    workloadId: a.workloadId,
    proxyCapability: a.proxyCapability,
    substitute: a.substitutes[0]!.substitute,
    destination: { host: 'api.example.com', port: 443 },
    method: 'GET',
    path: '/fixture',
  };
  expect(b.generation).toBe(a.generation + 1);
  expect(await authorizeProxy(request)).toMatchObject({ allowed: false });
  const fresh = {
    ...request,
    workloadId: b.workloadId,
    proxyCapability: b.proxyCapability,
    substitute: b.substitutes[0]!.substitute,
  };
  expect(await authorizeProxy(fresh)).toMatchObject({
    allowed: true,
    expiresAt: b.proxyCapabilityExpiresAt,
  });
  expect(await authorizeProxy({ ...fresh, method: 'DELETE' })).toMatchObject({
    allowed: false,
    reason: 'method_not_allowed',
  });
  expect(
    await authorizeProxy({
      ...fresh,
      destination: { host: 'elsewhere.example', port: 443 },
    }),
  ).toMatchObject({ allowed: false, reason: 'destination_mismatch' });
  await db
    .update(sessions)
    .set({ archivedAt: new Date() })
    .where(eq(sessions.id, context.sessionId));
  expect(await authorizeProxy(fresh)).toMatchObject({
    allowed: false,
    reason: 'session_unavailable',
  });
});

it('renews only a still-live matching proxy generation and cannot revive an expired capability', async () => {
  const pending = await prepareSessionSecret(context, policy);
  await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret,
    allowedMethods: pending.allowedMethods,
  });
  const registration = await registerProxyWorkload({
    runId,
    provider: 'roomote',
    capabilitySeconds: 60,
  });
  const renewed = await renewProxyLease(registration.workloadId, {
    generation: registration.generation,
  });
  expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(
    Date.parse(registration.proxyCapabilityExpiresAt),
  );
  await expect(
    renewProxyLease(registration.workloadId, {
      generation: registration.generation + 1,
    }),
  ).rejects.toThrow('workload_not_found');
  const request = {
    admissionMode: 'authenticated_proxy',
    workloadId: registration.workloadId,
    proxyCapability: registration.proxyCapability,
    substitute: registration.substitutes[0]!.substitute,
    destination: { host: 'api.example.com', port: 443 },
    method: 'GET',
    path: '/fixture',
  };
  expect(await authorizeProxy(request)).toMatchObject({
    allowed: true,
    expiresAt: renewed.expiresAt,
  });
  await db
    .update(sessionEgressWorkloads)
    .set({ proxyCapabilityExpiresAt: new Date(0) })
    .where(eq(sessionEgressWorkloads.id, registration.workloadId));
  await expect(
    renewProxyLease(registration.workloadId, {
      generation: registration.generation,
    }),
  ).rejects.toThrow('workload_not_found');
  expect(await authorizeProxy(request)).toMatchObject({ allowed: false });
});

it('does not let failed stale delivery terminate a newer proxy generation', async () => {
  const pending = await prepareSessionSecret(context, policy);
  await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret,
    allowedMethods: pending.allowedMethods,
  });
  const older = await registerProxyWorkload({ runId, provider: 'roomote' });
  const current = await registerProxyWorkload({ runId, provider: 'roomote' });
  expect(
    await terminateSessionEgressWorkload(
      older.workloadId,
      'provision_failed',
      older.generation,
    ),
  ).toBe(false);
  expect(
    await authorizeProxy({
      admissionMode: 'authenticated_proxy',
      workloadId: current.workloadId,
      proxyCapability: current.proxyCapability,
      substitute: current.substitutes[0]!.substitute,
      destination: { host: 'api.example.com', port: 443 },
      method: 'GET',
      path: '/fixture',
    }),
  ).toMatchObject({ allowed: true });
});

it('retires the run workload and substitutes together on terminal cleanup', async () => {
  const pending = await prepareSessionSecret(context, policy);
  await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret,
    allowedMethods: pending.allowedMethods,
  });
  const registered = await registerWorkload({
    runId,
    provider: 'docker',
    connectorIdentity,
  });
  await db.transaction(async (tx) => {
    expect(
      await terminateSessionEgressWorkloadsForRun(runId, 'completed', tx),
    ).toEqual([registered.workloadId]);
  });
  const [workload] = await db
    .select({ status: sessionEgressWorkloads.status })
    .from(sessionEgressWorkloads)
    .where(eq(sessionEgressWorkloads.id, registered.workloadId));
  expect(workload?.status).toBe('terminated');
  const issued = await db
    .select({ revokedAt: sessionEgressSubstitutes.revokedAt })
    .from(sessionEgressSubstitutes)
    .where(eq(sessionEgressSubstitutes.workloadId, registered.workloadId));
  expect(issued).toHaveLength(1);
  expect(issued[0]?.revokedAt).not.toBeNull();
});

it.each([
  'owner',
  'user token',
  'other signed user',
  'actor change during cache read',
  'rotation during cache read',
])(
  'delivers verified bootstrap configuration only to the live bound run: %s',
  async (mode) => {
    const pending = await prepareSessionSecret(context, policy);
    await createSessionSecret(context, {
      pendingRef: pending.pendingRef,
      secret,
      allowedMethods: pending.allowedMethods,
    });
    const registered = await registerWorkload({
      runId,
      provider: 'docker',
      connectorIdentity,
    });
    const environment = {
      ROOMOTE_SERVICE_TOKEN_TEST: registered.substitutes[0]!.substitute,
    };
    const nonce = randomUUID();
    const data = new Map<string, string>();
    const fakeRedis = {
      set: vi.fn(async (key: string, value: string) => {
        data.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => {
        if (data.has(key) && mode === 'actor change during cache read') {
          await db
            .update(taskRuns)
            .set({ actingUserId: null })
            .where(eq(taskRuns.id, runId));
        }
        if (data.has(key) && mode === 'rotation during cache read') {
          await registerWorkload({
            runId,
            provider: 'docker',
            connectorIdentity: randomUUID(),
          });
        }
        return data.get(key) ?? null;
      }),
    };
    vi.spyOn(redisModule, 'getRedis').mockReturnValue(
      fakeRedis as unknown as ReturnType<typeof redisModule.getRedis>,
    );
    const auth: RunTokenContext = {
      runId,
      userId: context.userId!,
      principal: 'user',
      tokenType: 'run',
      version: 1,
    };
    expect(await readSessionEgressDelivery(auth, nonce)).toBeNull();
    await publishSessionEgressDelivery(runId, registered, environment, nonce);
    const stored = [...data.values()][0]!;
    expect(stored).not.toContain(environment.ROOMOTE_SERVICE_TOKEN_TEST);
    expect(stored).not.toContain(secret);
    expect(fakeRedis.set.mock.calls[0]).toContain('EX');
    const input =
      mode === 'user token'
        ? { tokenType: 'auth' as const, userId: context.userId!, version: 1 }
        : {
            ...auth,
            ...(mode === 'other signed user' ? { userId: 'wrong-user' } : {}),
          };
    if (mode === 'owner') {
      await expect(
        readSessionEgressDelivery(input, randomUUID()),
      ).resolves.toBeNull();
      await expect(readSessionEgressDelivery(input, nonce)).resolves.toEqual(
        environment,
      );
    } else {
      await expect(readSessionEgressDelivery(input, nonce)).rejects.toThrow(
        'configuration unavailable',
      );
    }
  },
);

it.each([undefined, ['GET'], ['GET', 'HEAD'], ['GET', 'POST', 'DELETE']])(
  'denies omitted or mismatched write consent without consuming the approval: %j',
  async (allowedMethods) => {
    const pending = await prepareSessionSecret(context, policy);
    await expect(
      createSessionSecret(context, {
        pendingRef: pending.pendingRef,
        secret,
        ...(allowedMethods === undefined ? {} : { allowedMethods }),
      }),
    ).rejects.toThrow('Secret request unavailable');
    const approvals = await listSessionSecretApprovals(context);
    expect(approvals.pending).toEqual([pending]);
    expect(approvals.secrets).toEqual([]);
    expect(
      (await registerWorkload({ runId, provider: 'docker', connectorIdentity }))
        .substitutes,
    ).toEqual([]);
  },
);

it.each(['registration', 'late approval'])(
  'recovers policy-withheld substitutes after %s without rotating',
  async (phase) => {
    const input = { runId, provider: 'docker', connectorIdentity };
    const early =
      phase === 'late approval' ? await registerWorkload(input) : null;
    const pending = await prepareSessionSecret(context, policy);
    const { secretRef } = await createSessionSecret(context, {
      pendingRef: pending.pendingRef,
      secret,
      allowedMethods: pending.allowedMethods,
    });
    const realValidator = safeFetch.assertEgressUrlAllowed;
    let blocked = true;
    vi.spyOn(safeFetch, 'assertEgressUrlAllowed').mockImplementation(
      (origin, ...options) => {
        if (blocked && origin === policy.origin)
          throw new Error('Origin policy tightened');
        return realValidator(origin, ...options);
      },
    );
    const registered = early ?? (await registerWorkload(input));
    const withheld = await issueSubstitutes(registered.workloadId);
    expect(registered.substitutes).toEqual([]);
    expect(withheld.substitutes).toEqual([]);
    const hidden = await db
      .select()
      .from(sessionEgressSubstitutes)
      .where(eq(sessionEgressSubstitutes.workloadId, registered.workloadId));

    blocked = false;
    const results = await Promise.all([
      issueSubstitutes(registered.workloadId),
      issueSubstitutes(registered.workloadId),
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        workloadId: registered.workloadId,
        generation: registered.generation,
      });
    const issued = results.flatMap((result) => result.substitutes);
    expect(issued).toEqual([
      expect.objectContaining({ secretRef, origin: policy.origin }),
    ]);
    expect(hidden).toEqual([]);
    const rows = await db
      .select()
      .from(sessionEgressSubstitutes)
      .where(eq(sessionEgressSubstitutes.workloadId, registered.workloadId));
    expect(rows).toEqual([
      expect.objectContaining({
        secretId: secretRef,
        generation: registered.generation,
        tokenHash: hashSessionEgressSubstitute(issued[0]!.substitute),
      }),
    ]);
    const request = {
      workloadId: registered.workloadId,
      connectorIdentity,
      substitute: issued[0]!.substitute,
      destination: { host: 'api.example.com', port: 443 },
      method: 'GET',
      path: '/',
    };
    expect(await authorize(request)).toMatchObject({ allowed: true });
    blocked = true;
    expect(await authorize(request)).toEqual({
      allowed: false,
      reason: 'destination_mismatch',
    });
  },
);

it('withholds newly approved substitutes when origin policy tightens after registration', async () => {
  const registered = await registerWorkload({
    runId,
    provider: 'docker',
    connectorIdentity,
  });
  expect(registered.substitutes).toEqual([]);
  const pending = await prepareSessionSecret(context, policy);
  await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret,
    allowedMethods: pending.allowedMethods,
  });
  const allowed = await prepareSessionSecret(context, {
    ...policy,
    origin: 'https://other.example.com',
  });
  const { secretRef } = await createSessionSecret(context, {
    pendingRef: allowed.pendingRef,
    secret,
    allowedMethods: allowed.allowedMethods,
  });
  const realValidator = safeFetch.assertEgressUrlAllowed;
  vi.spyOn(safeFetch, 'assertEgressUrlAllowed').mockImplementation(
    (origin, ...options) => {
      if (origin === policy.origin) throw new Error('Origin policy tightened');
      return realValidator(origin, ...options);
    },
  );

  const issued = await issueSubstitutes(registered.workloadId);
  expect(issued).toMatchObject({
    workloadId: registered.workloadId,
    generation: registered.generation,
  });
  expect(issued.substitutes).toEqual([
    expect.objectContaining({
      secretRef,
      origin: 'https://other.example.com',
      allowedMethods: ['GET', 'POST'],
    }),
  ]);
  const rotated = await registerWorkload({
    runId,
    provider: 'docker',
    connectorIdentity,
  });
  expect(rotated.substitutes).toEqual([expect.objectContaining({ secretRef })]);
});
