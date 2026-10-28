import type { BrainSourceId } from '@roomote/types';

export type BrainSourceStatus =
  | 'ingesting'
  | 'backfilling'
  | 'idle'
  | 'not_connected';

export type BrainSourceSummary = {
  id: BrainSourceId;
  label: string;
  description: string;
  namespaceLabel: string;
  status: BrainSourceStatus;
  /** Newest checkpoint across the source's partitions. */
  lastSyncedAt: Date | null;
  /** Live partitions (channels, repositories, workspaces) being read. */
  streams: number;
  /** Deep-replay progress while `backfilling`, or null when unknowable. */
  backfillProgress: { read: number; total: number } | null;
  /** Upstream objects this source is tracking (pages it owns and refreshes). */
  trackedItems: number;
};
