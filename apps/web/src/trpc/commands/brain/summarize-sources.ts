import {
  countBrainCollectorItemsByCollector,
  listBrainSyncStates,
} from '@roomote/db/server';
import {
  BRAIN_SOURCES,
  brainNamespaceLabel,
  type BrainSourceRequirement,
} from '@roomote/types';

import type { BrainSourceSummary } from './brain-source-types';
import { sourceBackfillProgress } from './source-backfill-progress';
import {
  groupItemCountsBySource,
  groupSyncStatesBySource,
} from './source-sync-groups';

/** Exported for unit tests; the settings command is its only runtime caller. */
export function summarizeSources(input: {
  syncStates: Awaited<ReturnType<typeof listBrainSyncStates>>;
  itemCounts: Awaited<ReturnType<typeof countBrainCollectorItemsByCollector>>;
  requirements: Record<BrainSourceRequirement, boolean>;
  taskMemoriesActive: boolean;
  taskMemoriesLastProcessedAt: Date | null;
}): BrainSourceSummary[] {
  const statesBySource = groupSyncStatesBySource(input.syncStates);
  const itemsBySource = groupItemCountsBySource(input.itemCounts);

  return BRAIN_SOURCES.map((source) => {
    const states = statesBySource.get(source.id) ?? [];
    const connected = source.requires
      ? input.requirements[source.requires]
      : true;
    const lastSyncedAt = states.reduce<Date | null>(
      (latest, state) =>
        state.watermark && (!latest || state.watermark > latest)
          ? state.watermark
          : latest,
      source.id === 'task-memories' ? input.taskMemoriesLastProcessedAt : null,
    );
    const parents = states.filter((state) =>
      source.collectorIds.includes(state.collectorId),
    );
    const children = states.filter(
      (state) => !source.collectorIds.includes(state.collectorId),
    );
    const backfilling = parents.some(
      (state) =>
        state.backfillCursor && !state.backfillCompletedAt && !state.watermark,
    );
    const streams = children.length > 0 ? children.length : states.length;
    const active =
      source.id === 'task-memories'
        ? input.taskMemoriesActive || states.length > 0
        : states.length > 0;

    return {
      id: source.id,
      label: source.label,
      description: source.description,
      namespaceLabel: brainNamespaceLabel(source.namespaceId),
      status: !connected
        ? ('not_connected' as const)
        : backfilling
          ? ('backfilling' as const)
          : active
            ? ('ingesting' as const)
            : ('idle' as const),
      lastSyncedAt,
      streams,
      backfillProgress: sourceBackfillProgress(
        parents,
        children,
        states,
        streams,
        backfilling,
      ),
      trackedItems: itemsBySource.get(source.id) ?? 0,
    };
  });
}
