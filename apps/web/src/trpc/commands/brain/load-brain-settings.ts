import {
  countBrainCollectorItemsByCollector,
  db,
  getBrainMemoryEventSummary,
  listBrainSyncStates,
} from '@roomote/db/server';
import {
  isBrainEmbeddingAvailable,
  readBrainCorpus,
  readBrainStats,
  resolveBrainSourceRequirements,
  resolveBrainInferenceProvider,
} from '@roomote/sdk/server';

import type { BrainSettings } from './brain-settings-types';
import { summarizeCorpus } from './summarize-corpus';

const EMPTY_MEMORY_SUMMARY: Awaited<
  ReturnType<typeof getBrainMemoryEventSummary>
> = {
  byStatus: { pending: 0, processing: 0, done: 0, skipped: 0, failed: 0 },
  lastProcessedAt: null,
  lastError: null,
  historicalCompletedRunsWithoutEvent: 0,
  recentCompletedRunsWithoutEvent: 0,
};

export async function loadBrainSettings(configured: boolean) {
  const [
    inference,
    corpusSnapshot,
    stats,
    syncStates,
    itemCounts,
    memories,
    requirements,
    embeddingsAvailable,
  ] = await Promise.all([
    resolveBrainInferenceProvider(),
    configured ? readBrainCorpus() : null,
    configured ? readBrainStats() : null,
    configured ? listBrainSyncStates(db) : [],
    configured ? countBrainCollectorItemsByCollector(db) : [],
    configured ? getBrainMemoryEventSummary(db) : EMPTY_MEMORY_SUMMARY,
    resolveBrainSourceRequirements(),
    isBrainEmbeddingAvailable(),
  ]);

  const corpus = summarizeCorpus(corpusSnapshot);
  corpus.totalPages = stats?.pageCount ?? null;

  const recall: BrainSettings['recall'] =
    stats && (stats.chunkCount ?? 0) > 0
      ? {
          mode: (stats.embeddedCount ?? 0) > 0 ? 'semantic' : 'keyword-only',
          embeddedCount: stats.embeddedCount,
          chunkCount: stats.chunkCount,
        }
      : { mode: 'unknown', embeddedCount: null, chunkCount: null };

  return {
    inference,
    corpus,
    syncStates,
    itemCounts,
    memories,
    requirements,
    embeddingsAvailable,
    recall,
  };
}
