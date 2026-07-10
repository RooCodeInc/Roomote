import {
  taskRuns,
  db,
  eq,
  taskMessages,
  tasks,
  runFactory,
  taskFactory,
  userFactory,
  claimPendingOutOfBandTaskMessages,
  releaseClaimedOutOfBandTaskMessages,
} from '../../server';

const TEST_USER_ID = 'user_test_out_of_band_messages';
const TEST_TASK_ID = 'task_test_out_of_band_msgs';
let testCloudJobId: number;

async function cleanup() {
  await db
    .delete(taskMessages)
    .where(eq(taskMessages.taskId, TEST_TASK_ID))
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

async function insertTaskMessage(input: {
  ts: number;
  text: string;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(taskMessages).values({
    runId: testCloudJobId,
    taskId: TEST_TASK_ID,
    ts: input.ts,
    eventType: 'roomote_runtime.assistant_message',
    role: 'assistant',
    protocol: 'roomote_runtime',
    contentBlocks: [{ type: 'text', text: input.text }],
    metadata: input.metadata ?? null,
    payload: { text: input.text },
  });
}

describe('out-of-band task message claims', () => {
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

  it('claims pending out-of-band messages once, in timestamp order', async () => {
    await insertTaskMessage({
      ts: 3_000,
      text: 'second notification',
      metadata: { source: 'pr_review_notification' },
    });
    await insertTaskMessage({
      ts: 2_000,
      text: 'ordinary assistant message',
    });
    await insertTaskMessage({
      ts: 1_000,
      text: 'first notification',
      metadata: { source: 'pr_review_notification' },
    });

    const claimed = await claimPendingOutOfBandTaskMessages(TEST_TASK_ID);

    expect(claimed.map((message) => message.text)).toEqual([
      'first notification',
      'second notification',
    ]);

    // A second claim finds nothing: the rows are now marked re-surfaced.
    await expect(
      claimPendingOutOfBandTaskMessages(TEST_TASK_ID),
    ).resolves.toEqual([]);
  });

  it('consumes whitespace-only messages without returning them', async () => {
    await insertTaskMessage({
      ts: 1_000,
      text: '   \n  ',
      metadata: { source: 'pr_review_notification' },
    });

    // Filtered from the result like null-text rows, but still stamped by the
    // claim so it does not churn on every later turn.
    await expect(
      claimPendingOutOfBandTaskMessages(TEST_TASK_ID),
    ).resolves.toEqual([]);

    const [row] = await db
      .select({ metadata: taskMessages.metadata })
      .from(taskMessages)
      .where(eq(taskMessages.taskId, TEST_TASK_ID));

    expect(
      (row?.metadata as Record<string, unknown>)?.outOfBandResurfacedAt,
    ).toBeTruthy();
  });

  it('skips messages already marked as re-surfaced', async () => {
    await insertTaskMessage({
      ts: 1_000,
      text: 'already delivered notification',
      metadata: {
        source: 'pr_review_notification',
        outOfBandResurfacedAt: '2026-07-05T00:00:00.000Z',
      },
    });

    await expect(
      claimPendingOutOfBandTaskMessages(TEST_TASK_ID),
    ).resolves.toEqual([]);
  });

  it('release makes a claimed message claimable again', async () => {
    await insertTaskMessage({
      ts: 1_000,
      text: 'notification',
      metadata: { source: 'pr_review_notification' },
    });

    const [claimed] = await claimPendingOutOfBandTaskMessages(TEST_TASK_ID);
    expect(claimed?.text).toBe('notification');

    await releaseClaimedOutOfBandTaskMessages([claimed!.id]);

    const reclaimed = await claimPendingOutOfBandTaskMessages(TEST_TASK_ID);
    expect(reclaimed.map((message) => message.text)).toEqual(['notification']);
  });
});
