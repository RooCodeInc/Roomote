import { cloudJobs, db, taskMessages, tasks } from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  CloudTaskType,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
} from '@roomote/types';

import { getTaskMessageEnvelopes } from './task-messages';

describe('getTaskMessageEnvelopes', () => {
  it('preserves a missing user identity for automation prompts', async () => {
    const taskId = 'task-message-automatic-review';

    await db.insert(tasks).values({
      id: taskId,
      provider: 'roomote',
      model: 'test-model',
      title: 'Review Code',
      timestamp: Math.floor(Date.now() / 1000),
      activityAt: Date.now(),
    });

    const [cloudJob] = await db
      .insert(cloudJobs)
      .values({
        type: CloudTaskType.GithubPrReview,
        payload: { repo: 'roomote/example' },
        taskId,
        title: 'Review Code',
      })
      .returning({ id: cloudJobs.id });

    if (!cloudJob) {
      throw new Error('Failed to seed cloud job');
    }

    await db.insert(taskMessages).values({
      cloudJobId: cloudJob.id,
      taskId,
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
