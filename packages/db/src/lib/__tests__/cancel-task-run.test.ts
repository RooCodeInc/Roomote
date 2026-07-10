// Real-DB coverage for the shared pre-sandbox direct cancel. This helper
// backs both the stop-task fallback and the work-item launch surfaces'
// orphaned-run cleanup, so its guards (no sandbox attached, not already
// terminal) and its task-state re-derivation are load-bearing.

import { RunStatus, TaskPayloadKind } from '@roomote/types';

import {
  db,
  eq,
  tasks,
  taskRuns,
  taskFactory,
  cancelTaskRunDirect,
} from '../../server';
import type { CreateTaskRun } from '../../types';

const createdTaskIds: string[] = [];

async function makeTask() {
  const task = await taskFactory.create({ state: 'active' });
  createdTaskIds.push(task.id);
  return task;
}

async function insertRun(params: {
  taskId: string;
  status: RunStatus;
  sandboxServerUrl?: string | null;
}) {
  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: params.taskId,
      kind: 'fresh',
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'test/repo',
        description: 'cancel-task-run fixture run',
      } as CreateTaskRun['payload'],
      status: params.status,
      sandboxServerUrl: params.sandboxServerUrl ?? null,
    })
    .returning();

  if (!run) {
    throw new Error('Failed to insert fixture run');
  }

  return run;
}

async function readRun(runId: number) {
  const [row] = await db
    .select({
      status: taskRuns.status,
      canceledAt: taskRuns.canceledAt,
      error: taskRuns.error,
    })
    .from(taskRuns)
    .where(eq(taskRuns.id, runId));

  if (!row) {
    throw new Error('Run not found');
  }

  return row;
}

async function readTaskState(taskId: string) {
  const [row] = await db
    .select({ state: tasks.state })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  return row?.state;
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
});

describe('cancelTaskRunDirect', () => {
  it('cancels a pending pre-sandbox run, records the error, and resolves the task state', async () => {
    const task = await makeTask();
    const run = await insertRun({
      taskId: task.id,
      status: RunStatus.Pending,
    });

    const canceled = await cancelTaskRunDirect({
      runId: run.id,
      error: 'Canceled: work-item launch finalize lost the claim fencing guard',
    });

    expect(canceled).toBe(true);
    const row = await readRun(run.id);
    expect(row.status).toBe(RunStatus.Canceled);
    expect(row.canceledAt).toBeInstanceOf(Date);
    expect(row.error).toBe(
      'Canceled: work-item launch finalize lost the claim fencing guard',
    );
    // The only run is canceled before start, so the derived task state
    // resolves to canceled (via the shared syncTaskStateFromRuns).
    expect(await readTaskState(task.id)).toBe('canceled');
  });

  it('does not touch a run that already attached a sandbox', async () => {
    const task = await makeTask();
    const run = await insertRun({
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.test',
    });

    const canceled = await cancelTaskRunDirect({ runId: run.id });

    expect(canceled).toBe(false);
    expect((await readRun(run.id)).status).toBe(RunStatus.Running);
    expect(await readTaskState(task.id)).toBe('active');
  });

  it('does not touch a run that is already terminal', async () => {
    const task = await makeTask();
    const run = await insertRun({
      taskId: task.id,
      status: RunStatus.Completed,
    });

    const canceled = await cancelTaskRunDirect({ runId: run.id });

    expect(canceled).toBe(false);
    expect((await readRun(run.id)).status).toBe(RunStatus.Completed);
  });
});
