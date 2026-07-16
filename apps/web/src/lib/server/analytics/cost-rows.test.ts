import {
  db,
  environmentFactory,
  environments,
  inArray,
  llmUsageEvents,
  runFactory,
  taskFactory,
  taskPullRequests,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { getCostAnalyticsRows } from './cost-rows';

describe('getCostAnalyticsRows', () => {
  const usageEventIds: string[] = [];
  const taskIds: string[] = [];
  const environmentIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    if (usageEventIds.length > 0) {
      await db
        .delete(llmUsageEvents)
        .where(inArray(llmUsageEvents.id, usageEventIds));
      usageEventIds.length = 0;
    }
    if (taskIds.length > 0) {
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
      taskIds.length = 0;
    }
    if (environmentIds.length > 0) {
      await db
        .delete(environments)
        .where(inArray(environments.id, environmentIds));
      environmentIds.length = 0;
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
      userIds.length = 0;
    }
  });

  it('encodes finite time-period cutoffs and excludes older usage', async () => {
    const now = new Date('2026-07-16T16:00:00.000Z');
    const insertedEvents = await db
      .insert(llmUsageEvents)
      .values([
        {
          eventKey: `cost-analytics-recent-${crypto.randomUUID()}`,
          costSource: 'missing',
          costMicroUsd: 1_000_000,
          messageCompletedAt: new Date('2026-07-15T12:00:00.000Z'),
        },
        {
          eventKey: `cost-analytics-old-${crypto.randomUUID()}`,
          costSource: 'missing',
          costMicroUsd: 2_000_000,
          messageCompletedAt: new Date('2026-07-01T12:00:00.000Z'),
        },
      ])
      .returning({ id: llmUsageEvents.id });
    const recentEvent = insertedEvents[0]!;
    const oldEvent = insertedEvents[1]!;

    usageEventIds.push(recentEvent.id, oldEvent.id);

    const rows = await getCostAnalyticsRows({} as UserAuthSuccess, 7, now);
    const rowIds = new Set(rows.map((row) => row.id));

    expect(rowIds.has(recentEvent.id)).toBe(true);
    expect(rowIds.has(oldEvent.id)).toBe(false);
  });

  it('uses the run environment fallback and attributes PRs by distinct task', async () => {
    const user = await userFactory.create();
    userIds.push(user.id);
    const environment = await environmentFactory.create({
      userId: user.id,
      createdByUserId: user.id,
      name: `Cost analytics ${crypto.randomUUID()}`,
    });
    environmentIds.push(environment.id);
    const task = await taskFactory.create({ initiatorUserId: user.id });
    taskIds.push(task.id);
    const run = await runFactory.create({
      taskId: task.id,
      actingUserId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        environmentId: environment.id,
        description: 'Test cost analytics attribution',
      },
    });
    await db.insert(taskPullRequests).values({
      taskId: task.id,
      prUrl: 'https://github.com/roomote/test/pull/42',
      prNumber: 42,
      repository: 'roomote/test',
      sourceControlProvider: 'github',
      host: 'github.com',
    });
    const [usageEvent] = await db
      .insert(llmUsageEvents)
      .values({
        eventKey: `cost-analytics-task-${crypto.randomUUID()}`,
        costSource: 'missing',
        taskId: task.id,
        runId: run.id,
        costMicroUsd: 1_000_000,
        messageCompletedAt: new Date('2026-07-15T12:00:00.000Z'),
      })
      .returning({ id: llmUsageEvents.id });
    usageEventIds.push(usageEvent!.id);

    const rows = await getCostAnalyticsRows(
      {} as UserAuthSuccess,
      7,
      new Date('2026-07-16T16:00:00.000Z'),
    );
    const row = rows.find((candidate) => candidate.id === usageEvent!.id);

    expect(row?.dimensions.project?.label).toBe(environment.name);
    expect(row?.meta?.prKeys).toEqual(['github:github.com:roomote/test#42']);
  });
});
