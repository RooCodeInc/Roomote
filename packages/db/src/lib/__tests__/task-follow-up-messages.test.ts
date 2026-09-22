import {
  db,
  eq,
  activateTaskFollowUpActor,
  enqueueTaskFollowUpMessage,
  claimTaskFollowUpMessages,
  hasOpenTaskFollowUpMessages,
  markTaskFollowUpAccepted,
  markTaskFollowUpDelivered,
  releaseTaskFollowUpMessage,
  runFactory,
  taskFactory,
  taskFollowUpMessages,
  taskMessages,
  taskRuns,
  tasks,
  userFactory,
} from '../../server';
import { RunStatus } from '@roomote/types';

const TEST_USER_ID = 'user_test_task_follow_up_messages';
const SENDER_A_ID = 'user_test_task_follow_up_sender_a';
const SENDER_B_ID = 'user_test_task_follow_up_sender_b';
const TEST_TASK_ID = 'task_test_task_follow_up_messages';
let testRunId = -1;

async function cleanup() {
  await db
    .delete(taskFollowUpMessages)
    .where(eq(taskFollowUpMessages.taskId, TEST_TASK_ID))
    .catch(() => {});
  await db
    .delete(taskMessages)
    .where(eq(taskMessages.taskId, TEST_TASK_ID))
    .catch(() => {});
  await db
    .delete(taskRuns)
    .where(eq(taskRuns.id, testRunId))
    .catch(() => {});
  await db
    .delete(tasks)
    .where(eq(tasks.id, TEST_TASK_ID))
    .catch(() => {});
}

describe('task follow-up message outbox', () => {
  beforeEach(async () => {
    await cleanup();
    await userFactory.create({ id: TEST_USER_ID }).catch(() => {});
    await userFactory.create({ id: SENDER_A_ID }).catch(() => {});
    await userFactory.create({ id: SENDER_B_ID }).catch(() => {});
    await taskFactory.create({
      id: TEST_TASK_ID,
      initiatorUserId: TEST_USER_ID,
    });
    const run = await runFactory.create({
      taskId: TEST_TASK_ID,
      actingUserId: TEST_USER_ID,
    });
    testRunId = run.id;
  });

  afterEach(cleanup);

  it('admits duplicate identities once and claims messages in FIFO order', async () => {
    const first = await enqueueTaskFollowUpMessage({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      userId: TEST_USER_ID,
      prompt: 'first',
      quoteText: 'first',
      clientMessageId: 'client-first',
      deliveryMode: 'steer',
    });
    const duplicate = await enqueueTaskFollowUpMessage({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      userId: TEST_USER_ID,
      prompt: 'first retry',
      quoteText: 'first retry',
      clientMessageId: 'client-first',
      deliveryMode: 'steer',
    });
    await enqueueTaskFollowUpMessage({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      userId: TEST_USER_ID,
      prompt: 'second',
      quoteText: 'second',
      clientMessageId: 'client-second',
      deliveryMode: 'steer',
    });

    expect(first).toMatchObject({ accepted: true, inserted: true });
    expect(duplicate).toMatchObject({ accepted: true, inserted: false });
    expect(
      duplicate.accepted && first.accepted ? duplicate.message.id : undefined,
    ).toBe(first.accepted ? first.message.id : undefined);

    const claimed = await claimTaskFollowUpMessages(testRunId);
    expect(claimed.map((message) => message.prompt)).toEqual(['first']);
    expect(claimed[0]?.claimToken).toBeTruthy();
    await markTaskFollowUpAccepted({
      id: claimed[0]!.id,
      runId: testRunId,
      claimToken: claimed[0]!.claimToken!,
    });
    await markTaskFollowUpDelivered({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      clientMessageId: 'client-first',
    });

    const secondClaim = await claimTaskFollowUpMessages(testRunId);
    expect(secondClaim.map((message) => message.prompt)).toEqual(['second']);
  });

  it('releases a claimed message for retry and keeps the outbox open until delivery', async () => {
    const admitted = await enqueueTaskFollowUpMessage({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      prompt: 'retry me',
      quoteText: 'retry me',
      clientMessageId: 'client-retry',
      deliveryMode: 'send',
    });
    const [claimed] = await claimTaskFollowUpMessages(testRunId);

    expect(admitted.accepted && claimed).toBeTruthy();
    await releaseTaskFollowUpMessage({
      id: claimed!.id,
      runId: testRunId,
      claimToken: claimed!.claimToken!,
      error: 'runtime not ready',
    });

    expect(await hasOpenTaskFollowUpMessages(testRunId)).toBe(true);
    const [retried] = await claimTaskFollowUpMessages(testRunId);
    expect(retried?.clientMessageId).toBe('client-retry');

    await markTaskFollowUpAccepted({
      id: retried!.id,
      runId: testRunId,
      claimToken: retried!.claimToken!,
    });
    await markTaskFollowUpDelivered({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      clientMessageId: 'client-retry',
    });

    expect(await hasOpenTaskFollowUpMessages(testRunId)).toBe(false);
  });

  it('reconciles a persisted runtime prompt without redelivering it', async () => {
    await enqueueTaskFollowUpMessage({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      prompt: 'already accepted',
      quoteText: 'already accepted',
      clientMessageId: 'client-persisted',
      deliveryMode: 'send',
    });
    await db.insert(taskMessages).values({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      ts: Date.now(),
      eventType: 'roomote_runtime.user_prompt',
      role: 'user',
      protocol: 'roomote_runtime',
      contentBlocks: [{ type: 'text', text: 'already accepted' }],
      metadata: { clientMessageId: 'client-persisted' },
      payload: {
        text: 'already accepted',
        clientMessageId: 'client-persisted',
      },
    });

    await expect(claimTaskFollowUpMessages(testRunId)).resolves.toEqual([]);
    expect(await hasOpenTaskFollowUpMessages(testRunId)).toBe(false);
  });

  it('serializes different sender actors behind earlier pending prompts', async () => {
    const first = await enqueueTaskFollowUpMessage({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      userId: SENDER_A_ID,
      prompt: 'from A',
      quoteText: 'from A',
      clientMessageId: 'client-a',
      deliveryMode: 'send',
    });
    const second = await enqueueTaskFollowUpMessage({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      userId: SENDER_B_ID,
      prompt: 'from B',
      quoteText: 'from B',
      clientMessageId: 'client-b',
      deliveryMode: 'send',
    });
    const [firstClaim] = await claimTaskFollowUpMessages(testRunId);

    expect(first.accepted && second.accepted && firstClaim).toBeTruthy();
    // B cannot be claimed and overwrite the actor while A is still pending.
    await expect(claimTaskFollowUpMessages(testRunId)).resolves.toEqual([]);

    await expect(
      activateTaskFollowUpActor({ id: firstClaim!.id, runId: testRunId }),
    ).resolves.toEqual({ userId: SENDER_A_ID });
    await markTaskFollowUpAccepted({
      id: firstClaim!.id,
      runId: testRunId,
      claimToken: firstClaim!.claimToken!,
    });

    // Once A is in the runtime queue, that queue owns ordering and B follows.
    const [secondClaim] = await claimTaskFollowUpMessages(testRunId);
    expect(secondClaim?.clientMessageId).toBe('client-b');
    await expect(
      activateTaskFollowUpActor({ id: secondClaim!.id, runId: testRunId }),
    ).resolves.toEqual({ userId: SENDER_B_ID });
  });

  it('never reclaims or waits on a prompt the runtime already accepted', async () => {
    await enqueueTaskFollowUpMessage({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      prompt: 'deleted from the runtime queue',
      quoteText: 'deleted from the runtime queue',
      clientMessageId: 'client-deleted',
      deliveryMode: 'send',
    });
    const [claimed] = await claimTaskFollowUpMessages(testRunId);
    await markTaskFollowUpAccepted({
      id: claimed!.id,
      runId: testRunId,
      claimToken: claimed!.claimToken!,
    });
    // Simulate the lease expiring with no transcript ack ever arriving.
    await db
      .update(taskFollowUpMessages)
      .set({ claimExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(taskFollowUpMessages.id, claimed!.id));

    expect(await hasOpenTaskFollowUpMessages(testRunId)).toBe(false);
    await expect(claimTaskFollowUpMessages(testRunId)).resolves.toEqual([]);
  });

  it('discards startup messages when the run settles instead of reactivating it', async () => {
    await enqueueTaskFollowUpMessage({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      prompt: 'do not revive',
      quoteText: 'do not revive',
      clientMessageId: 'client-settled',
      deliveryMode: 'steer',
    });
    await db
      .update(taskRuns)
      .set({ status: RunStatus.Completed })
      .where(eq(taskRuns.id, testRunId));

    await expect(claimTaskFollowUpMessages(testRunId)).resolves.toEqual([]);
    const [row] = await db
      .select({ status: taskFollowUpMessages.status })
      .from(taskFollowUpMessages)
      .where(eq(taskFollowUpMessages.runId, testRunId));
    expect(row?.status).toBe('discarded');
  });
});
