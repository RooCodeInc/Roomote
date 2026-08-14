import { randomUUID } from 'node:crypto';

import { db, eq, taskFactory, taskRuns, tasks } from '@roomote/db/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';

import {
  findActiveCommunicationTaskRun,
  findCompletedCommunicationTaskRunWithSnapshot,
} from '../communication-task-run-lookup';

function discordConversation(suffix: string) {
  return {
    provider: 'discord' as const,
    channelId: `channel-${suffix}`,
    threadId: `thread-${suffix}`,
  };
}

function discordPayload(conversation: ReturnType<typeof discordConversation>) {
  return {
    repo: 'acme/repo',
    description: 'Test Discord task',
    communicationProvider: conversation.provider,
    communicationChannelId: conversation.channelId,
    communicationThreadId: conversation.threadId,
  };
}

describe('communication task lookup deletion boundaries (real database)', () => {
  it('releases a Discord thread when its active task is soft-deleted', async () => {
    const conversation = discordConversation(randomUUID());
    const task = await taskFactory.create();
    const [run] = await db
      .insert(taskRuns)
      .values({
        taskId: task.id,
        payloadKind: TaskPayloadKind.StandardTask,
        status: RunStatus.Running,
        payload: discordPayload(conversation),
      })
      .returning({ id: taskRuns.id });
    if (!run) throw new Error('Expected task run to be created');

    await expect(
      findActiveCommunicationTaskRun(conversation),
    ).resolves.toMatchObject({ id: run.id, taskId: task.id });

    await db
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(eq(tasks.id, task.id));

    await expect(
      findActiveCommunicationTaskRun(conversation),
    ).resolves.toBeUndefined();
  });

  it('does not resume a deleted task snapshot from its former Discord thread', async () => {
    const conversation = discordConversation(randomUUID());
    const task = await taskFactory.create();
    await db.insert(taskRuns).values({
      taskId: task.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Completed,
      payload: discordPayload(conversation),
      snapshotId: `snapshot-${randomUUID()}`,
      snapshotCreatedAt: new Date(),
    });

    await expect(
      findCompletedCommunicationTaskRunWithSnapshot(conversation),
    ).resolves.toMatchObject({ taskId: task.id });

    await db
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(eq(tasks.id, task.id));

    await expect(
      findCompletedCommunicationTaskRunWithSnapshot(conversation),
    ).resolves.toBeNull();
  });
});
