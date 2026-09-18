import { randomUUID } from 'node:crypto';

import {
  brainMemoryEvents,
  db,
  eq,
  inArray,
  repositories,
  repositoryFactory,
  taskFactory,
  taskPullRequests,
  taskRuns,
  tasks,
  userFactory,
  users,
  settleBrainMemoryEvent,
  type CreateTaskRun,
} from '@roomote/db/server';
import {
  RunStatus,
  TaskPayloadKind,
  sourceControlProviders,
} from '@roomote/types';

import { updateTaskPrStatus } from '../update-task-pr-status';

vi.mock('../../task-runs/enqueue-sleep', () => ({
  enqueueTaskSleep: vi.fn(),
}));
vi.mock('@roomote/telemetry/server', () => ({
  captureActivationPrMerged: vi.fn(),
}));

const taskIds: string[] = [];
const repositoryIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  if (taskIds.length > 0) {
    await db.delete(tasks).where(inArray(tasks.id, taskIds.splice(0)));
  }
  if (repositoryIds.length)
    await db
      .delete(repositories)
      .where(inArray(repositories.id, repositoryIds.splice(0)));
  if (userIds.length)
    await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

async function createAssociation(
  repository: string,
  host: string | null,
  overrides: Partial<typeof taskPullRequests.$inferInsert> = {},
) {
  const task = await taskFactory.create({ state: 'active' });
  taskIds.push(task.id);
  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: task.id,
      kind: 'fresh',
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: repository,
        description: 'PR outcome isolation regression',
      } as CreateTaskRun['payload'],
      status: RunStatus.Completed,
      completedAt: new Date(),
    })
    .returning();
  const [pr] = await db
    .insert(taskPullRequests)
    .values({
      taskId: task.id,
      sourceControlProvider: 'gitea',
      host,
      repository,
      prNumber: 42,
      prUrl: `https://${host}/${repository}/pulls/42`,
      status: 'open',
      ...overrides,
    })
    .returning();
  await db.insert(brainMemoryEvents).values({
    runId: run!.id,
    status: 'done',
    agentSummary: `Original summary for ${host}`,
  });
  return { task, run: run!, pr: pr! };
}

async function readState(
  fixture: Awaited<ReturnType<typeof createAssociation>>,
) {
  const pr = await db.query.taskPullRequests.findFirst({
    where: eq(taskPullRequests.id, fixture.pr.id),
  });
  const event = await db.query.brainMemoryEvents.findFirst({
    where: eq(brainMemoryEvents.runId, fixture.run.id),
  });
  return { status: pr!.status, event: event! };
}

it('does not close or requeue memories for the same PR reference on another host', async () => {
  const repository = `outcome-${randomUUID()}/repo`;
  const target = await createAssociation(repository, 'a.example');
  const other = await createAssociation(repository, 'b.example');

  await updateTaskPrStatus('gitea', repository, 42, 'closed', {
    host: 'a.example',
  });

  const rows = await db
    .select({ host: taskPullRequests.host, status: taskPullRequests.status })
    .from(taskPullRequests)
    .where(eq(taskPullRequests.repository, repository))
    .orderBy(taskPullRequests.host);
  const events = await db
    .select({
      runId: brainMemoryEvents.runId,
      status: brainMemoryEvents.status,
    })
    .from(brainMemoryEvents)
    .where(inArray(brainMemoryEvents.runId, [target.run.id, other.run.id]))
    .orderBy(brainMemoryEvents.runId);

  expect.soft(rows).toEqual([
    { host: 'a.example', status: 'closed' },
    { host: 'b.example', status: 'open' },
  ]);
  expect.soft(events).toEqual([
    { runId: target.run.id, status: 'pending' },
    { runId: other.run.id, status: 'done' },
  ]);
});

it.each(sourceControlProviders)(
  'isolates %s provider, repository, number and host through normal outcomes',
  async (provider) => {
    const repository = `outcome-${randomUUID()}/repo`;
    const target = await createAssociation(repository, 'a.example', {
      sourceControlProvider: provider,
    });
    const controls = await Promise.all([
      createAssociation(repository, 'b.example', {
        sourceControlProvider: provider,
      }),
      createAssociation(repository, 'a.example', {
        sourceControlProvider: provider === 'gitea' ? 'gitlab' : 'gitea',
      }),
      createAssociation(`${repository}-other`, 'a.example', {
        sourceControlProvider: provider,
      }),
      createAssociation(repository, 'a.example', {
        sourceControlProvider: provider,
        prNumber: 43,
      }),
    ]);
    const original = await readState(target);
    for (const status of ['draft', 'open', 'closed', 'merged'] as const) {
      await updateTaskPrStatus(provider, repository, 42, status, {
        host: 'a.example',
      });
      const state = await readState(target);
      expect(state.status).toBe(status);
      expect(state.event.status).toBe(
        status === 'closed' || status === 'merged' ? 'pending' : 'done',
      );
      expect(state.event.agentSummary).toBe(original.event.agentSummary);
      for (const control of controls) {
        expect(await readState(control)).toMatchObject({
          status: 'open',
          event: { status: 'done', revision: 0 },
        });
      }
    }
    const merged = await readState(target);
    await updateTaskPrStatus(provider, repository, 42, 'merged', {
      host: 'a.example',
    });
    expect(await readState(target)).toEqual(merged);
  },
);

it.each([
  [' A.EXAMPLE:443 ', 'a.example'],
  ['a.example:8443', 'A.EXAMPLE:8443'],
])(
  'normalizes host %s against %s without dropping nondefault ports',
  async (incoming, stored) => {
    const repository = `outcome-${randomUUID()}/repo`;
    const target = await createAssociation(repository, stored);
    const other = await createAssociation(repository, 'a.example:9443');
    await updateTaskPrStatus('gitea', repository, 42, 'closed', {
      host: incoming,
    });
    expect(await readState(target)).toMatchObject({
      status: 'closed',
      event: { status: 'pending' },
    });
    expect(await readState(other)).toMatchObject({
      status: 'open',
      event: { status: 'done' },
    });
  },
);

it.each([null, undefined, '', 'a.example/path', 'user@a.example'])(
  'fails closed for missing or invalid incoming host %s',
  async (host) => {
    const repository = `outcome-${randomUUID()}/repo`;
    const target = await createAssociation(repository, 'a.example');
    const original = await readState(target);
    await updateTaskPrStatus('gitea', repository, 42, 'closed', { host });
    expect(await readState(target)).toEqual(original);
  },
);

it('uses legacy absolute PR URL provenance and skips unknown or malformed provenance', async () => {
  const repository = `outcome-${randomUUID()}/repo`;
  const target = await createAssociation(repository, null, {
    prUrl: `https://A.EXAMPLE/${repository}/pulls/42`,
  });
  const controls = await Promise.all([
    createAssociation(repository, null, {
      prUrl: `https://b.example/${repository}/pulls/42`,
    }),
    createAssociation(repository, null, { prUrl: '/relative/pulls/42' }),
    createAssociation(repository, null, { prUrl: 'not a URL' }),
    createAssociation(repository, null, {
      prUrl: `ftp://a.example/${repository}/pulls/42`,
    }),
    createAssociation(repository, 'invalid/path', {
      prUrl: `https://a.example/${repository}/pulls/42`,
    }),
  ]);
  await updateTaskPrStatus('gitea', repository, 42, 'closed', {
    host: 'a.example',
  });
  expect(await readState(target)).toMatchObject({
    status: 'closed',
    event: { status: 'pending' },
  });
  for (const control of controls)
    expect(await readState(control)).toMatchObject({
      status: 'open',
      event: { status: 'done' },
    });
});

it('uses linked repository identity for legacy rows and rejects a different repository ID', async () => {
  const repository = `outcome-${randomUUID()}/repo`;
  const user = await userFactory.create();
  userIds.push(user.id);
  const a = await repositoryFactory.create({
    sourceControlProvider: 'gitea',
    host: 'a.example',
    fullName: repository,
    linkedByUserId: user.id,
  });
  const b = await repositoryFactory.create({
    sourceControlProvider: 'gitea',
    host: 'b.example',
    fullName: repository,
    linkedByUserId: user.id,
  });
  repositoryIds.push(a.id, b.id);
  const target = await createAssociation(repository, null, {
    repositoryId: a.id,
    prUrl: '/legacy/42',
  });
  const other = await createAssociation(repository, null, {
    repositoryId: b.id,
    prUrl: '/legacy/42',
  });
  await updateTaskPrStatus('gitea', repository, 42, 'closed', {
    host: 'a.example',
  });
  expect(await readState(target)).toMatchObject({
    status: 'closed',
    event: { status: 'pending' },
  });
  expect(await readState(other)).toMatchObject({
    status: 'open',
    event: { status: 'done' },
  });
  await updateTaskPrStatus('gitea', repository, 42, 'merged', {
    host: 'a.example',
    repositoryId: b.id,
  });
  expect(await readState(target)).toMatchObject({ status: 'closed' });
  expect(await readState(other)).toMatchObject({ status: 'open' });
  await updateTaskPrStatus('gitea', repository, 42, 'closed', {
    host: null,
    repositoryId: b.id,
  });
  expect(await readState(other)).toMatchObject({
    status: 'closed',
    event: { status: 'pending' },
  });
});

it('preserves the in-flight writer and fences recovery without changing the other host', async () => {
  const repository = `outcome-${randomUUID()}/repo`;
  const target = await createAssociation(repository, 'a.example');
  const other = await createAssociation(repository, 'b.example');
  await db
    .update(brainMemoryEvents)
    .set({ status: 'processing', attempts: 2 })
    .where(eq(brainMemoryEvents.runId, target.run.id));
  const before = await readState(target);
  await updateTaskPrStatus('gitea', repository, 42, 'closed', {
    host: 'a.example',
  });
  const changed = await readState(target);
  expect(changed.event).toMatchObject({
    status: 'processing',
    attempts: 2,
    revision: before.event.revision + 1,
    agentSummary: before.event.agentSummary,
  });
  await updateTaskPrStatus('gitea', repository, 42, 'closed', {
    host: 'a.example',
  });
  expect(await readState(target)).toEqual(changed);
  expect(
    await settleBrainMemoryEvent(
      db,
      before.event.id,
      before.event.revision,
      'done',
    ),
  ).toBe('superseded');
  expect((await readState(target)).event.status).toBe('pending');
  expect(await readState(other)).toMatchObject({
    status: 'open',
    event: { status: 'done' },
  });
});
