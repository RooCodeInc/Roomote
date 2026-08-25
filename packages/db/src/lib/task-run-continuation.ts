import { and, gt, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import {
  activeRunStatuses,
  exitedRunStatuses,
  SANDBOX_SNAPSHOT_EXPIRY_MS,
} from '@roomote/types';

export function isTaskRunFollowUpCandidate(
  columns: {
    status: AnyPgColumn;
    canceledAt: AnyPgColumn;
    snapshotId: AnyPgColumn;
    snapshotCreatedAt: AnyPgColumn;
  },
  now = new Date(),
): SQL {
  return or(
    and(
      inArray(columns.status, [...activeRunStatuses]),
      isNull(columns.canceledAt),
    ),
    and(
      inArray(columns.status, [...exitedRunStatuses]),
      isNotNull(columns.snapshotId),
      gt(
        columns.snapshotCreatedAt,
        new Date(now.getTime() - SANDBOX_SNAPSHOT_EXPIRY_MS),
      ),
    ),
  ) as SQL;
}
