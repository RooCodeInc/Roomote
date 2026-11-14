import {
  db,
  environmentFactory,
  eq,
  runFactory,
  taskFactory,
  tasks,
  userFactory,
} from '@roomote/db/server';

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
      (row) =>
        row.details.values.taskTitle === 'Private task' &&
        row.dimensions.user?.key === ownerRow?.dimensions.user?.key,
    );
    const nonOwnerRow = nonOwnerRows.find(
      (row) =>
        row.details.values.taskTitle === 'Private task' &&
        row.dimensions.user?.key === ownerRow?.dimensions.user?.key,
    );

    expect(ownerRow?.value).toBe(1);
    expect(adminRow?.value).toBe(1);
    expect(nonOwnerRow?.value).toBe(adminRow?.value);
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
    expect(nonOwnerRow).toMatchObject({
      id: expect.stringMatching(/^private-task:/),
      dimensions: { user: ownerRow?.dimensions.user },
      details: { values: { taskTitle: 'Private task' } },
    });
    expect(nonOwnerRow?.details.links).toBeUndefined();
    expect(JSON.stringify(adminRow)).not.toContain(privateTask.id);
    expect(JSON.stringify(adminRow)).not.toContain('Owner analytics only');
    expect(JSON.stringify(adminRow)).not.toContain('secret/private-repository');
    expect(adminRow?.details.values.user).toBe(ownerRow?.details.values.user);
  });

  it('labels the project from the latest run environment and applies the cutoff in SQL', async () => {
    const owner = await userFactory.create();
    const auth = { userId: owner.id, isAdmin: true } as UserAuthSuccess;
    const older = await environmentFactory.create({
      createdByUserId: owner.id,
      name: `Older environment ${crypto.randomUUID()}`,
    });
    const latest = await environmentFactory.create({
      createdByUserId: owner.id,
      name: `Latest environment ${crypto.randomUUID()}`,
    });
    const task = await taskFactory.create({
      initiatorUserId: owner.id,
      repositoryName: 'analytics/latest-run',
    });
    await runFactory.create({
      taskId: task.id,
      payload: { repo: 'analytics/latest-run', environmentId: older.id },
    });
    await runFactory.create({
      taskId: task.id,
      payload: { repo: 'analytics/latest-run', environmentId: latest.id },
    });
    const stale = await taskFactory.create({ initiatorUserId: owner.id });
    await db
      .update(tasks)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(tasks.id, stale.id));

    const rows = await getTaskAnalyticsRows(auth, 7, new Date(), 'tasks');

    expect(rows.find(({ id }) => id === task.id)?.dimensions.project).toEqual({
      key: latest.name,
      label: latest.name,
    });
    expect(rows.some(({ id }) => id === stale.id)).toBe(false);
  });
});
