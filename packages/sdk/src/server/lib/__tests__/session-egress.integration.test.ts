import { randomUUID } from 'node:crypto';

import {
  db,
  eq,
  runFactory,
  sessionFactory,
  sessionTasks,
  sessions,
  tasks,
  userFactory,
  users,
  type SessionSecretContext,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

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
