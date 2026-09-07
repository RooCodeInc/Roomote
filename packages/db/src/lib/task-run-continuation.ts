import { and, gt, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import {
  activeRunStatuses,
  exitedRunStatuses,
  SNAPSHOT_HARD_EXPIRY_MS,
  SNAPSHOT_PROVIDERS_WITHOUT_APPLICATION_EXPIRY,
} from '@roomote/types';

export function isSnapshotResumableCondition(
  columns: {
    vendor: AnyPgColumn;
    snapshotCreatedAt: AnyPgColumn;
  },
  now = new Date(),
): SQL {
  return and(
    isNotNull(columns.snapshotCreatedAt),
    or(
      inArray(columns.vendor, SNAPSHOT_PROVIDERS_WITHOUT_APPLICATION_EXPIRY),
      gt(
        columns.snapshotCreatedAt,
        new Date(now.getTime() - SNAPSHOT_HARD_EXPIRY_MS),
      ),
    ),
  ) as SQL;
}

export function isTaskRunFollowUpCandidate(
  columns: {
    status: AnyPgColumn;
    canceledAt: AnyPgColumn;
    snapshotId: AnyPgColumn;
    snapshotCreatedAt: AnyPgColumn;
    snapshotFailedAt: AnyPgColumn;
    vendor: AnyPgColumn;
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
      isNull(columns.canceledAt),
      isNotNull(columns.snapshotId),
      isNull(columns.snapshotFailedAt),
      isSnapshotResumableCondition(columns, now),
    ),
  ) as SQL;
}
