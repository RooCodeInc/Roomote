import {
  db,
  taskFactory,
  taskPullRequests,
  userFactory,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { mockUserResource } from '@/lib/mock-utils';

import { getRecentPullRequestsCommand } from '../recent-pull-requests';

describe('getRecentPullRequestsCommand', () => {
  it('counts distinct currently open pull requests without using the recent list limit', async () => {
    const owner = await userFactory.create();
    const otherUser = await userFactory.create();
    const ownerTask = await taskFactory.create({ initiatorUserId: owner.id });
    const duplicateTask = await taskFactory.create({
      initiatorUserId: owner.id,
    });
    const deletedTask = await taskFactory.create({
      initiatorUserId: owner.id,
      deletedAt: new Date(),
    });
    const otherTask = await taskFactory.create({
      initiatorUserId: otherUser.id,
    });
    const baseDetectedAt = new Date('2026-09-01T12:00:00Z');

    await db.insert(taskPullRequests).values([
      ...Array.from({ length: 16 }, (_, index) => ({
        taskId: ownerTask.id,
        sourceControlProvider: 'github' as const,
        prUrl: `https://github.com/roomote/app/pull/${index + 1}`,
        prNumber: index + 1,
        repository: 'roomote/app',
        status: (index === 0 ? 'draft' : 'open') as 'draft' | 'open',
        detectedAt: new Date(baseDetectedAt.getTime() + index * 1_000),
      })),
      {
        taskId: duplicateTask.id,
        sourceControlProvider: 'github',
        prUrl: 'https://github.com/roomote/app/pull/1',
        prNumber: 1,
        repository: 'roomote/app',
        status: 'merged',
        detectedAt: new Date(baseDetectedAt.getTime() + 20_000),
      },
      {
        taskId: ownerTask.id,
        sourceControlProvider: 'github',
        prUrl: 'https://github.com/roomote/app/pull/17',
        prNumber: 17,
        repository: 'roomote/app',
        status: 'closed',
        detectedAt: new Date(baseDetectedAt.getTime() + 21_000),
      },
      {
        taskId: deletedTask.id,
        sourceControlProvider: 'github',
        prUrl: 'https://github.com/roomote/app/pull/18',
        prNumber: 18,
        repository: 'roomote/app',
        status: 'open',
      },
      {
        taskId: otherTask.id,
        sourceControlProvider: 'github',
        prUrl: 'https://github.com/roomote/app/pull/19',
        prNumber: 19,
        repository: 'roomote/app',
        status: 'open',
      },
    ]);

    const auth = {
      success: true,
      userType: 'user',
      userId: owner.id,
      isAdmin: false,
      name: owner.name,
      resource: mockUserResource,
    } as UserAuthSuccess;

    const result = await getRecentPullRequestsCommand(auth);

    expect(result.pullRequests).toHaveLength(15);
    expect(result.openCount).toBe(15);
  });
});
