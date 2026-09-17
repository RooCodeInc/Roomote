import { getSessionStatusLabel, type TaskSurface } from '@roomote/types';
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
import { createLabelBackedDimensionValue, mapTaskSource } from './dimensions';
import {
  canViewPrivateAnalyticsDetails,
  createPrivateAnalyticsIdMapper,
  PRIVATE_SESSION_LABEL,
  privateAnalyticsDimensionValue,
} from './privacy';
import {
  formatAnalyticsDateTime,
  formatPrivateAnalyticsDate,
  getTimeCutoff,
} from './time-buckets';

export async function getSessionAnalyticsRows(
  auth: UserAuthSuccess,
  timePeriod: TimePeriodFilter | undefined,
  now: Date,
): Promise<AnalyticsRow[]> {
  const cutoff = getTimeCutoff(timePeriod, now);

  const executionCounts = db
    .select({
      sessionId: sessionTasks.sessionId,
      executionCount: sql<number>`count(*)::int`.as('execution_count'),
    })
    .from(sessionTasks)
    .groupBy(sessionTasks.sessionId)
    .as('execution_counts');

  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      ownerName: users.name,
      ownerEmail: users.email,
      source: sessions.sourceSurface,
      ownerKind: sessions.ownerKind,
      executionCount: sql<number>`coalesce(${executionCounts.executionCount}, 0)::int`,
      status: sessions.cachedStatus,
      createdAt: sessions.createdAt,
      privacy: sessions.privacy,
      privateOwnerUserId: sessions.privateOwnerUserId,
    })
    .from(sessions)
    .leftJoin(users, eq(users.id, sessions.ownerUserId))
    .leftJoin(executionCounts, eq(executionCounts.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.visibility, 'visible'),
        cutoff ? gte(sessions.createdAt, cutoff) : undefined,
      ),
    );

  const getPrivateId = createPrivateAnalyticsIdMapper('private-session');

  return rows.map<AnalyticsRow>((row) => {
    const owner =
      getUserDisplayName({ name: row.ownerName, email: row.ownerEmail }) ??
      'System';
    const canViewDetails = canViewPrivateAnalyticsDetails(auth, row);
    if (!canViewDetails) {
      const id = getPrivateId(row.id);
      const values: Record<string, string> = {
        date: formatPrivateAnalyticsDate(row.createdAt),
        user: owner,
        source: PRIVATE_SESSION_LABEL,
        status: PRIVATE_SESSION_LABEL,
        ownerKind: PRIVATE_SESSION_LABEL,
        hasExecution: PRIVATE_SESSION_LABEL,
        sessionTitle: PRIVATE_SESSION_LABEL,
      };
      return {
        id,
        timestamp: row.createdAt,
        value: 1,
        dimensions: {
          user: { key: owner, label: owner },
          status: privateAnalyticsDimensionValue,
          source: privateAnalyticsDimensionValue,
          ownerKind: privateAnalyticsDimensionValue,
          hasExecution: privateAnalyticsDimensionValue,
        },
        details: {
          id,
          values,
        },
      } satisfies AnalyticsRow;
    }

    const status = row.status ?? 'ready';
    const hasExecution = row.executionCount > 0 ? 'yes' : 'no';
    // Session source surfaces are the task surfaces (plus 'automation', which
    // maps to the System source like other non-user-facing surfaces).
    const sourceLabel = mapTaskSource(row.source as TaskSurface);
    return {
      id: row.id,
      timestamp: row.createdAt,
      value: 1,
      dimensions: {
        user: { key: owner, label: owner },
        status: { key: status, label: getSessionStatusLabel(status) },
        source: createLabelBackedDimensionValue(sourceLabel),
        ownerKind: { key: row.ownerKind, label: row.ownerKind },
        hasExecution: { key: hasExecution, label: hasExecution },
      },
      details: {
        id: row.id,
        values: {
          date: formatAnalyticsDateTime(row.createdAt),
          user: owner,
          source: sourceLabel,
          status,
          ownerKind: row.ownerKind,
          hasExecution,
          sessionTitle: row.title,
          session: 'Open',
        },
        links: { session: `/sessions/${row.id}` },
      },
    } satisfies AnalyticsRow;
  });
}
