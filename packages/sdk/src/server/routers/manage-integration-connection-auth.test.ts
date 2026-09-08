import {
  db,
  eq,
  runFactory,
  taskFactory,
  taskRuns,
  userFactory,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

const { manage } = vi.hoisted(() => ({
  manage: vi.fn(async () => ({ state: 'saved' })),
}));
vi.mock('../lib/manage-integration-connection', () => ({
  manageIntegrationConnection: manage,
}));
import { mcpConnectionsRouter } from './mcp-connections';

beforeEach(() => vi.clearAllMocks());

it('enforces persisted admin role and deletion state', async () => {
  for (const values of [
    { role: 'admin' as const },
    { role: 'member' as const },
    { role: 'admin' as const, deletedAt: new Date() },
  ]) {
    const user = await userFactory.create(values);
    const caller = mcpConnectionsRouter.createCaller({
      auth: { userId: user.id, tokenType: 'auth', version: 1 },
    });
    if (values.role === 'admin' && !values.deletedAt) {
      await expect(
        caller.manageConnection({ action: 'list' }),
      ).resolves.toEqual({ state: 'saved' });
    } else {
      await expect(
        caller.manageConnection({ action: 'list' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  }
  expect(manage).toHaveBeenCalledTimes(1);
});

it('rechecks the persisted live actor on every run request and rejects deployment principals', async () => {
  const admin = await userFactory.create({ role: 'admin' });
  const member = await userFactory.create({ role: 'member' });
  const task = await taskFactory.create({ initiatorUserId: admin.id });
  const run = await runFactory.create({
    taskId: task.id,
    actingUserId: member.id,
    payloadKind: TaskPayloadKind.StandardTask,
  });
  const auth = {
    tokenType: 'run' as const,
    principal: 'user' as const,
    userId: admin.id,
    runId: run.id,
    version: 1,
  };
  const caller = mcpConnectionsRouter.createCaller({ auth });
  await expect(
    caller.manageConnection({ action: 'list' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await db
    .update(taskRuns)
    .set({ actingUserId: admin.id })
    .where(eq(taskRuns.id, run.id));
  await expect(caller.manageConnection({ action: 'list' })).resolves.toEqual({
    state: 'saved',
  });
  expect(manage).toHaveBeenCalledWith(
    { userId: admin.id, isAdmin: true },
    { action: 'list' },
  );
  const service = mcpConnectionsRouter.createCaller({
    auth: { ...auth, principal: 'deployment', userId: null },
  });
  await expect(
    service.manageConnection({ action: 'list' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await db
    .update(taskRuns)
    .set({ actingUserId: null })
    .where(eq(taskRuns.id, run.id));
  await expect(
    caller.manageConnection({ action: 'list' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(manage).toHaveBeenCalledTimes(1);
});
