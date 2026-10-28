import {
  BRAIN_OTHER_NAMESPACE_ID,
  brainNamespaceLabel,
  resolveBrainNamespaceId,
  type BrainNamespaceBucketId,
} from '@roomote/types';
import type { readBrainCorpus } from '@roomote/sdk/server';

import type { BrainCorpusSummary } from './brain-corpus-types';

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

export function summarizeCorpus(
  snapshot: Awaited<ReturnType<typeof readBrainCorpus>>,
): BrainCorpusSummary {
  if (!snapshot) {
    return {
      reachable: false,
      listedPages: 0,
      totalPages: null,
      namespaces: [],
      activityByDay: [],
    };
  }

  const counts = new Map<BrainNamespaceBucketId, number>();

  for (const page of snapshot.pages) {
    const namespaceId = resolveBrainNamespaceId(page.slug);
    counts.set(namespaceId, (counts.get(namespaceId) ?? 0) + 1);
  }

  const namespaces = [...counts.entries()]
    .map(([id, pages]) => ({ id, label: brainNamespaceLabel(id), pages }))
    .sort((left, right) => {
      if (left.id === BRAIN_OTHER_NAMESPACE_ID) return 1;
      if (right.id === BRAIN_OTHER_NAMESPACE_ID) return -1;
      return right.pages - left.pages || left.label.localeCompare(right.label);
    });

  return {
    reachable: true,
    listedPages: snapshot.pages.length,
    totalPages: null,
    namespaces,
    activityByDay: buildActivityByDay(snapshot.pages),
  };
}
