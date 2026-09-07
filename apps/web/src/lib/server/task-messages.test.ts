import { db, runFactory, taskFactory, taskMessages } from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  TaskPayloadKind,
} from '@roomote/types';

import {
  getTaskMessageEnvelopes,
  getTaskSuggestableMessages,
} from './task-messages';

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
});

describe('getTaskSuggestableMessages', () => {
  it('returns only the newest 60 visible conversational messages', async () => {
    const task = await taskFactory.create({
      id: 'task-composer-suggestion-history',
      title: 'Composer suggestion history',
    });
    const run = await runFactory.create({ taskId: task.id });

    await db.insert(taskMessages).values([
      ...Array.from({ length: 61 }, (_, index) => ({
        runId: run.id,
        taskId: task.id,
        ts: index + 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant' as const,
        protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
        contentBlocks: [{ type: 'text' as const, text: `message-${index}` }],
        metadata: { visibleInTranscript: true },
        payload: {},
      })),
      {
        runId: run.id,
        taskId: task.id,
        ts: 62,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user' as const,
        protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
        contentBlocks: [{ type: 'text' as const, text: 'hidden prompt' }],
        metadata: { visibleInTranscript: false },
        payload: {},
      },
      {
        runId: run.id,
        taskId: task.id,
        ts: 63,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
        role: 'assistant' as const,
        protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
        contentBlocks: [{ type: 'text' as const, text: 'tool payload' }],
        metadata: { visibleInTranscript: true },
        payload: {},
      },
    ]);

    const messages = await getTaskSuggestableMessages(task.id);

    expect(messages).toHaveLength(60);
    expect(messages[0]?.text).toBe('message-1');
    expect(messages.at(-1)?.text).toBe('message-60');
    expect(messages.map((message) => message.text)).not.toContain(
      'hidden prompt',
    );
    expect(messages.map((message) => message.text)).not.toContain(
      'tool payload',
    );
  });
});
