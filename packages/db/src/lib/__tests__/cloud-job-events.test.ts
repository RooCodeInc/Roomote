import {
  taskRunEvents,
  taskRuns,
  db,
  eq,
  listCloudJobEvents,
  createComputeProviderMutationEventRecorder,
  recordComputeProviderMutationEvent,
  recordCloudJobEvent,
  taskFactory,
  userFactory,
  runFactory,
  tasks,
} from '../../server';

const TEST_USER_ID = 'user_test_cloud_job_events';
const TEST_TASK_ID = 'task_test_cloud_job_events';
let testCloudJobId: number;

async function cleanup() {
  await db
    .delete(taskRunEvents)
    .where(eq(taskRunEvents.runId, testCloudJobId ?? -1))
    .catch(() => {});
  await db
    .delete(taskRuns)
    .where(eq(taskRuns.id, testCloudJobId ?? -1))
    .catch(() => {});
  await db
    .delete(tasks)
    .where(eq(tasks.id, TEST_TASK_ID))
    .catch(() => {});
}

describe('cloud job event helpers', () => {
  beforeEach(async () => {
    await cleanup();
    testCloudJobId = -1;
    await userFactory.create({ id: TEST_USER_ID }).catch(() => {});
    await taskFactory.create({
      id: TEST_TASK_ID,
      initiatorUserId: TEST_USER_ID,
    });
    const cloudJob = await runFactory.create({
      actingUserId: TEST_USER_ID,
      taskId: TEST_TASK_ID,
    });
    testCloudJobId = cloudJob.id;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('records an event using the cloud job context when taskId and orgId are omitted', async () => {
    const event = await recordCloudJobEvent(db, {
      runId: testCloudJobId,
      source: 'sleep_check',
      eventType: 'decision',
      message: 'Completed the idle job without a snapshot.',
      details: {
        path: 'due_sleep',
        decision: 'complete_without_snapshot',
      },
    });

    expect(event).toEqual(
      expect.objectContaining({
        runId: testCloudJobId,
        taskId: TEST_TASK_ID,
        source: 'sleep_check',
        eventType: 'decision',
      }),
    );
  });

  it('lists events newest first by default', async () => {
    await recordCloudJobEvent(db, {
      runId: testCloudJobId,
      source: 'snapshot_request',
      eventType: 'enqueued',
      message: 'First event',
      createdAt: new Date('2026-04-02T21:34:03.000Z'),
      details: { queueJobId: 'snapshot-910001' },
    });
    await recordCloudJobEvent(db, {
      runId: testCloudJobId,
      source: 'snapshot_queue',
      eventType: 'completed',
      message: 'Second event',
      createdAt: new Date('2026-04-02T21:34:04.000Z'),
      details: { snapshotId: 'snap_1' },
    });

    const events = await listCloudJobEvents(db, {
      runId: testCloudJobId,
    });

    expect(events.map((event) => event.message)).toEqual([
      'Second event',
      'First event',
    ]);
  });

  it('records events after the source task has been soft-deleted', async () => {
    await db
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(eq(tasks.id, TEST_TASK_ID));

    const event = await recordCloudJobEvent(db, {
      runId: testCloudJobId,
      source: 'snapshot_queue',
      eventType: 'failed',
      message: 'Snapshot request stopped because the sandbox was already gone.',
      details: {
        decision: 'instance_not_running',
      },
    });

    expect(event).toEqual(
      expect.objectContaining({
        runId: testCloudJobId,
        taskId: TEST_TASK_ID,
      }),
    );
  });

  it('records compute-provider mutation metadata under the compute_provider source', async () => {
    const event = await recordComputeProviderMutationEvent(db, {
      runId: testCloudJobId,
      provider: 'modal',
      operation: 'destroy_instance',
      eventType: 'started',
      instanceId: 'sbx_audit_1',
      message: 'Calling destroyInstance for sandbox sbx_audit_1.',
      details: {
        phase: 'cleanup_after_failure',
      },
    });

    expect(event).toEqual(
      expect.objectContaining({
        runId: testCloudJobId,
        taskId: TEST_TASK_ID,
        source: 'compute_provider',
        eventType: 'started',
      }),
    );
    expect(event).toBeDefined();
    expect(event?.details).toEqual(
      expect.objectContaining({
        provider: 'modal',
        operation: 'destroy_instance',
        instanceId: 'sbx_audit_1',
        phase: 'cleanup_after_failure',
      }),
    );
  });

  it('builds a reusable recorder that persists shared mutation metadata', async () => {
    const recordMutation = createComputeProviderMutationEventRecorder(db, {
      runId: testCloudJobId,
    });

    await recordMutation({
      provider: 'modal',
      operation: 'run_command',
      eventType: 'failed',
      instanceId: 'modal-machine-77',
      message: 'runCommand failed while launching detached worker run.',
      details: {
        launchMode: 'environment_snapshot',
        sourceSnapshotId: 'snap_env_77',
        ports: [3000, 3001],
        phase: 'launch_worker',
      },
    });

    const [event] = await listCloudJobEvents(db, {
      runId: testCloudJobId,
      limit: 1,
    });

    expect(event).toBeDefined();
    if (!event) {
      throw new Error('Expected cloud job event to be recorded');
    }

    expect(event).toEqual(
      expect.objectContaining({
        runId: testCloudJobId,
        taskId: TEST_TASK_ID,
        source: 'compute_provider',
        eventType: 'failed',
        message: 'runCommand failed while launching detached worker run.',
      }),
    );
    expect(event.details).toEqual(
      expect.objectContaining({
        provider: 'modal',
        operation: 'run_command',
        instanceId: 'modal-machine-77',
        launchMode: 'environment_snapshot',
        sourceSnapshotId: 'snap_env_77',
        ports: [3000, 3001],
        phase: 'launch_worker',
      }),
    );
  });
});
