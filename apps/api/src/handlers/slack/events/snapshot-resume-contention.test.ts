import { db, eq, taskFactory, taskRuns, tasks } from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import { findRecentSlackResumeRun } from './snapshot-resume';

describe('snapshot resume contention', () => {
  const taskId = 'task-snapshot-resume-alert-contention';

  afterEach(async () => {
    await db.delete(tasks).where(eq(tasks.id, taskId));
  });

  it('finds the leader resume run for a second reply to an alert alias', async () => {
    await taskFactory.create({
      id: taskId,
      modelProvider: 'roomote',
      model: 'test-model',
      title: 'Snapshot resume contention',
      workflow: 'pr_review',
      surface: 'slack',
      trigger: 'message',
      slackChannelId: 'C_SOURCE',
      slackThreadTs: '111.222',
    });
    const [run] = await db
      .insert(taskRuns)
      .values({
        taskId,
        kind: 'resume',
        payloadKind: TaskPayloadKind.SnapshotResume,
        payload: {
          sourceSnapshotId: 'snapshot-1',
          sourceRunId: 1,
          repo: 'owner/repo',
          teamId: 'T123',
          channel: 'C_ALERT',
          thread_ts: '333.444',
        },
      })
      .returning({ id: taskRuns.id });

    await expect(
      findRecentSlackResumeRun({
        taskId,
        slackTeamId: 'T123',
        channelId: 'C_ALERT',
        threadId: '333.444',
      }),
    ).resolves.toBe(run?.id);
  });
});
