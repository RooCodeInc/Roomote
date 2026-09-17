import {
  db,
  eq,
  inArray,
  sessionFactory,
  sessions,
  sessionTasks,
  taskFactory,
  tasks,
  userFactory,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { getSessionAnalyticsRows } from './session-rows';
import { formatAnalyticsDateTime } from './time-buckets';

describe('getSessionAnalyticsRows', () => {
  const sessionIds: string[] = [];
  const taskIds: string[] = [];
  const analyticsAuth = {
    userId: 'analytics-test-user',
    isAdmin: true,
  } as UserAuthSuccess;

  // createdAt is database-generated, so backdate it after insert.
  async function createSessionAt(createdAt: Date) {
    const session = await sessionFactory.create();
    await db
      .update(sessions)
      .set({ createdAt })
      .where(eq(sessions.id, session.id));
    return session;
  }

  afterEach(async () => {
    if (sessionIds.length > 0) {
      await db.delete(sessions).where(inArray(sessions.id, sessionIds));
      sessionIds.length = 0;
    }
    if (taskIds.length > 0) {
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
      taskIds.length = 0;
    }
  });

  it('applies a day-aligned cutoff for finite time periods', async () => {
    const now = new Date('2026-07-16T16:00:00.000Z');
    // Inside the window in every timezone.
    const recentSession = await createSessionAt(
      new Date('2026-07-15T12:00:00.000Z'),
    );
    // After the naive `now - 7 * 24h` instant (2026-07-09T16:00:00Z) but
    // before the day-aligned `startOfDay(subDays(now, 6))` cutoff, so it is
    // excluded once buckets align with getExpectedBuckets.
    const boundarySession = await createSessionAt(
      new Date('2026-07-09T20:00:00.000Z'),
    );
    // Far outside the window.
    const oldSession = await createSessionAt(
      new Date('2026-07-01T12:00:00.000Z'),
    );
    sessionIds.push(recentSession.id, boundarySession.id, oldSession.id);

    const rows = await getSessionAnalyticsRows(analyticsAuth, 7, now);
    const rowIds = new Set(rows.map((row) => row.id));

    expect(rowIds.has(recentSession.id)).toBe(true);
    expect(rowIds.has(boundarySession.id)).toBe(false);
    expect(rowIds.has(oldSession.id)).toBe(false);
  });

  it('maps source surfaces to shared task-source labels and formats dates', async () => {
    const slackSession = await sessionFactory.create({
      sourceSurface: 'slack',
      sourceTrigger: 'message',
    });
    const systemSession = await sessionFactory.create({
      sourceSurface: 'system',
    });
    sessionIds.push(slackSession.id, systemSession.id);

    const rows = await getSessionAnalyticsRows(
      analyticsAuth,
      'all',
      new Date('2026-07-16T16:00:00.000Z'),
    );
    const slackRow = rows.find((row) => row.id === slackSession.id);
    const systemRow = rows.find((row) => row.id === systemSession.id);

    expect(slackRow?.dimensions.source).toEqual({
      key: 'Slack',
      label: 'Slack',
    });
    expect(slackRow?.details.values.source).toBe('Slack');
    expect(slackRow?.details.values.date).toBe(
      formatAnalyticsDateTime(slackSession.createdAt),
    );
    expect(systemRow?.dimensions.source).toEqual({
      key: 'System',
      label: 'System',
    });
  });

  it('counts session task executions with a single grouped join', async () => {
    const sessionWithTasks = await sessionFactory.create();
    const sessionWithoutTasks = await sessionFactory.create();
    sessionIds.push(sessionWithTasks.id, sessionWithoutTasks.id);

    const firstTask = await taskFactory.create();
    const secondTask = await taskFactory.create();
    taskIds.push(firstTask.id, secondTask.id);

    await db.insert(sessionTasks).values([
      {
        sessionId: sessionWithTasks.id,
        taskId: firstTask.id,
        origin: 'direct_launch',
      },
      {
        sessionId: sessionWithTasks.id,
        taskId: secondTask.id,
        origin: 'follow_up',
      },
    ]);

    const rows = await getSessionAnalyticsRows(
      analyticsAuth,
      'all',
      new Date('2026-07-16T16:00:00.000Z'),
    );
    const withTasksRow = rows.find((row) => row.id === sessionWithTasks.id);
    const withoutTasksRow = rows.find(
      (row) => row.id === sessionWithoutTasks.id,
    );

    expect(withTasksRow?.dimensions.hasExecution).toEqual({
      key: 'yes',
      label: 'yes',
    });
    expect(withTasksRow?.details.values.hasExecution).toBe('yes');
    expect(withoutTasksRow?.dimensions.hasExecution).toEqual({
      key: 'no',
      label: 'no',
    });
    // Rows stay one-per-session despite the sessionTasks join.
    expect(rows.filter((row) => row.id === sessionWithTasks.id)).toHaveLength(
      1,
    );
  });

  it('includes private Sessions for every viewer while redacting non-owner details', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    const privateSession = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
      privacy: 'private',
      privateOwnerUserId: owner.id,
      title: 'Owner analytics only',
    });
    sessionIds.push(privateSession.id);

    const ownerRows = await getSessionAnalyticsRows(
      { userId: owner.id, isAdmin: false } as UserAuthSuccess,
      'all',
      new Date(),
    );
    const adminRows = await getSessionAnalyticsRows(
      { userId: other.id, isAdmin: true } as UserAuthSuccess,
      'all',
      new Date(),
    );
    const nonOwnerRows = await getSessionAnalyticsRows(
      { userId: other.id, isAdmin: false } as UserAuthSuccess,
      'all',
      new Date(),
    );
    const ownerRow = ownerRows.find(({ id }) => id === privateSession.id);
    const adminRow = adminRows.find(
      ({ details }) => details.values.sessionTitle === 'Private session',
    );
    const nonOwnerRow = nonOwnerRows.find(
      ({ details }) => details.values.sessionTitle === 'Private session',
    );

    expect(ownerRows.reduce((sum, row) => sum + row.value, 0)).toBe(
      adminRows.reduce((sum, row) => sum + row.value, 0),
    );
    expect(nonOwnerRows.reduce((sum, row) => sum + row.value, 0)).toBe(
      adminRows.reduce((sum, row) => sum + row.value, 0),
    );
    expect(ownerRow).toMatchObject({
      id: privateSession.id,
      details: {
        values: {
          sessionTitle: 'Owner analytics only',
          session: 'Open',
        },
        links: { session: `/sessions/${privateSession.id}` },
      },
    });
    expect(adminRow).toMatchObject({
      id: expect.stringMatching(/^private-session:/),
      dimensions: {
        user: ownerRow?.dimensions.user,
        source: { key: 'Private', label: 'Private' },
        status: { key: 'Private', label: 'Private' },
      },
      details: { values: { sessionTitle: 'Private session' } },
    });
    expect(adminRow?.details.links).toBeUndefined();
    expect(nonOwnerRow).toEqual(adminRow);
    expect(JSON.stringify(adminRow)).not.toContain(privateSession.id);
    expect(JSON.stringify(adminRow)).not.toContain('Owner analytics only');
    expect(adminRow?.details.values.user).toBe(ownerRow?.details.values.user);
  });
});
