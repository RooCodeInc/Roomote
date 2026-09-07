import {
  RunStatus,
  TaskPayloadKind,
  type RunKind,
  type TaskState,
} from '@roomote/types';

import {
  db,
  eq,
  tasks,
  taskRuns,
  sessions,
  sessionTasks,
  sessionFactory,
  taskFactory,
  syncTaskStateFromRuns,
  deriveTaskStateFromRuns,
} from '../../server';
import type { CreateTaskRun } from '../../types';

const createdTaskIds: string[] = [];
const createdSessionIds: string[] = [];

async function makeTask(state: TaskState = 'active') {
  const task = await taskFactory.create({ state });
  createdTaskIds.push(task.id);
  return task;
}

async function insertRun(params: {
  taskId: string;
  status: RunStatus;
  startedAt?: Date | null;
  kind?: RunKind;
}) {
  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: params.taskId,
      kind: params.kind ?? 'fresh',
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'test/repo',
        description: 'sync-task-state fixture run',
      } as CreateTaskRun['payload'],
      status: params.status,
      startedAt: params.startedAt ?? null,
    })
    .returning();

  if (!run) {
    throw new Error('Failed to insert fixture run');
  }

  return run;
}

async function readTask(taskId: string) {
  const [row] = await db
    .select({ state: tasks.state, updatedAt: tasks.updatedAt })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  if (!row) {
    throw new Error('Task not found');
  }

  return row;
}

afterEach(async () => {
  while (createdTaskIds.length > 0) {
    const taskId = createdTaskIds.pop()!;
    // task_runs.task_id cascades on task delete.
    await db
      .delete(tasks)
      .where(eq(tasks.id, taskId))
      .catch(() => {});
  }
  while (createdSessionIds.length > 0) {
    await db
      .delete(sessions)
      .where(eq(sessions.id, createdSessionIds.pop()!))
      .catch(() => {});
  }
});

describe('deriveTaskStateFromRuns', () => {
  it('returns null when there are no runs', () => {
    expect(deriveTaskStateFromRuns([])).toBeNull();
  });

  it('returns active when any run is non-terminal', () => {
    expect(
      deriveTaskStateFromRuns([
        { id: 1, status: RunStatus.Running, startedAt: new Date() },
      ]),
    ).toBe('active');
  });

  it('treats idle as non-terminal so an idle sibling keeps the task active', () => {
    expect(
      deriveTaskStateFromRuns([
        { id: 1, status: RunStatus.Completed, startedAt: new Date() },
        { id: 2, status: RunStatus.Idle, startedAt: new Date() },
      ]),
    ).toBe('active');
  });

  it('lets an earlier completed run beat a never-started canceled resume', () => {
    expect(
      deriveTaskStateFromRuns([
        { id: 1, status: RunStatus.Completed, startedAt: new Date() },
        // Higher id but never started (bootstrap-failed resume) -> deprioritized.
        { id: 2, status: RunStatus.Canceled, startedAt: null },
      ]),
    ).toBe('completed');
  });

  it('maps an only-run cancel-before-start to canceled', () => {
    expect(
      deriveTaskStateFromRuns([
        { id: 1, status: RunStatus.Canceled, startedAt: null },
      ]),
    ).toBe('canceled');
  });

  it('maps an only failed run to failed', () => {
    expect(
      deriveTaskStateFromRuns([
        { id: 1, status: RunStatus.Failed, startedAt: new Date() },
      ]),
    ).toBe('failed');
  });

  it('prefers the latest progressed terminal run among siblings', () => {
    expect(
      deriveTaskStateFromRuns([
        { id: 1, status: RunStatus.Completed, startedAt: new Date() },
        { id: 2, status: RunStatus.Failed, startedAt: new Date() },
      ]),
    ).toBe('failed');
  });
});

describe('syncTaskStateFromRuns', () => {
  it('marks an only-child Session ready when sleep completion settles its task', async () => {
    const task = await makeTask('active');
    const run = await insertRun({
      taskId: task.id,
      status: RunStatus.Idle,
      startedAt: new Date(),
    });
    const session = await sessionFactory.create({ cachedStatus: 'active' });
    createdSessionIds.push(session.id);
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });

    await db.transaction(async (tx) => {
      await tx
        .update(taskRuns)
        .set({ status: RunStatus.Completed })
        .where(eq(taskRuns.id, run.id));
      await syncTaskStateFromRuns(tx, task.id);
    });

    const [updated] = await db
      .select({ cachedStatus: sessions.cachedStatus })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(updated?.cachedStatus).toBe('ready');
  });

  it('keeps a Session active when another child task is still active', async () => {
    const sleepingTask = await makeTask('active');
    const siblingTask = await makeTask('active');
    const run = await insertRun({
      taskId: sleepingTask.id,
      status: RunStatus.Idle,
      startedAt: new Date(),
    });
    await insertRun({
      taskId: siblingTask.id,
      status: RunStatus.Running,
      startedAt: new Date(),
    });
    const session = await sessionFactory.create({ cachedStatus: 'active' });
    createdSessionIds.push(session.id);
    await db.insert(sessionTasks).values([
      {
        sessionId: session.id,
        taskId: sleepingTask.id,
        origin: 'direct_launch',
      },
      {
        sessionId: session.id,
        taskId: siblingTask.id,
        origin: 'follow_up',
      },
    ]);

    await db.transaction(async (tx) => {
      await tx
        .update(taskRuns)
        .set({ status: RunStatus.Completed })
        .where(eq(taskRuns.id, run.id));
      await syncTaskStateFromRuns(tx, sleepingTask.id);
    });

    const [updated] = await db
      .select({ cachedStatus: sessions.cachedStatus })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(updated?.cachedStatus).toBe('active');
  });

  it('repairs a stale active task when its runs have completed', async () => {
    const task = await makeTask('active');
    await insertRun({
      taskId: task.id,
      status: RunStatus.Completed,
      startedAt: new Date(),
    });

    await syncTaskStateFromRuns(db, task.id);

    expect((await readTask(task.id)).state).toBe('completed');
  });

  it('keeps the task active when an idle sibling outlives a completed run', async () => {
    const task = await makeTask('completed');
    await insertRun({
      taskId: task.id,
      status: RunStatus.Completed,
      startedAt: new Date(),
    });
    await insertRun({
      taskId: task.id,
      status: RunStatus.Idle,
      startedAt: new Date(),
    });

    await syncTaskStateFromRuns(db, task.id);

    expect((await readTask(task.id)).state).toBe('active');
  });

  it('preserves completed when a bootstrap-failed resume is canceled before start', async () => {
    const task = await makeTask('completed');
    await insertRun({
      taskId: task.id,
      status: RunStatus.Completed,
      startedAt: new Date(),
    });
    // The resume never started (canceled at/before dequeue on bootstrap fail).
    await insertRun({
      taskId: task.id,
      status: RunStatus.Canceled,
      startedAt: null,
      kind: 'resume',
    });

    await syncTaskStateFromRuns(db, task.id);

    expect((await readTask(task.id)).state).toBe('completed');
  });

  it('resolves an only-run cancel-before-start to canceled', async () => {
    const task = await makeTask('active');
    await insertRun({
      taskId: task.id,
      status: RunStatus.Canceled,
      startedAt: null,
    });

    await syncTaskStateFromRuns(db, task.id);

    expect((await readTask(task.id)).state).toBe('canceled');
  });

  it('does not write when the derived state is unchanged', async () => {
    const task = await makeTask('active');
    await insertRun({ taskId: task.id, status: RunStatus.Pending });

    const before = await readTask(task.id);
    await syncTaskStateFromRuns(db, task.id);
    const after = await readTask(task.id);

    expect(after.state).toBe('active');
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('is a no-op when the task has no runs', async () => {
    const task = await makeTask('active');

    const before = await readTask(task.id);
    await syncTaskStateFromRuns(db, task.id);
    const after = await readTask(task.id);

    expect(after.state).toBe('active');
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});
