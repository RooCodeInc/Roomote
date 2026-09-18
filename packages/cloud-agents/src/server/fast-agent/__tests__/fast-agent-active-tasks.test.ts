import { db, inArray, taskFactory, taskRuns, tasks } from '@roomote/db/server';
import {
  RunStatus,
  TaskPayloadKind,
  type ComputeProvider,
  type FastAgentParent,
} from '@roomote/types';

import { getActiveFastAgentTasks } from '../fast-agent-session';

const SESSION_ID = '7cc5bc38-9edc-4cb0-9fde-f6e44b32d66e';
const OTHER_SESSION_ID = 'c1370cca-235f-43bf-9c26-e6f71f3ce2cc';
const createdTaskIds: string[] = [];

async function createTask(title: string, deletedAt: Date | null = null) {
  const task = await taskFactory.create({ title, deletedAt });
  createdTaskIds.push(task.id);
  return task;
}

async function createRun(input: {
  taskId: string;
  status: RunStatus;
  createdAt: Date;
  canceledAt?: Date;
  fastAgentSessionId?: string;
  fastAgentParent?: FastAgentParent;
  snapshotId?: string;
  snapshotCreatedAt?: Date;
  snapshotFailedAt?: Date;
  vendor?: ComputeProvider;
}) {
  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: input.taskId,
      kind: 'fresh',
      payloadKind: TaskPayloadKind.StandardTask,
      status: input.status,
      createdAt: input.createdAt,
      canceledAt: input.canceledAt,
      payload: {
        repo: 'acme/widgets',
        description: 'Test Fast session task',
        ...(input.fastAgentSessionId
          ? { fastAgentSessionId: input.fastAgentSessionId }
          : {}),
        ...(input.fastAgentParent
          ? { fastAgentParent: input.fastAgentParent }
          : {}),
      },
      snapshotId: input.snapshotId,
      snapshotCreatedAt: input.snapshotCreatedAt,
      snapshotFailedAt: input.snapshotFailedAt,
      vendor: input.vendor,
    })
    .returning();

  if (!run) {
    throw new Error('Failed to create Fast session test run.');
  }

  return run;
}

afterEach(async () => {
  if (createdTaskIds.length === 0) {
    return;
  }

  await db.delete(taskRuns).where(inArray(taskRuns.taskId, createdTaskIds));
  await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  createdTaskIds.length = 0;
});

describe('getActiveFastAgentTasks', () => {
  it('returns active tasks whose newest run is active', async () => {
    const docsTask = await createTask('Update docs');
    const apiTask = await createTask('Fix API');
    const settledTask = await createTask('Settled restart');
    const canceledTask = await createTask('Canceled task');
    const canceledSnapshotTask = await createTask('Canceled snapshot task');
    const failedSnapshotTask = await createTask('Failed snapshot task');
    const expiredTask = await createTask('Expired task');
    const oldRoomoteTask = await createTask('Old Roomote snapshot');
    const otherSessionTask = await createTask('Other session');
    const deletedTask = await createTask(
      'Deleted task',
      new Date('2026-08-17T00:00:00Z'),
    );

    await createRun({
      taskId: docsTask.id,
      status: RunStatus.Running,
      createdAt: new Date('2026-08-17T00:06:00Z'),
      fastAgentSessionId: SESSION_ID,
    });
    await createRun({
      taskId: apiTask.id,
      status: RunStatus.Processing,
      createdAt: new Date('2026-08-17T00:05:00Z'),
      fastAgentSessionId: SESSION_ID,
    });
    await createRun({
      taskId: apiTask.id,
      status: RunStatus.Pending,
      createdAt: new Date('2026-08-17T00:04:00Z'),
      fastAgentSessionId: SESSION_ID,
    });
    await createRun({
      taskId: settledTask.id,
      status: RunStatus.Completed,
      createdAt: new Date('2026-08-17T00:03:00Z'),
      fastAgentSessionId: SESSION_ID,
      snapshotId: 'snapshot-settled',
      snapshotCreatedAt: new Date(),
    });
    await createRun({
      taskId: settledTask.id,
      status: RunStatus.Idle,
      createdAt: new Date('2026-08-17T00:02:00Z'),
      fastAgentSessionId: SESSION_ID,
    });
    await createRun({
      taskId: expiredTask.id,
      status: RunStatus.Completed,
      createdAt: new Date('2026-08-17T00:00:30Z'),
      fastAgentSessionId: SESSION_ID,
      snapshotId: 'snapshot-expired',
      snapshotCreatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    await createRun({
      taskId: oldRoomoteTask.id,
      status: RunStatus.Completed,
      createdAt: new Date('2026-08-17T00:02:30Z'),
      fastAgentSessionId: SESSION_ID,
      snapshotId: 'snapshot-old-roomote',
      snapshotCreatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      vendor: 'roomote',
    });
    await createRun({
      taskId: canceledTask.id,
      status: RunStatus.Running,
      createdAt: new Date('2026-08-17T00:01:00Z'),
      canceledAt: new Date('2026-08-17T00:01:30Z'),
      fastAgentSessionId: SESSION_ID,
    });
    await createRun({
      taskId: canceledSnapshotTask.id,
      status: RunStatus.Completed,
      createdAt: new Date('2026-08-17T00:00:50Z'),
      canceledAt: new Date('2026-08-17T00:01:00Z'),
      fastAgentSessionId: SESSION_ID,
      snapshotId: 'snapshot-canceled',
      snapshotCreatedAt: new Date(),
    });
    await createRun({
      taskId: failedSnapshotTask.id,
      status: RunStatus.Completed,
      createdAt: new Date('2026-08-17T00:00:40Z'),
      fastAgentSessionId: SESSION_ID,
      snapshotId: 'snapshot-failed',
      snapshotCreatedAt: new Date(),
      snapshotFailedAt: new Date(),
    });
    await createRun({
      taskId: otherSessionTask.id,
      status: RunStatus.Running,
      createdAt: new Date('2026-08-17T00:08:00Z'),
      fastAgentSessionId: OTHER_SESSION_ID,
    });
    await createRun({
      taskId: deletedTask.id,
      status: RunStatus.Running,
      createdAt: new Date('2026-08-17T00:07:00Z'),
      fastAgentSessionId: SESSION_ID,
    });

    await expect(getActiveFastAgentTasks(SESSION_ID)).resolves.toEqual([
      {
        taskId: docsTask.id,
        title: 'Update docs',
        status: RunStatus.Running,
      },
      {
        taskId: apiTask.id,
        title: 'Fix API',
        status: RunStatus.Processing,
      },
      {
        taskId: settledTask.id,
        title: 'Settled restart',
        status: RunStatus.Completed,
      },
      {
        taskId: oldRoomoteTask.id,
        title: 'Old Roomote snapshot',
        status: RunStatus.Completed,
      },
    ]);
  });

  it('uses only the provider-neutral Fast session link', async () => {
    const canonicalTask = await createTask('Canonical session task');
    const parentOnlyTask = await createTask('Parent-only task');

    const canonicalRun = await createRun({
      taskId: canonicalTask.id,
      status: RunStatus.Running,
      createdAt: new Date('2026-08-17T00:02:00Z'),
      fastAgentSessionId: SESSION_ID,
    });
    await createRun({
      taskId: parentOnlyTask.id,
      status: RunStatus.Running,
      createdAt: new Date('2026-08-17T00:01:00Z'),
      fastAgentParent: {
        sessionId: SESSION_ID,
        conversation: {
          surface: 'slack',
          workspaceId: 'T123',
          conversationId: '111.222',
          replyTarget: { channelId: 'C123', threadId: '111.222' },
        },
      },
    });

    expect(canonicalRun.fastAgentSessionId).toBe(SESSION_ID);
    await expect(getActiveFastAgentTasks(SESSION_ID)).resolves.toEqual([
      {
        taskId: canonicalTask.id,
        title: 'Canonical session task',
        status: RunStatus.Running,
      },
    ]);
  });
});
