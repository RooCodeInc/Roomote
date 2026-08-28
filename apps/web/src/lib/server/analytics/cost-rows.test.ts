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

import {
  aggregateCostAnalyticsRowsByTask,
  getCostAnalyticsRows,
} from './cost-rows';
import type { AnalyticsRow } from './types';

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
    const usageEvents = await db
      .insert(llmUsageEvents)
      .values([
        {
          eventKey: `cost-analytics-task-${crypto.randomUUID()}`,
          source: 'task_title_generation',
          costSource: 'missing',
          taskId: task.id,
          runId: run.id,
          costMicroUsd: 1_000_000,
          messageCompletedAt: new Date('2026-07-15T12:00:00.000Z'),
        },
        {
          eventKey: `cost-analytics-task-${crypto.randomUUID()}`,
          costSource: 'missing',
          taskId: task.id,
          runId: run.id,
          costMicroUsd: 500_000,
          messageCompletedAt: new Date('2026-07-14T12:00:00.000Z'),
        },
      ])
      .returning({ id: llmUsageEvents.id });
    usageEventIds.push(...usageEvents.map((event) => event.id));

    const rows = await getCostAnalyticsRows(
      {} as UserAuthSuccess,
      'all',
      new Date('2026-07-16T16:00:00.000Z'),
    );
    const row = rows.find((candidate) => candidate.id === usageEvents[0]!.id);

    expect(row?.dimensions.project?.label).toBe(environment.name);
    expect(row?.dimensions.source).toEqual({
      key: 'task_title_generation',
      label: 'task_title_generation',
    });
    expect(row?.details.values.source).toBe('task_title_generation');
    expect(row?.meta?.prKeys).toEqual(['github:github.com:roomote/test#42']);
  });

  it('includes Fast parent and advisor/judge usage in Costs', async () => {
    const user = await userFactory.create();
    userIds.push(user.id);
    const insertedEvents = await db
      .insert(llmUsageEvents)
      .values(
        ['build', 'advisor', 'judge'].map((agent, index) => ({
          eventKey: `fast-cost-analytics-${agent}-${crypto.randomUUID()}`,
          source: 'fast_agent',
          userId: user.id,
          harnessSessionId: `fast-session-${agent}`,
          messageId: `fast-message-${agent}`,
          providerId: 'openrouter',
          modelId: 'openai/gpt-5.4',
          agent,
          costSource: 'opencode_message' as const,
          costMicroUsd: (index + 1) * 1_000,
          messageCompletedAt: new Date(`2026-07-15T12:00:0${index}.000Z`),
        })),
      )
      .returning({ id: llmUsageEvents.id });
    usageEventIds.push(...insertedEvents.map((event) => event.id));

    const rows = await getCostAnalyticsRows(
      {} as UserAuthSuccess,
      'all',
      new Date('2026-07-16T16:00:00.000Z'),
    );
    const fastRows = rows.filter((row) =>
      insertedEvents.some((event) => event.id === row.id),
    );

    expect(fastRows).toHaveLength(3);
    expect(
      fastRows.map((row) => row.value).reduce((sum, cost) => sum + cost),
    ).toBe(0.006);
    expect(fastRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimensions: expect.objectContaining({
            source: { key: 'fast_agent', label: 'fast_agent' },
            taskType: {
              key: 'Non-task inference',
              label: 'Non-task inference',
            },
            user: expect.objectContaining({ key: `user:${user.id}` }),
          }),
        }),
      ]),
    );
  });
});

describe('aggregateCostAnalyticsRowsByTask', () => {
  function createRow({
    id,
    taskId,
    cost,
    model = 'gpt-5.6-sol',
    timestamp,
  }: {
    id: string;
    taskId?: string;
    cost: number;
    model?: string;
    timestamp: string;
  }): AnalyticsRow {
    return {
      id,
      timestamp: new Date(timestamp),
      value: cost,
      dimensions: {},
      details: {
        id,
        values: {
          date: timestamp,
          taskType: taskId ? 'Manual' : 'Non-task inference',
          project: 'Roomote',
          source: 'opencode',
          provider: 'openai',
          model,
          cost: cost.toFixed(2),
          taskTitle: taskId ? 'Analyze analytics costs' : 'Non-task inference',
        },
      },
      meta: { canonicalTaskId: taskId },
    };
  }

  it('sums usage events into one row per task', () => {
    const rows = aggregateCostAnalyticsRowsByTask([
      createRow({
        id: 'usage-2',
        taskId: 'task-1',
        cost: 1.25,
        timestamp: '2026-08-15T12:00:00.000Z',
      }),
      createRow({
        id: 'usage-1',
        taskId: 'task-1',
        cost: 2.5,
        model: 'gpt-5.4',
        timestamp: '2026-08-15T10:00:00.000Z',
      }),
      createRow({
        id: 'usage-3',
        taskId: 'task-2',
        cost: 4,
        timestamp: '2026-08-15T11:00:00.000Z',
      }),
      createRow({
        id: 'usage-4',
        cost: 0.5,
        timestamp: '2026-08-15T09:00:00.000Z',
      }),
    ]);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: 'task:task-1',
      value: 3.75,
      details: {
        id: 'task:task-1',
        values: {
          cost: '3.75',
          model: 'Multiple',
          taskTitle: 'Analyze analytics costs',
        },
      },
    });
    expect(rows[1]).toMatchObject({ id: 'task:task-2', value: 4 });
    expect(rows[2]).toMatchObject({ id: 'usage-4', value: 0.5 });
  });
});
