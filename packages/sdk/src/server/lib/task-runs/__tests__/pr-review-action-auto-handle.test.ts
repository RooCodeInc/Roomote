import {
  db,
  eq,
  taskFactory,
  taskPullRequests,
  userFactory,
} from '@roomote/db/server';

import { enableAutoHandlePrReviewFeedback } from '../pr-review-action';

describe('enableAutoHandlePrReviewFeedback', () => {
  it('updates only the matching source-control provider', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: user.id });

    await db.insert(taskPullRequests).values([
      {
        taskId: task.id,
        sourceControlProvider: 'github',
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
      },
      {
        taskId: task.id,
        sourceControlProvider: 'gitlab',
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://gitlab.com/owner/repo/-/merge_requests/42',
      },
    ]);

    await enableAutoHandlePrReviewFeedback({
      taskId: task.id,
      sourceControlProvider: 'gitlab',
      repository: 'owner/repo',
      prNumber: 42,
      userId: user.id,
    });

    const links = await db.query.taskPullRequests.findMany({
      where: eq(taskPullRequests.taskId, task.id),
      columns: {
        sourceControlProvider: true,
        autoHandleFeedbackByUserId: true,
      },
    });

    expect(links).toEqual(
      expect.arrayContaining([
        {
          sourceControlProvider: 'github',
          autoHandleFeedbackByUserId: null,
        },
        {
          sourceControlProvider: 'gitlab',
          autoHandleFeedbackByUserId: user.id,
        },
      ]),
    );
  });
});
