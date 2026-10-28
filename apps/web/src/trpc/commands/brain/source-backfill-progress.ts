import { parseBrainBackfillCompletedCount } from '@roomote/types';
import type { listBrainSyncStates } from '@roomote/db/server';

type SyncState = Awaited<ReturnType<typeof listBrainSyncStates>>[number];

/**
 * A deep replay in progress is a parent row holding only a cursor. A row
 * that also carries a watermark is a live stream whose cursor is a rolling
 * checkpoint: steady ingestion, not history reading.
 */
export function sourceBackfillProgress(
  parents: SyncState[],
  children: SyncState[],
  states: SyncState[],
  streams: number,
  backfilling: boolean,
): { read: number; total: number } | null {
  if (!backfilling) {
    return null;
  }

  for (const parent of parents) {
    if (!parent.backfillCursor || parent.backfillCompletedAt) {
      continue;
    }

    // Fan-out walks record completed partitions in the cursor; counting
    // rows with a completion timestamp would show 0 forever.
    const read = parseBrainBackfillCompletedCount(parent.backfillCursor);

    if (read !== null && children.length > 0) {
      return {
        read: Math.min(read, children.length),
        total: children.length,
      };
    }
  }

  const read = states.filter((state) => state.backfillCompletedAt).length;

  return streams > 0 ? { read: Math.min(read, streams), total: streams } : null;
}
