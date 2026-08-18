import {
  and,
  backfillBrainMemoryEvents,
  countBrainCollectorItemsByCollector,
  db,
  deploymentMcpEnablements,
  eq,
  getBrainMemoryEventSummary,
  isNull,
  listBrainSyncStates,
  mcpConnections,
  requeueFailedBrainMemoryEvents,
  slackInstallations,
} from '@roomote/db/server';
import {
  hasBrainGithubSources,
  readBrainCorpusSample,
  resolveBrainInferenceProvider,
} from '@roomote/sdk/server';
import {
  BRAIN_MCP_ID,
  BRAIN_SOURCES,
  BRAIN_OTHER_NAMESPACE_ID,
  brainNamespaceLabel,
  resolveBrainNamespaceId,
  isMcpConnectionGbrainConfig,
  resolveBrainSourceIdForCollector,
  type BrainNamespaceBucketId,
  type BrainSourceId,
  type BrainSourceRequirement,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { Env, isBrainConfigured } from '@/lib/server/env';

import { assertAdmin } from '../setup/shared';

/**
 * How many recently written pages the Settings page lists under the
 * composition chart. Enough to recognise what the Brain has been learning
 * lately, short enough to stay a glance rather than a log.
 */
const RECENT_PAGE_LIMIT = 8;

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
  /** Sync-state rows: one per workspace or channel for fanned-out sources. */
  partitions: number;
  /** Partitions whose one-time deep history sweep has finished. */
  partitionsBackfilled: number;
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
  /** Pages in the sample, which is the whole corpus unless `truncated`. */
  sampledPages: number;
  truncated: boolean;
  namespaces: BrainNamespaceSummary[];
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
    completedRunsWithoutEvent: number;
  };
};

async function isDeploymentMcpConnected(mcpId: string): Promise<boolean> {
  const connection = await db.query.mcpConnections.findFirst({
    columns: { id: true },
    where: and(
      eq(mcpConnections.mcpId, mcpId),
      isNull(mcpConnections.userId),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.authStatus, 'authenticated'),
    ),
  });

  return Boolean(connection);
}

async function isNotionConnected(): Promise<boolean> {
  const [connected, enablement] = await Promise.all([
    isDeploymentMcpConnected('notion'),
    db.query.deploymentMcpEnablements.findFirst({
      columns: { mcpId: true },
      where: and(
        eq(deploymentMcpEnablements.mcpId, 'notion'),
        eq(deploymentMcpEnablements.enabled, true),
      ),
    }),
  ]);

  return connected && Boolean(enablement);
}

async function isSlackConnected(): Promise<boolean> {
  const installation = await db.query.slackInstallations.findFirst({
    columns: { id: true },
    where: eq(slackInstallations.isActive, true),
  });

  return Boolean(installation);
}

/**
 * Whether each source has something upstream to read. Mirrors the collectors'
 * own enablement checks rather than reading a stored flag, because there is no
 * flag: a source is on when its integration is connected. Resolved once per
 * request and shared, so six sources do not issue six copies of the same
 * lookup.
 */
async function resolveSourceRequirements(): Promise<
  Record<BrainSourceRequirement, boolean>
> {
  const [slack, notion, granola, github] = await Promise.all([
    isSlackConnected(),
    isNotionConnected(),
    isDeploymentMcpConnected('granola'),
    hasBrainGithubSources(),
  ]);

  return { slack, notion, granola, github };
}

function summarizeCorpus(
  snapshot: Awaited<ReturnType<typeof readBrainCorpusSample>>,
): BrainCorpusSummary {
  if (!snapshot) {
    return {
      reachable: false,
      sampledPages: 0,
      truncated: false,
      namespaces: [],
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
    sampledPages: snapshot.pages.length,
    truncated: snapshot.truncated,
    namespaces,
    recentPages,
  };
}

function summarizeSources(input: {
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
    const sourceId = resolveBrainSourceIdForCollector(state.collectorId);

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
      source.collectorIdPrefix ? null : input.taskMemoriesLastProcessedAt,
    );
    const partitionsBackfilled = states.filter(
      (state) => state.backfillCompletedAt,
    ).length;
    const backfilling = states.some(
      (state) => state.backfillCursor && !state.backfillCompletedAt,
    );
    const active = source.collectorIdPrefix
      ? states.length > 0
      : input.taskMemoriesActive;

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
      partitions: states.length,
      partitionsBackfilled,
      trackedItems: itemsBySource.get(source.id) ?? 0,
    };
  });
}

/**
 * Whether Roomote holds usable Brain credentials, read without minting or
 * provisioning anything. Deliberately not `resolveBrainConnection`: that call
 * registers OAuth clients headlessly the first time, and viewing a settings
 * page should never be the thing that provisions them — least of all
 * concurrently with the corpus read, which already takes that path once.
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

  const configured = isBrainConfigured();
  const url = Env.R_GBRAIN_URL ?? null;

  const [
    inference,
    provisioned,
    corpusSnapshot,
    syncStates,
    itemCounts,
    memories,
    requirements,
  ] = await Promise.all([
    resolveBrainInferenceProvider(),
    configured ? hasBrainCredentials() : false,
    configured ? readBrainCorpusSample() : null,
    listBrainSyncStates(db),
    countBrainCollectorItemsByCollector(db),
    getBrainMemoryEventSummary(db),
    resolveSourceRequirements(),
  ]);

  const corpus = summarizeCorpus(corpusSnapshot);
  const memoryTotal = Object.values(memories.byStatus).reduce(
    (total, value) => total + value,
    0,
  );

  const { status, statusDetail } = ((): {
    status: BrainStatus;
    statusDetail: string | null;
  } => {
    if (!configured || !url) {
      return {
        status: 'not_configured',
        statusDetail:
          'This deployment has no Brain. Supply a Brain provider key and Brain URL to give agents shared memory.',
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
      completedRunsWithoutEvent: memories.completedRunsWithoutEvent,
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
