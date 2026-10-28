import type { BrainNamespaceBucketId } from '@roomote/types';

export type BrainNamespaceSummary = {
  id: BrainNamespaceBucketId;
  label: string;
  pages: number;
};

export type BrainCorpusSummary = {
  reachable: boolean;
  /** Pages in the exhaustive cached corpus listing. */
  listedPages: number;
  /**
   * The corpus's exact page count from gbrain's admin census, or null when
   * the admin API did not answer.
   */
  totalPages: number | null;
  namespaces: BrainNamespaceSummary[];
  /**
   * Pages written per UTC day over the trailing window, oldest first,
   * zero-filled. Computed from the exhaustive corpus listing.
   */
  activityByDay: Array<{ date: string; pages: number }>;
};
