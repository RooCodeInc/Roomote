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

  it('pages past every hidden legacy form to return the newest visible messages', async () => {
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
      {
        runId: run.id,
        taskId: task.id,
        ts: 3_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user' as const,
        protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
        contentBlocks: [
          { type: 'text' as const, text: '<workflow>internal</workflow>' },
        ],
        payload: {},
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 3_001,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user' as const,
        protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
        contentBlocks: [],
        payload: {
          prompt: [
            {
              type: 'text',
              text: '<environment-instructions>internal</environment-instructions>',
            },
          ],
        },
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 4_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user' as const,
        protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
        contentBlocks: [
          {
            type: 'text' as const,
            text: '<workflow>explicitly visible</workflow>',
          },
        ],
        metadata: { visibleInTranscript: true },
        payload: {},
      },
      ...['First passive update', 'Second passive update'].map(
        (text, index) => ({
          runId: run.id,
          taskId: task.id,
          ts: 5_000 + index,
          eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          role: 'user' as const,
          protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
          contentBlocks: [
            {
              type: 'text' as const,
              text: `<thread_activity>\n${text}\n</thread_activity>`,
            },
          ],
          payload: {},
        }),
      ),
    ]);

    const messages = await getTaskMessageEnvelopes({
      taskId: task.id,
      limit: 2,
      visibleOnly: true,
    });

    expect(messages.map((message) => message.text)).toEqual([
      'third',
      '<workflow>explicitly visible</workflow>',
    ]);
  });
});
