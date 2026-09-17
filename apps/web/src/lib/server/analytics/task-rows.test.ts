import { taskFactory, userFactory } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { getTaskAnalyticsRows } from './task-rows';

describe('getTaskAnalyticsRows', () => {
  it('includes private tasks for every viewer while redacting non-owner details', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    const privateTask = await taskFactory.create({
      initiatorUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
      title: 'Owner analytics only',
      repositoryName: 'secret/private-repository',
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
    const nonOwnerRows = await getTaskAnalyticsRows(
      { userId: other.id, isAdmin: false } as UserAuthSuccess,
      'all',
      new Date(),
      'tasks',
    );
    const ownerRow = ownerRows.find(({ id }) => id === privateTask.id);
    const adminRow = adminRows.find(
      ({ details }) => details.values.taskTitle === 'Private task',
    );
    const nonOwnerRow = nonOwnerRows.find(
      ({ details }) => details.values.taskTitle === 'Private task',
    );

    expect(ownerRows.reduce((sum, row) => sum + row.value, 0)).toBe(
      adminRows.reduce((sum, row) => sum + row.value, 0),
    );
    expect(nonOwnerRows.reduce((sum, row) => sum + row.value, 0)).toBe(
      adminRows.reduce((sum, row) => sum + row.value, 0),
    );
    expect(ownerRow).toMatchObject({
      id: privateTask.id,
      details: {
        values: {
          taskTitle: 'Owner analytics only',
          task: 'View task',
        },
        links: { task: `/task/${privateTask.id}` },
      },
    });
    expect(adminRow).toMatchObject({
      id: expect.stringMatching(/^private-task:/),
      dimensions: {
        user: ownerRow?.dimensions.user,
        project: { key: 'Private', label: 'Private' },
        source: { key: 'Private', label: 'Private' },
        taskType: { key: 'Private task', label: 'Private task' },
      },
      details: { values: { taskTitle: 'Private task' } },
    });
    expect(adminRow?.details.links).toBeUndefined();
    expect(nonOwnerRow).toEqual(adminRow);
    expect(JSON.stringify(adminRow)).not.toContain(privateTask.id);
    expect(JSON.stringify(adminRow)).not.toContain('Owner analytics only');
    expect(JSON.stringify(adminRow)).not.toContain('secret/private-repository');
    expect(adminRow?.details.values.user).toBe(ownerRow?.details.values.user);
  });
});
