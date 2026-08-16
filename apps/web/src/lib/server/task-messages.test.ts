import { db, runFactory, taskFactory, taskMessages } from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  TaskPayloadKind,
} from '@roomote/types';

import { getTaskMessageEnvelopes } from './task-messages';

describe('getTaskMessageEnvelopes', () => {
  it('preserves a missing user identity for automation prompts', async () => {
    const taskId = 'task-message-automatic-review';

    const task = await taskFactory.create({
      id: taskId,
      title: 'Review Code',
    });
    const run = await runFactory.create({
      payloadKind: TaskPayloadKind.GithubPrReview,
      taskId: task.id,
    });

    await db.insert(taskMessages).values({
      runId: run.id,
      taskId: task.id,
      userId: null,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      contentBlocks: [{ type: 'text', text: 'Review this pull request' }],
      payload: {},
    });

    const [message] = await getTaskMessageEnvelopes({ taskId });

    expect(message).toMatchObject({
      role: 'user',
      userId: null,
      userName: null,
      userEmail: null,
      userImageUrl: null,
    });
  });

  it('limits in the database to the newest messages and restores chronological order', async () => {
    const task = await taskFactory.create({
      id: 'task-message-limited-history',
    });
    const run = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      taskId: task.id,
    });

    await db.insert(taskMessages).values([
      ...['first', 'second', 'third'].map((text, index) => ({
        runId: run.id,
        taskId: task.id,
        ts: 1_000 + index,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user' as const,
        protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
        contentBlocks: [{ type: 'text' as const, text }],
        payload: {},
      })),
      ...['hidden-first', 'hidden-second'].map((text, index) => ({
        runId: run.id,
        taskId: task.id,
        ts: 2_000 + index,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user' as const,
        protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
        contentBlocks: [{ type: 'text' as const, text }],
        metadata: { visibleInTranscript: false },
        payload: {},
      })),
    ]);

    const messages = await getTaskMessageEnvelopes({
      taskId: task.id,
      limit: 2,
      visibleOnly: true,
    });

    expect(messages.map((message) => message.text)).toEqual([
      'second',
      'third',
    ]);
  });
});
