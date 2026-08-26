import {
  and,
  db,
  eq,
  gte,
  sessions,
  sessionTasks,
  sql,
  users,
} from '@roomote/db/server';

import type { TimePeriodFilter, UserAuthSuccess } from '@/types';
import { getUserDisplayName } from '@/lib';

import type { AnalyticsRow } from './types';

export async function getSessionAnalyticsRows(
  _auth: UserAuthSuccess,
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Promise<AnalyticsRow[]> {
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      ownerName: users.name,
      ownerEmail: users.email,
      source: sessions.sourceSurface,
      ownerKind: sessions.ownerKind,
      executionCount: sql<number>`(
        select count(*)::int from ${sessionTasks}
        where ${sessionTasks.sessionId} = ${sessions.id}
      )`,
      status: sessions.cachedStatus,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .leftJoin(users, eq(users.id, sessions.ownerUserId))
    .where(
      and(
        eq(sessions.visibility, 'visible'),
        timePeriod && timePeriod !== 'all'
          ? gte(
              sessions.createdAt,
              new Date(now.getTime() - timePeriod * 24 * 60 * 60 * 1000),
            )
          : undefined,
      ),
    );

  return rows.map((row) => {
    const owner =
      getUserDisplayName({ name: row.ownerName, email: row.ownerEmail }) ??
      'System';
    const status = row.status ?? 'ready';
    const hasExecution = row.executionCount > 0 ? 'yes' : 'no';
    return {
      id: row.id,
      timestamp: row.createdAt,
      value: 1,
      dimensions: {
        user: { key: owner, label: owner },
        status: { key: status, label: status.replace('_', ' ') },
        source: { key: row.source, label: row.source },
        ownerKind: { key: row.ownerKind, label: row.ownerKind },
        hasExecution: { key: hasExecution, label: hasExecution },
      },
      details: {
        id: row.id,
        values: {
          date: row.createdAt.toISOString(),
          user: owner,
          source: row.source,
          status,
          ownerKind: row.ownerKind,
          hasExecution,
          sessionTitle: row.title,
          session: 'Open',
        },
        links: { session: `/sessions/${row.id}` },
      },
    };
  });
}
