import { CloudTaskType } from '@roomote/types';
import {
  cloudJobs,
  db,
  eq,
  markTaskStartParallelCountEndedAt,
  recordTaskStartParallelCount,
  taskFactory,
  taskStartParallelCounts,
  userFactory,
  cloudJobFactory,
  tasks,
} from '../../server';

const TEST_USER_ID = 'user_test_task_start_parallel_counts';
const TEST_TASK_ID = 'task_test_task_start_parallel_counts';
let testCloudJobId: number;

async function cleanup() {
  await db
    .delete(taskStartParallelCounts)
    .where(eq(taskStartParallelCounts.cloudJobId, testCloudJobId ?? -1))
    .catch(() => {});
  await db
    .delete(cloudJobs)
    .where(eq(cloudJobs.id, testCloudJobId ?? -1))
    .catch(() => {});
  await db
    .delete(tasks)
    .where(eq(tasks.id, TEST_TASK_ID))
    .catch(() => {});
}

describe('task start parallel count helpers', () => {
  beforeEach(async () => {
    await cleanup();
    testCloudJobId = -1;
    await userFactory.create({ id: TEST_USER_ID }).catch(() => {});
    await taskFactory.create({
      id: TEST_TASK_ID,
      userId: TEST_USER_ID,
      timestamp: 1_700_000_000,
      activityAt: 1_700_000_000,
    });
    const cloudJob = await cloudJobFactory.create({
      userId: TEST_USER_ID,
      taskId: TEST_TASK_ID,
    });
    testCloudJobId = cloudJob.id;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('records startedAt and updates endedAt for the run log', async () => {
    const startedAt = new Date('2099-05-21T12:00:00.000Z');
    const endedAt = new Date('2099-05-21T12:34:56.000Z');

    await db.transaction(async (tx) => {
      await recordTaskStartParallelCount(tx, {
        cloudJobId: testCloudJobId,
        cloudJobType: CloudTaskType.StandardTask,
        taskId: TEST_TASK_ID,
        startedAt,
      });

      await markTaskStartParallelCountEndedAt(tx, {
        cloudJobId: testCloudJobId,
        endedAt,
      });
    });

    const [log] = await db
      .select({
        startedAt: taskStartParallelCounts.startedAt,
        endedAt: taskStartParallelCounts.endedAt,
        cloudJobType: taskStartParallelCounts.cloudJobType,
        parallelCount: taskStartParallelCounts.parallelCount,
      })
      .from(taskStartParallelCounts)
      .where(eq(taskStartParallelCounts.cloudJobId, testCloudJobId));

    expect(log).toEqual({
      startedAt,
      endedAt,
      cloudJobType: CloudTaskType.StandardTask,
      parallelCount: 1,
    });
  });

  it('does not overwrite an existing endedAt timestamp', async () => {
    const startedAt = new Date('2026-05-21T12:00:00.000Z');
    const firstEndedAt = new Date('2026-05-21T12:34:56.000Z');
    const secondEndedAt = new Date('2026-05-21T12:45:00.000Z');

    await db.transaction(async (tx) => {
      await recordTaskStartParallelCount(tx, {
        cloudJobId: testCloudJobId,
        cloudJobType: CloudTaskType.StandardTask,
        taskId: TEST_TASK_ID,
        startedAt,
      });

      await markTaskStartParallelCountEndedAt(tx, {
        cloudJobId: testCloudJobId,
        endedAt: firstEndedAt,
      });

      await markTaskStartParallelCountEndedAt(tx, {
        cloudJobId: testCloudJobId,
        endedAt: secondEndedAt,
      });
    });

    const [log] = await db
      .select({
        endedAt: taskStartParallelCounts.endedAt,
      })
      .from(taskStartParallelCounts)
      .where(eq(taskStartParallelCounts.cloudJobId, testCloudJobId));

    expect(log?.endedAt).toEqual(firstEndedAt);
  });

  it('keeps the run log after the task and cloud job are deleted', async () => {
    const startedAt = new Date('2026-05-21T12:00:00.000Z');

    await db.transaction(async (tx) => {
      await recordTaskStartParallelCount(tx, {
        cloudJobId: testCloudJobId,
        cloudJobType: CloudTaskType.StandardTask,
        taskId: TEST_TASK_ID,
        startedAt,
      });
    });

    await db.delete(cloudJobs).where(eq(cloudJobs.id, testCloudJobId));
    await db.delete(tasks).where(eq(tasks.id, TEST_TASK_ID));

    const [log] = await db
      .select({
        taskId: taskStartParallelCounts.taskId,
        cloudJobId: taskStartParallelCounts.cloudJobId,
        cloudJobType: taskStartParallelCounts.cloudJobType,
        startedAt: taskStartParallelCounts.startedAt,
      })
      .from(taskStartParallelCounts)
      .where(eq(taskStartParallelCounts.cloudJobId, testCloudJobId));

    expect(log).toEqual({
      taskId: TEST_TASK_ID,
      cloudJobId: testCloudJobId,
      cloudJobType: CloudTaskType.StandardTask,
      startedAt,
    });
  });
});
