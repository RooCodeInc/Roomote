import { taskFactory, userFactory } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { getTaskAnalyticsRows } from './task-rows';

describe('getTaskAnalyticsRows', () => {
  it('excludes private tasks from non-owner admin analytics', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    const privateTask = await taskFactory.create({
      initiatorUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
      title: 'Owner analytics only',
    });

    const ownerRows = await getTaskAnalyticsRows(
      { userId: owner.id, isAdmin: false } as UserAuthSuccess,
      'all',
      new Date(),
      'tasks',
    );
    const adminRows = await getTaskAnalyticsRows(
      { userId: other.id, isAdmin: true } as UserAuthSuccess,
      'all',
      new Date(),
      'tasks',
    );

    expect(ownerRows.map(({ id }) => id)).toContain(privateTask.id);
    expect(adminRows.map(({ id }) => id)).not.toContain(privateTask.id);
  });
});
