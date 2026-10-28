import {
  resolveBrainSourceIdForCollector,
  resolveBrainSourceIdForCurrentCollector,
  type BrainSourceId,
} from '@roomote/types';
import type {
  countBrainCollectorItemsByCollector,
  listBrainSyncStates,
} from '@roomote/db/server';

type SyncState = Awaited<ReturnType<typeof listBrainSyncStates>>[number];

export function groupSyncStatesBySource(
  syncStates: Awaited<ReturnType<typeof listBrainSyncStates>>,
): Map<BrainSourceId, SyncState[]> {
  const statesBySource = new Map<BrainSourceId, SyncState[]>();

  for (const state of syncStates) {
    // Current-version rows only: superseded and auxiliary rows would
    // otherwise inflate stream counts.
    const sourceId = resolveBrainSourceIdForCurrentCollector(state.collectorId);

    if (!sourceId) {
      continue;
    }

    statesBySource.set(sourceId, [
      ...(statesBySource.get(sourceId) ?? []),
      state,
    ]);
  }

  return statesBySource;
}

export function groupItemCountsBySource(
  itemCounts: Awaited<ReturnType<typeof countBrainCollectorItemsByCollector>>,
): Map<BrainSourceId, number> {
  const itemsBySource = new Map<BrainSourceId, number>();

  for (const row of itemCounts) {
    const sourceId = resolveBrainSourceIdForCollector(row.collectorId);

    if (!sourceId) {
      continue;
    }

    itemsBySource.set(sourceId, (itemsBySource.get(sourceId) ?? 0) + row.items);
  }

  return itemsBySource;
}
