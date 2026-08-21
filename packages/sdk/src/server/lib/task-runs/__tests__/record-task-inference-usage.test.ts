import {
  asc,
  runFactory,
  db,
  eq,
  llmUsageEvents,
  taskFactory,
  userFactory,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import {
  recordLlmUsage,
  recordTaskInferenceUsage,
} from '../record-task-inference-usage';

describe('recordTaskInferenceUsage', () => {
  it('inserts an OpenCode message usage event', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
      harnessSessionId: 'ses-inference-1',
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
    });

    const result = await recordTaskInferenceUsage({
      runId: taskRun.id,
      harnessSessionId: 'ses-inference-1',
      messageId: 'msg-inference-1',
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.4',
      agent: 'build',
      inputTokens: 1_000,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadTokens: 300,
      cacheWriteTokens: 25,
      totalTokens: 1_575,
      contextTokens: 1_300,
      costMicroUsd: 12_345,
      costSource: 'opencode_message',
      messageCreatedAt: new Date('2026-07-01T12:00:00.000Z'),
      messageCompletedAt: new Date('2026-07-01T12:00:05.000Z'),
    });

    expect(result).toEqual({ recorded: true, taskId: task.id });

    const eventRows = await db
      .select()
      .from(llmUsageEvents)
      .where(eq(llmUsageEvents.taskId, task.id));

    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      source: 'opencode',
      taskId: task.id,
      runId: taskRun.id,
      harnessSessionId: 'ses-inference-1',
      messageId: 'msg-inference-1',
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.4',
      agent: 'build',
      inputTokens: 1_000,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadTokens: 300,
      cacheWriteTokens: 25,
      totalTokens: 1_575,
      contextTokens: 1_300,
      costMicroUsd: 12_345,
      costSource: 'opencode_message',
      messageCreatedAt: new Date('2026-07-01T12:00:00.000Z'),
      messageCompletedAt: new Date('2026-07-01T12:00:05.000Z'),
    });
  });

  it('upserts duplicate message usage by session and message id', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
      harnessSessionId: 'ses-inference-2',
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
    });

    await recordTaskInferenceUsage({
      runId: taskRun.id,
      harnessSessionId: 'ses-inference-2',
      messageId: 'msg-inference-2',
      agent: '  ',
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      contextTokens: 100,
      costMicroUsd: 100,
      costSource: 'opencode_message',
    });

    await recordTaskInferenceUsage({
      runId: taskRun.id,
      harnessSessionId: 'ses-inference-2',
      messageId: 'msg-inference-2',
      agent: 'explore',
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 30,
      totalTokens: 250,
      contextTokens: 230,
      costMicroUsd: 250,
      costSource: 'opencode_message',
    });

    const eventRows = await db
      .select()
      .from(llmUsageEvents)
      .where(eq(llmUsageEvents.taskId, task.id));

    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      agent: 'explore',
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 30,
      totalTokens: 250,
      contextTokens: 230,
      costMicroUsd: 250,
    });
  });

  it('stores multiple OpenCode messages and derives omitted totals per event', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
      harnessSessionId: 'ses-inference-3',
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
    });

    await recordTaskInferenceUsage({
      runId: taskRun.id,
      harnessSessionId: 'ses-inference-3',
      messageId: 'msg-a',
      inputTokens: 10,
      outputTokens: 5,
      costMicroUsd: 50,
      costSource: 'opencode_message',
    });
    await recordTaskInferenceUsage({
      runId: taskRun.id,
      harnessSessionId: 'ses-inference-3',
      messageId: 'msg-b',
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 3,
      costMicroUsd: 75,
      costSource: 'opencode_message',
    });

    const eventRows = await db
      .select()
      .from(llmUsageEvents)
      .where(eq(llmUsageEvents.taskId, task.id))
      .orderBy(asc(llmUsageEvents.messageId));

    expect(eventRows).toHaveLength(2);
    expect(eventRows.map((event) => event.messageId)).toEqual([
      'msg-a',
      'msg-b',
    ]);
    expect(eventRows[0]).toMatchObject({
      agent: null,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      totalTokens: 15,
      contextTokens: 10,
      costMicroUsd: 50,
    });
    expect(eventRows[1]).toMatchObject({
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 3,
      totalTokens: 30,
      contextTokens: 23,
      costMicroUsd: 75,
    });
  });

  it('accepts LiteLLM response costs', async () => {
    await recordLlmUsage({
      source: 'litellm',
      usageType: 'inference',
      eventKey: 'litellm-response-cost-1',
      providerId: 'litellm',
      modelId: 'gpt-4o',
      costMicroUsd: 123,
      costSource: 'litellm_gateway',
    });

    const [event] = await db
      .select()
      .from(llmUsageEvents)
      .where(eq(llmUsageEvents.eventKey, 'litellm-response-cost-1'));

    expect(event).toMatchObject({
      costMicroUsd: 123,
      costSource: 'litellm_gateway',
    });
  });

  it('upserts non-task usage by event key and keeps model rows separate', async () => {
    await recordLlmUsage({
      source: 'router',
      usageType: 'inference',
      eventKey: 'router-call-1',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      inputTokens: 10,
      outputTokens: 2,
      costMicroUsd: 100,
    });
    await recordLlmUsage({
      source: 'router',
      usageType: 'inference',
      eventKey: 'router-call-1',
      providerId: 'openai',
      modelId: 'gpt-5.4',
      inputTokens: 20,
      outputTokens: 4,
      costMicroUsd: 200,
    });
    await recordLlmUsage({
      source: 'router',
      usageType: 'inference',
      eventKey: 'router-call-2',
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
      inputTokens: 30,
      outputTokens: 6,
      costMicroUsd: 300,
    });

    const rows = await db
      .select()
      .from(llmUsageEvents)
      .where(eq(llmUsageEvents.source, 'router'));

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventKey: 'router-call-1',
          modelId: 'gpt-5.4',
          inputTokens: 20,
          outputTokens: 4,
          costMicroUsd: 200,
        }),
        expect.objectContaining({
          eventKey: 'router-call-2',
          modelId: 'claude-sonnet',
          inputTokens: 30,
          outputTokens: 6,
          costMicroUsd: 300,
        }),
      ]),
    );
  });

  it('upserts Fast usage by event key with user and surface attribution', async () => {
    const user = await userFactory.create();
    const eventKey = 'non-task:fast_agent:session-1:message-1';

    await recordLlmUsage({
      source: 'fast_agent',
      eventKey,
      userId: user.id,
      harnessSessionId: 'session-1',
      messageId: 'message-1',
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.4',
      inputTokens: 100,
      outputTokens: 20,
      costMicroUsd: 500,
      costSource: 'opencode_message',
      details: { surface: 'fast_agent' },
    });
    await recordLlmUsage({
      source: 'fast_agent',
      eventKey,
      userId: user.id,
      harnessSessionId: 'session-1',
      messageId: 'message-1',
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.4',
      inputTokens: 200,
      outputTokens: 40,
      costMicroUsd: 900,
      costSource: 'opencode_message',
      details: { surface: 'fast_agent' },
    });

    const rows = await db
      .select()
      .from(llmUsageEvents)
      .where(eq(llmUsageEvents.eventKey, eventKey));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'fast_agent',
      userId: user.id,
      harnessSessionId: 'session-1',
      messageId: 'message-1',
      inputTokens: 200,
      outputTokens: 40,
      costMicroUsd: 900,
      details: { surface: 'fast_agent' },
    });
  });
});
