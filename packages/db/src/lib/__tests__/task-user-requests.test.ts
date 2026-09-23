import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import {
  taskRuns,
  db,
  eq,
  taskMessages,
  tasks,
  runFactory,
  taskFactory,
  userFactory,
  findLatestTaskUserRequest,
} from '../../server';

const TEST_USER_ID = 'user_test_task_user_requests';
const TEST_TASK_ID = 'task_test_task_user_requests';
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

async function insertTaskMessage(input: {
  ts: number;
  text: string;
  eventType?: (typeof ACP_ENVELOPE_EVENT_TYPES)[keyof typeof ACP_ENVELOPE_EVENT_TYPES];
  role?: 'user' | 'assistant';
}) {
  await db.insert(taskMessages).values({
    runId: testRunId,
    taskId: TEST_TASK_ID,
    ts: input.ts,
    eventType: input.eventType ?? ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    role: input.role ?? 'user',
    protocol: 'roomote_runtime',
    contentBlocks: [{ type: 'text', text: input.text }],
    metadata: null,
    payload: { text: input.text },
  });
}

describe('findLatestTaskUserRequest', () => {
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

  it('is undefined before the task has a prompt', async () => {
    await expect(findLatestTaskUserRequest(TEST_TASK_ID)).resolves.toBe(
      undefined,
    );
  });

  it('returns the latest prompt, not a later assistant message', async () => {
    await insertTaskMessage({ ts: 1_000, text: 'Look up the open invoices.' });
    await insertTaskMessage({ ts: 2_000, text: 'Now file the bug.' });
    await insertTaskMessage({
      ts: 3_000,
      text: 'Filing it.',
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      role: 'assistant',
    });

    await expect(findLatestTaskUserRequest(TEST_TASK_ID)).resolves.toBe(
      'Now file the bug.',
    );
  });

  it("strips Roomote's injected wrapper blocks from the prompt", async () => {
    await insertTaskMessage({
      ts: 1_000,
      text: '<environment-instructions>Use pnpm.</environment-instructions>\n<request>File the bug.</request>',
    });

    await expect(findLatestTaskUserRequest(TEST_TASK_ID)).resolves.toBe(
      'File the bug.',
    );
  });
});
