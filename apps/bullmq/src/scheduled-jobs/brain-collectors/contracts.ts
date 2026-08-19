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

export type CollectorResult = {
  pages: CollectorPage[];
  nextSince: Date | null;
  stateUpdates?: CollectorStateUpdate[];
  itemUpdates?: CollectorItemUpdate[];
  itemDeletes?: CollectorItemDelete[];
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
