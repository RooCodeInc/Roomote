import { randomUUID } from 'node:crypto';

import {
  db,
  eq,
  hashSessionEgressSubstitute,
  runFactory,
  sessionEgressSubstitutes,
  sessionEgressWorkloads,
  terminateSessionEgressWorkloadsForRun,
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
