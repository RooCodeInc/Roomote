import { TaskPayloadKind } from '@roomote/types';
import {
  taskRuns,
  db,
  eq,
  markTaskStartParallelCountEndedAt,
  recordTaskStartParallelCount,
  taskFactory,
  taskStartParallelCounts,
  userFactory,
  runFactory,
  tasks,
} from '../../server';

const TEST_USER_ID = 'user_test_task_start_parallel_counts';
const TEST_TASK_ID = 'task_test_task_start_parallel_counts';
let testRunId: number;

async function cleanup() {
  await db
    .delete(taskStartParallelCounts)
    .where(eq(taskStartParallelCounts.runId, testRunId ?? -1))
    .catch(() => {});
  await db
    .delete(taskRuns)
    .where(eq(taskRuns.id, testRunId ?? -1))
    .catch(() => {});
  await db
    .delete(tasks)
    .where(eq(tasks.id, TEST_TASK_ID))
    .catch(() => {});
}

describe('task start parallel count helpers', () => {
  beforeEach(async () => {
    await cleanup();
    testRunId = -1;
    await userFactory.create({ id: TEST_USER_ID }).catch(() => {});
    await taskFactory.create({
      id: TEST_TASK_ID,
      initiatorUserId: TEST_USER_ID,
      timestamp: 1_700_000_000,
      activityAt: 1_700_000_000,
    });
    const taskRun = await runFactory.create({
      actingUserId: TEST_USER_ID,
      taskId: TEST_TASK_ID,
    });
    testRunId = taskRun.id;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('records startedAt and updates endedAt for the run log', async () => {
    const startedAt = new Date('2099-05-21T12:00:00.000Z');
    const endedAt = new Date('2099-05-21T12:34:56.000Z');

    await db.transaction(async (tx) => {
      await recordTaskStartParallelCount(tx, {
        runId: testRunId,
        payloadKind: TaskPayloadKind.StandardTask,
        taskId: TEST_TASK_ID,
        startedAt,
      });

      await markTaskStartParallelCountEndedAt(tx, {
        runId: testRunId,
        endedAt,
      });
    });

    const [log] = await db
      .select({
        startedAt: taskStartParallelCounts.startedAt,
        endedAt: taskStartParallelCounts.endedAt,
        payloadKind: taskStartParallelCounts.payloadKind,
        parallelCount: taskStartParallelCounts.parallelCount,
      })
      .from(taskStartParallelCounts)
      .where(eq(taskStartParallelCounts.runId, testRunId));

    expect(log).toEqual({
      startedAt,
      endedAt,
      payloadKind: TaskPayloadKind.StandardTask,
      parallelCount: 1,
    });
  });

  it('does not overwrite an existing endedAt timestamp', async () => {
    const startedAt = new Date('2026-05-21T12:00:00.000Z');
    const firstEndedAt = new Date('2026-05-21T12:34:56.000Z');
    const secondEndedAt = new Date('2026-05-21T12:45:00.000Z');

    await db.transaction(async (tx) => {
      await recordTaskStartParallelCount(tx, {
        runId: testRunId,
        payloadKind: TaskPayloadKind.StandardTask,
        taskId: TEST_TASK_ID,
        startedAt,
      });

      await markTaskStartParallelCountEndedAt(tx, {
        runId: testRunId,
        endedAt: firstEndedAt,
      });

      await markTaskStartParallelCountEndedAt(tx, {
        runId: testRunId,
        endedAt: secondEndedAt,
      });
    });

    const [log] = await db
      .select({
        endedAt: taskStartParallelCounts.endedAt,
      })
      .from(taskStartParallelCounts)
      .where(eq(taskStartParallelCounts.runId, testRunId));

    expect(log?.endedAt).toEqual(firstEndedAt);
  });

  it('keeps the run log after the task is soft-deleted', async () => {
    const startedAt = new Date('2026-05-21T12:00:00.000Z');

    await db.transaction(async (tx) => {
      await recordTaskStartParallelCount(tx, {
        runId: testRunId,
        payloadKind: TaskPayloadKind.StandardTask,
        taskId: TEST_TASK_ID,
        startedAt,
      });
    });

    // Task deletion is a soft delete now; per-run history rows stay behind
    // their real FKs and only disappear on hard cleanup cascades.
    await db
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(eq(tasks.id, TEST_TASK_ID));

    const [log] = await db
      .select({
        taskId: taskStartParallelCounts.taskId,
        runId: taskStartParallelCounts.runId,
        payloadKind: taskStartParallelCounts.payloadKind,
        startedAt: taskStartParallelCounts.startedAt,
      })
      .from(taskStartParallelCounts)
      .where(eq(taskStartParallelCounts.runId, testRunId));

    expect(log).toEqual({
      taskId: TEST_TASK_ID,
      runId: testRunId,
      payloadKind: TaskPayloadKind.StandardTask,
      startedAt,
    });
  });
});
