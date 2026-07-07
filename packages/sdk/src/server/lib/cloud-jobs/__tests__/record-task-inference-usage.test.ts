import {
  asc,
  cloudJobFactory,
  db,
  eq,
  taskFactory,
  taskInferenceUsageEvents,
  userFactory,
} from '@roomote/db/server';
import { CloudTaskType } from '@roomote/types';

import { recordTaskInferenceUsage } from '../record-task-inference-usage';

describe('recordTaskInferenceUsage', () => {
  it('inserts an OpenCode message usage event', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      userId: user.id,
      harnessSessionId: 'ses-inference-1',
    });
    const cloudJob = await cloudJobFactory.create({
      type: CloudTaskType.StandardTask,
      userId: user.id,
      taskId: task.id,
    });

    const result = await recordTaskInferenceUsage({
      cloudJobId: cloudJob.id,
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
      .from(taskInferenceUsageEvents)
      .where(eq(taskInferenceUsageEvents.taskId, task.id));

    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      source: 'opencode',
      taskId: task.id,
      cloudJobId: cloudJob.id,
      userId: user.id,
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
      userId: user.id,
      harnessSessionId: 'ses-inference-2',
    });
    const cloudJob = await cloudJobFactory.create({
      type: CloudTaskType.StandardTask,
      userId: user.id,
      taskId: task.id,
    });

    await recordTaskInferenceUsage({
      cloudJobId: cloudJob.id,
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
      cloudJobId: cloudJob.id,
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
      .from(taskInferenceUsageEvents)
      .where(eq(taskInferenceUsageEvents.taskId, task.id));

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
      userId: user.id,
      harnessSessionId: 'ses-inference-3',
    });
    const cloudJob = await cloudJobFactory.create({
      type: CloudTaskType.StandardTask,
      userId: user.id,
      taskId: task.id,
    });

    await recordTaskInferenceUsage({
      cloudJobId: cloudJob.id,
      harnessSessionId: 'ses-inference-3',
      messageId: 'msg-a',
      inputTokens: 10,
      outputTokens: 5,
      costMicroUsd: 50,
      costSource: 'opencode_message',
    });
    await recordTaskInferenceUsage({
      cloudJobId: cloudJob.id,
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
      .from(taskInferenceUsageEvents)
      .where(eq(taskInferenceUsageEvents.taskId, task.id))
      .orderBy(asc(taskInferenceUsageEvents.messageId));

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
});
