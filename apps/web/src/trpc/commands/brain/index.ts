import {
  and,
  backfillBrainMemoryEvents,
  countBrainCollectorItemsByCollector,
  db,
  eq,
  getBrainMemoryEventSummary,
  isBrainProviderConfigured,
  isNull,
  resolveModelProviderEnvValue,
  listBrainSyncStates,
  mcpConnections,
  requeueFailedBrainMemoryEvents,
} from '@roomote/db/server';
import {
  describeBrainModels,
  readBrainCorpus,
  readBrainPage,
  readBrainStats,
  resolveBrainSourceRequirements,
  resolveBrainInferenceProvider,
  type BrainCorpusSnapshot,
  type BrainModelSummary,
} from '@roomote/sdk/server';
import {
  BRAIN_MCP_ID,
  BRAIN_SOURCES,
  BRAIN_OTHER_NAMESPACE_ID,
  brainNamespaceLabel,
  resolveBrainNamespaceId,
  isMcpConnectionGbrainConfig,
  parseBrainBackfillCompletedCount,
  resolveBrainSourceIdForCollector,
  resolveBrainSourceIdForCurrentCollector,
  type BrainNamespaceBucketId,
  type BrainSourceId,
  type BrainSourceRequirement,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server/env';

import { assertAdmin } from '../setup/shared';

/**
 * How many recently written pages the Settings page lists under the
 * composition chart. Enough to recognise what the Brain has been learning
 * lately, short enough to stay a glance rather than a log.
 */
const RECENT_PAGE_LIMIT = 8;

const EMPTY_MEMORY_SUMMARY: Awaited<
  ReturnType<typeof getBrainMemoryEventSummary>
> = {
  byStatus: { pending: 0, processing: 0, done: 0, skipped: 0, failed: 0 },
  lastProcessedAt: null,
  lastError: null,
  historicalCompletedRunsWithoutEvent: 0,
  recentCompletedRunsWithoutEvent: 0,
};

/**
 * - `connected`: a Brain is configured, provisioned, and answering.
 * - `unreachable`: configured, but the corpus did not answer. Ingestion is
 *   holding its checkpoints; this is an outage, not data loss.
 * - `incomplete`: half-configured. A Brain container without an inference
 *   provider still answers keyword queries, which is worse than absent
 *   because recall looks real while missing everything semantic — so it is
 *   reported as a fault rather than as a working Brain.
 * - `not_configured`: this deployment has no Brain.
 */
export type BrainStatus =
  | 'connected'
  | 'unreachable'
  | 'incomplete'
  | 'not_configured';

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
  recentPages: Array<{
    slug: string;
    title: string;
    namespaceLabel: string;
    updatedAt: Date | null;
  }>;
};

export type BrainSettings = {
  status: BrainStatus;
  /** Why the status is not `connected`, in one sentence, or null. */
  statusDetail: string | null;
  url: string | null;
  inferenceProvider: 'openrouter' | 'openai' | null;
  /**
   * Whether the serving key is the Brain's own (`R_BRAIN_*`) or the
   * deployment's general provider key. The provider preference order can
   * legitimately pick a general key even when a brain-specific one exists
   * for the other provider, and the page must not claim otherwise.
   */
  keySource: 'brain' | 'deployment' | null;
  /** The models the Brain runs, or null when no provider resolves. */
  models: BrainModelSummary | null;
  /**
   * Recall health. `semantic`/`keyword-only` are measured from gbrain's own
   * embedding counts; `unknown` means the admin census did not answer and
   * the UI falls back to inferring from provider presence.
   */
  recall: {
    mode: 'semantic' | 'keyword-only' | 'unknown';
    embeddedCount: number | null;
    chunkCount: number | null;
  };
  corpus: BrainCorpusSummary;
  sources: BrainSourceSummary[];
  taskMemories: {
    byStatus: Record<
      'pending' | 'processing' | 'done' | 'skipped' | 'failed',
      number
    >;
    total: number;
    lastProcessedAt: Date | null;
    lastError: string | null;
    historicalCompletedRunsWithoutEvent: number;
    recentCompletedRunsWithoutEvent: number;
  };
};

/** Days of page-writing activity summarized for the ingestion chart. */
const ACTIVITY_WINDOW_DAYS = 30;

function buildActivityByDay(
  pages: Array<{ updatedAt: Date | null }>,
): Array<{ date: string; pages: number }> {
  const counts = new Map<string, number>();
  const today = new Date();

  for (let offset = ACTIVITY_WINDOW_DAYS - 1; offset >= 0; offset--) {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - offset);
    counts.set(day.toISOString().slice(0, 10), 0);
  }

  for (const page of pages) {
    if (!page.updatedAt) {
      continue;
    }

    const key = page.updatedAt.toISOString().slice(0, 10);

    if (counts.has(key)) {
      counts.set(key, counts.get(key)! + 1);
    }
  }

  return [...counts.entries()].map(([date, count]) => ({
    date,
    pages: count,
  }));
}

function summarizeCorpus(
  snapshot: Awaited<ReturnType<typeof readBrainCorpus>>,
): BrainCorpusSummary {
  if (!snapshot) {
    return {
      reachable: false,
      listedPages: 0,
      totalPages: null,
      namespaces: [],
      activityByDay: [],
      recentPages: [],
    };
  }

  const counts = new Map<BrainNamespaceBucketId, number>();

  for (const page of snapshot.pages) {
    const namespaceId = resolveBrainNamespaceId(page.slug);
    counts.set(namespaceId, (counts.get(namespaceId) ?? 0) + 1);
  }

  const namespaces = [...counts.entries()]
    .map(([id, pages]) => ({ id, label: brainNamespaceLabel(id), pages }))
    // Largest first, with the catch-all bucket last however big it is: it is
    // the least informative slice and should never lead the chart.
    .sort((left, right) => {
      if (left.id === BRAIN_OTHER_NAMESPACE_ID) return 1;
      if (right.id === BRAIN_OTHER_NAMESPACE_ID) return -1;
      return right.pages - left.pages || left.label.localeCompare(right.label);
    });

  const recentPages = snapshot.pages
    .filter((page) => page.updatedAt)
    .sort(
      (left, right) =>
        (right.updatedAt?.getTime() ?? 0) - (left.updatedAt?.getTime() ?? 0),
    )
    .slice(0, RECENT_PAGE_LIMIT)
    .map((page) => ({
      slug: page.slug,
      title: page.title ?? page.slug,
      namespaceLabel: brainNamespaceLabel(resolveBrainNamespaceId(page.slug)),
      updatedAt: page.updatedAt,
    }));

  return {
    reachable: true,
    listedPages: snapshot.pages.length,
    totalPages: null,
    namespaces,
    activityByDay: buildActivityByDay(snapshot.pages),
    recentPages,
  };
}

/** Exported for unit tests; the command below is its only runtime caller. */
export function summarizeSources(input: {
  syncStates: Awaited<ReturnType<typeof listBrainSyncStates>>;
  itemCounts: Awaited<ReturnType<typeof countBrainCollectorItemsByCollector>>;
  requirements: Record<BrainSourceRequirement, boolean>;
  taskMemoriesActive: boolean;
  taskMemoriesLastProcessedAt: Date | null;
}): BrainSourceSummary[] {
  const statesBySource = new Map<
    BrainSourceId,
    Array<(typeof input.syncStates)[number]>
  >();

  for (const state of input.syncStates) {
    // Current-version rows only: rows a version bump superseded, and
    // auxiliary rows sharing a source's leading segment (inventories,
    // censuses), would otherwise inflate stream counts and report their own
    // completion as the source's.
    const sourceId = resolveBrainSourceIdForCurrentCollector(state.collectorId);

    if (!sourceId) {
      continue;
    }

    statesBySource.set(sourceId, [
      ...(statesBySource.get(sourceId) ?? []),
      state,
    ]);
  }

  const itemsBySource = new Map<BrainSourceId, number>();

  for (const row of input.itemCounts) {
    const sourceId = resolveBrainSourceIdForCollector(row.collectorId);

    if (!sourceId) {
      continue;
    }

    itemsBySource.set(sourceId, (itemsBySource.get(sourceId) ?? 0) + row.items);
  }

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
      // The outbox records when a memory actually landed, which is fresher
      // than the backfill checkpoint its sync-state row carries.
      source.id === 'task-memories' ? input.taskMemoriesLastProcessedAt : null,
    );
    const parents = states.filter((state) =>
      source.collectorIds.includes(state.collectorId),
    );
    const children = states.filter(
      (state) => !source.collectorIds.includes(state.collectorId),
    );
    // A deep replay in progress is a parent row holding only a cursor.
    // A row that also carries a watermark is a live stream whose cursor is a
    // rolling checkpoint or mode-state (pull-request facts, member sweeps,
    // the Notion incremental scan): steady ingestion, not history reading.
    const backfilling = parents.some(
      (state) =>
        state.backfillCursor && !state.backfillCompletedAt && !state.watermark,
    );
    const streams = children.length > 0 ? children.length : states.length;
    const backfillProgress = ((): { read: number; total: number } | null => {
      if (!backfilling) {
        return null;
      }

      for (const parent of parents) {
        if (!parent.backfillCursor || parent.backfillCompletedAt) {
          continue;
        }

        // Fan-out walks record their completed partitions in the cursor;
        // counting rows with a completion timestamp instead would show 0
        // forever, because partition rows never carry one.
        const read = parseBrainBackfillCompletedCount(parent.backfillCursor);

        if (read !== null && children.length > 0) {
          return {
            read: Math.min(read, children.length),
            total: children.length,
          };
        }
      }

      const read = states.filter((state) => state.backfillCompletedAt).length;

      return streams > 0
        ? { read: Math.min(read, streams), total: streams }
        : null;
    })();
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
      backfillProgress,
      trackedItems: itemsBySource.get(source.id) ?? 0,
    };
  });
}

/**
 * Whether Roomote holds usable Brain credentials, read without minting or
 * provisioning anything. Deliberately not `resolveBrainConnection` (which
 * registers OAuth clients headlessly on first use): the corpus read already
 * takes that path once per request, and this check runs strictly after it,
 * so it reads whatever state that attempt left behind rather than racing it.
 */
async function hasBrainCredentials(): Promise<boolean> {
  if (Env.R_GBRAIN_AGENT_TOKEN) {
    return true;
  }

  const stored = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, BRAIN_MCP_ID),
      isNull(mcpConnections.userId),
    ),
  });

  return isMcpConnectionGbrainConfig(stored?.authConfig);
}

export async function getBrainSettingsCommand(
  auth: UserAuthSuccess,
): Promise<BrainSettings> {
  assertAdmin(auth);

  // Activation is the explicit brain-specific provider key, in Settings or
  // the environment. The gateway token and R_GBRAIN_URL exist as plumbing on
  // deployments that never opted in, so neither can mean "the Brain is on".
  const configured = await isBrainProviderConfigured();
  const url = Env.R_GBRAIN_URL ?? null;

  // The rollups only describe a Brain that exists; on an unconfigured
  // deployment they would scan real tables (the missing-memory check
  // anti-joins task runs) just to be thrown away by the status card.
  const [
    inference,
    corpusSnapshot,
    stats,
    syncStates,
    itemCounts,
    memories,
    requirements,
  ] = await Promise.all([
    resolveBrainInferenceProvider(),
    configured ? readBrainCorpus() : null,
    configured ? readBrainStats() : null,
    configured ? listBrainSyncStates(db) : [],
    configured ? countBrainCollectorItemsByCollector(db) : [],
    configured ? getBrainMemoryEventSummary(db) : EMPTY_MEMORY_SUMMARY,
    resolveBrainSourceRequirements(),
  ]);

  const corpus = summarizeCorpus(corpusSnapshot);

  corpus.totalPages = stats?.pageCount ?? null;

  // Measured, not inferred: gbrain's own census says whether chunks are
  // actually embedded. Chunks with zero embeddings is the keyword-only
  // silent failure this page exists to catch.
  const recall: BrainSettings['recall'] =
    stats && (stats.chunkCount ?? 0) > 0
      ? {
          mode: (stats.embeddedCount ?? 0) > 0 ? 'semantic' : 'keyword-only',
          embeddedCount: stats.embeddedCount,
          chunkCount: stats.chunkCount,
        }
      : { mode: 'unknown', embeddedCount: null, chunkCount: null };

  // Read only after (and only when) the corpus failed to answer: it decides
  // between "credentials not provisioned yet" and "service down", and the
  // corpus read above is the call that may have just provisioned them.
  const provisioned =
    configured && !corpus.reachable ? await hasBrainCredentials() : true;

  const keySource: BrainSettings['keySource'] = !inference
    ? null
    : (
          await resolveModelProviderEnvValue([
            inference.providerId === 'openrouter'
              ? 'R_BRAIN_OPENROUTER_API_KEY'
              : 'R_BRAIN_OPENAI_API_KEY',
          ])
        )?.trim()
      ? 'brain'
      : 'deployment';
  const memoryTotal = Object.values(memories.byStatus).reduce(
    (total, value) => total + value,
    0,
  );

  const { status, statusDetail } = ((): {
    status: BrainStatus;
    statusDetail: string | null;
  } => {
    if (!configured) {
      return {
        status: 'not_configured',
        statusDetail:
          'This deployment has no Brain. Set a Brain provider key to give agents shared memory.',
      };
    }

    if (!url) {
      return {
        status: 'incomplete',
        statusDetail:
          'A Brain provider key is set, but no Brain service URL is configured, so there is nowhere to store memories.',
      };
    }

    if (!inference) {
      return {
        status: 'incomplete',
        statusDetail:
          'The Brain has no inference provider, so it can only match keywords. Configure a Brain provider key to enable semantic recall.',
      };
    }

    if (corpus.reachable) {
      return { status: 'connected', statusDetail: null };
    }

    if (!provisioned) {
      return {
        status: 'incomplete',
        statusDetail:
          'Roomote has not been able to provision its Brain credentials yet. This resolves on its own once the Brain has started.',
      };
    }

    return {
      status: 'unreachable',
      statusDetail:
        'The Brain did not answer. Ingestion holds its position while it is down, so nothing is lost.',
    };
  })();

  return {
    status,
    statusDetail,
    url,
    inferenceProvider: inference?.providerId ?? null,
    keySource,
    models: inference ? describeBrainModels(inference.providerId) : null,
    recall,
    corpus,
    sources: summarizeSources({
      syncStates,
      itemCounts,
      requirements,
      taskMemoriesActive: memoryTotal > 0,
      taskMemoriesLastProcessedAt: memories.lastProcessedAt,
    }),
    taskMemories: {
      byStatus: memories.byStatus,
      total: memoryTotal,
      lastProcessedAt: memories.lastProcessedAt,
      lastError: memories.lastError,
      historicalCompletedRunsWithoutEvent:
        memories.historicalCompletedRunsWithoutEvent,
      recentCompletedRunsWithoutEvent: memories.recentCompletedRunsWithoutEvent,
    },
  };
}

/**
 * Enqueue a memory for every completed run that does not have one. Idempotent
 * by the outbox's unique(runId), so running it twice costs nothing; the
 * drainer distills the backlog newest-first.
 */
export async function backfillBrainTaskMemoriesCommand(
  auth: UserAuthSuccess,
): Promise<{ queued: number }> {
  assertAdmin(auth);

  return { queued: await backfillBrainMemoryEvents(db) };
}

export async function retryFailedBrainTaskMemoriesCommand(
  auth: UserAuthSuccess,
): Promise<{ requeued: number }> {
  assertAdmin(auth);

  return { requeued: await requeueFailedBrainMemoryEvents(db) };
}

export type BrainPageListing = {
  reachable: boolean;
  total: number;
  nextOffset: number | null;
  pages: Array<{
    slug: string;
    title: string;
    namespaceId: BrainNamespaceBucketId;
    namespaceLabel: string;
    updatedAt: Date | null;
  }>;
};

function toListedPage(page: {
  slug: string;
  title: string | null;
  updatedAt: Date | null;
}): BrainPageListing['pages'][number] {
  const namespaceId = resolveBrainNamespaceId(page.slug);

  return {
    slug: page.slug,
    title: page.title ?? page.slug,
    namespaceId,
    namespaceLabel: brainNamespaceLabel(namespaceId),
    updatedAt: page.updatedAt,
  };
}

/** Exported for focused command tests; the command below owns auth and I/O. */
export function paginateBrainCorpus(
  snapshot: BrainCorpusSnapshot,
  input: {
    search?: string;
    namespaceId?: string;
    offset: number;
    limit: number;
  },
): Omit<BrainPageListing, 'reachable'> {
  const needle = input.search?.trim().toLowerCase() ?? '';
  const filtered = snapshot.pages.filter((page) => {
    const namespaceId = resolveBrainNamespaceId(page.slug);

    return (
      (!input.namespaceId || namespaceId === input.namespaceId) &&
      (!needle ||
        page.slug.toLowerCase().includes(needle) ||
        page.title?.toLowerCase().includes(needle))
    );
  });
  const pages = filtered
    .slice(input.offset, input.offset + input.limit)
    .map(toListedPage);

  return {
    total: filtered.length,
    nextOffset:
      input.offset + pages.length < filtered.length
        ? input.offset + pages.length
        : null,
    pages,
  };
}

/**
 * One server-filtered page from the exhaustive cached corpus. The browser only
 * renders this bounded result, so searching a large Brain does not ship or
 * repeatedly filter the full listing on every keystroke.
 */
export async function listBrainPagesCommand(
  auth: UserAuthSuccess,
  input: {
    search?: string;
    namespaceId?: string;
    offset: number;
    limit: number;
  },
): Promise<BrainPageListing> {
  assertAdmin(auth);

  const snapshot = await readBrainCorpus();

  if (!snapshot) {
    return { reachable: false, total: 0, nextOffset: null, pages: [] };
  }

  return { reachable: true, ...paginateBrainCorpus(snapshot, input) };
}

/**
 * How much of a page body the preview ships. A Brain page can be an entire
 * day of channel history; the dialog is a reading pane, not an export.
 */
const PAGE_CONTENT_PREVIEW_LIMIT = 32_000;

type BrainPageContent = {
  slug: string;
  title: string;
  updatedAt: Date | null;
  /**
   * The page body as the Brain stores it. Untrusted content distilled from
   * tasks and integrations: the client renders it as plain text.
   */
  content: string | null;
  /** The body exceeded the preview bound and was cut. */
  contentTruncated: boolean;
};

export async function getBrainPageCommand(
  auth: UserAuthSuccess,
  input: { slug: string },
): Promise<BrainPageContent | null> {
  assertAdmin(auth);

  const page = await readBrainPage(input.slug);

  if (!page) {
    return null;
  }

  const contentTruncated =
    (page.content?.length ?? 0) > PAGE_CONTENT_PREVIEW_LIMIT;

  return {
    slug: page.slug,
    title: page.title ?? page.slug,
    updatedAt: page.updatedAt,
    content: contentTruncated
      ? page.content!.slice(0, PAGE_CONTENT_PREVIEW_LIMIT)
      : page.content,
    contentTruncated,
  };
}
