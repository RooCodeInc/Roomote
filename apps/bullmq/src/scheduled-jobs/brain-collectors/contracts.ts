export type CollectorPage = {
  slug: string;
  title: string;
  content: string;
  timelineEvidence?: EntityTimelineEvidence[];
};

export type EntityTimelineEvidence = {
  slug: string;
  date: string;
  summary: string;
  detail?: string;
  source: string;
};

export type CollectorStateUpdate = {
  collectorId: string;
  watermark?: Date;
  cursor?: string | null;
  backfillCompletedAt?: Date | null;
};

export type CollectorItemUpdate = {
  collectorId: string;
  itemId: string;
  slug: string;
  lastSeenAt: Date;
};

export type CollectorItemDelete = {
  collectorId: string;
  itemIds: string[];
};

/**
 * A previously emitted page this pass supersedes. The engine soft-deletes it
 * from the Brain (gbrain keeps a recovery window) and then drops its
 * inventory row, only after this pass's own pages have landed.
 */
export type CollectorPageRetirement = {
  collectorId: string;
  itemId: string;
  slug: string;
};

export type CollectorResult = {
  pages: CollectorPage[];
  nextSince: Date | null;
  stateUpdates?: CollectorStateUpdate[];
  itemUpdates?: CollectorItemUpdate[];
  itemDeletes?: CollectorItemDelete[];
  pageRetirements?: CollectorPageRetirement[];
};

export interface BrainCollector {
  id: string;
  displayName: string;
  isEnabled(): Promise<boolean>;
  collect(input: {
    since: Date | null;
    now: Date;
    limit: number;
  }): Promise<CollectorResult>;
  backfill?(input: { cursor: string | null; limit: number }): Promise<{
    pages: CollectorPage[];
    nextCursor: string | null;
    done: boolean;
    itemUpdates?: CollectorItemUpdate[];
    pageRetirements?: CollectorPageRetirement[];
  }>;
}

export type BrainConnection = { baseUrl: string; token: string };

export type BrainSink = (
  page: CollectorPage,
  connection: BrainConnection,
) => Promise<void>;

export type BrainTimelineSink = (
  evidence: EntityTimelineEvidence,
  connection: BrainConnection,
) => Promise<void>;

export type BrainRetireSink = (
  slug: string,
  connection: BrainConnection,
) => Promise<void>;
