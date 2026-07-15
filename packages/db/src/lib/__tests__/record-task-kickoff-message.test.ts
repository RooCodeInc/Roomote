import {
  taskRuns,
  db,
  eq,
  taskMessages,
  tasks,
  runFactory,
  taskFactory,
  userFactory,
  recordTaskKickoffMessage,
  claimPendingOutOfBandTaskMessages,
} from '../../server';
import { TASK_KICKOFF_MESSAGE_SOURCE } from '@roomote/types';

const TEST_USER_ID = 'user_test_task_kickoff_message';
const TEST_TASK_ID = 'task_test_task_kickoff';
let testRunId: number;

async function cleanup() {
  await db
    .delete(taskMessages)
    .where(eq(taskMessages.taskId, TEST_TASK_ID))
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

describe('recordTaskKickoffMessage', () => {
  beforeEach(async () => {
    await cleanup();
    testRunId = -1;
    await userFactory.create({ id: TEST_USER_ID }).catch(() => {});
    await taskFactory.create({
      id: TEST_TASK_ID,
      initiatorUserId: TEST_USER_ID,
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

  it('persists the kickoff as a visible out-of-band assistant message', async () => {
    await recordTaskKickoffMessage({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      text: 'Digging into login redirects in App.',
      messageId: '1710000000.123456',
    });

    const rows = await db
      .select()
      .from(taskMessages)
      .where(eq(taskMessages.taskId, TEST_TASK_ID));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('roomote_runtime.assistant_message');
    expect(rows[0]?.role).toBe('assistant');
    expect(rows[0]?.ts).toBe(1_710_000_000_123);
    expect(rows[0]?.contentBlocks).toEqual([
      { type: 'text', text: 'Digging into login redirects in App.' },
    ]);
    expect(rows[0]?.metadata).toEqual({
      source: TASK_KICKOFF_MESSAGE_SOURCE,
      visibleInTranscript: true,
    });
    expect(rows[0]?.payload).toEqual({
      text: 'Digging into login redirects in App.',
      source: TASK_KICKOFF_MESSAGE_SOURCE,
    });
  });

  it('does not re-surface kickoff messages into later prompts', async () => {
    await recordTaskKickoffMessage({
      runId: testRunId,
      taskId: TEST_TASK_ID,
      text: 'Checking payment retries in Storefront.',
      messageId: '1710000001.000001',
    });

    await expect(
      claimPendingOutOfBandTaskMessages(TEST_TASK_ID),
    ).resolves.toEqual([]);
  });
});
