import { createHash } from 'node:crypto';

import { unstable_cache } from 'next/cache';
import {
  listRecentBrainTaskMemoryRefs,
  readBrainTaskMemories,
} from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import { logger } from '@/lib/server/logger';
import {
  HOME_SUGGESTIONS_CACHE_VERSION,
  suggestHomeComposerMessages,
} from '@/lib/server/composer-suggestion';
import { getPersonalPreferencesCommand } from '../preferences';

const RECENT_MEMORY_LIMIT = 5;
const CACHE_TTL_SECONDS = 24 * 60 * 60;

class HomeComposerSuggestionsUnavailableError extends Error {}

type CacheStatus = 'not_checked' | 'hit' | 'miss';

function formatMetric(value: number | null): string {
  return value === null ? 'n/a' : String(Math.round(value * 10) / 10);
}

/** Build home placeholders from recent task memories, failing soft to none. */
export async function getHomeComposerSuggestionsCommand(
  auth: UserAuthSuccess,
): Promise<{ suggestions: string[] }> {
  const requestStartedAt = performance.now();
  let preferenceGuardMs: number | null = null;
  let eligibleReferenceLookupMs: number | null = null;
  let contextCacheMs: number | null = null;
  let contextCacheStatus: CacheStatus = 'not_checked';
  let brainReadsMs: number | null = null;
  let generationCacheMs: number | null = null;
  let generationCacheStatus: CacheStatus = 'not_checked';
  let helperGenerationMs: number | null = null;
  let eligibleReferenceCount: number | null = null;
  let readableMemoryCount: number | null = null;
  let suggestionCount = 0;
  let outcome = 'error';

  try {
    const preferenceStartedAt = performance.now();
    const preferences = await getPersonalPreferencesCommand(auth).finally(
      () => {
        preferenceGuardMs = performance.now() - preferenceStartedAt;
      },
    );
    if (!preferences.homeComposerSuggestionsEnabled) {
      outcome = 'flag_disabled';
      return { suggestions: [] };
    }

    const referenceLookupStartedAt = performance.now();
    const memoryRefs = await listRecentBrainTaskMemoryRefs({
      userId: auth.userId,
      limit: RECENT_MEMORY_LIMIT,
    }).finally(() => {
      eligibleReferenceLookupMs = performance.now() - referenceLookupStartedAt;
    });
    eligibleReferenceCount = memoryRefs.length;

    if (memoryRefs.length === 0) {
      outcome = 'no_eligible_memories';
      return { suggestions: [] };
    }

    const revision = createHash('sha256')
      .update(
        memoryRefs
          .map(
            (memory) =>
              `${memory.taskId}:${memory.runId}:${memory.memoryRevision}`,
          )
          .join('|'),
      )
      .digest('hex');

    const loadSuggestions = unstable_cache(
      async () => {
        contextCacheStatus = 'miss';
        const brainReadsStartedAt = performance.now();
        const memories = await readBrainTaskMemories(memoryRefs).finally(() => {
          brainReadsMs = performance.now() - brainReadsStartedAt;
        });
        readableMemoryCount = memories.length;
        const result = await suggestHomeComposerMessages({
          memories: memories.map((memory) => memory.content),
          revision,
          userId: auth.userId,
          onTiming: (timing) => {
            generationCacheMs = timing.cacheMs;
            generationCacheStatus = timing.cacheStatus;
            helperGenerationMs = timing.helperMs;
          },
        });

        // Do not turn a transient Brain/helper failure into a 24-hour miss.
        if (result.suggestions.length === 0) {
          throw new HomeComposerSuggestionsUnavailableError();
        }

        return result;
      },
      [
        'home-composer-suggestion-context',
        HOME_SUGGESTIONS_CACHE_VERSION,
        auth.userId,
        revision,
      ],
      { revalidate: CACHE_TTL_SECONDS },
    );

    contextCacheStatus = 'hit';
    const contextCacheStartedAt = performance.now();
    const result = await loadSuggestions().finally(() => {
      contextCacheMs = performance.now() - contextCacheStartedAt;
    });
    suggestionCount = result.suggestions.length;
    outcome = 'success';
    return result;
  } catch (error) {
    if (error instanceof HomeComposerSuggestionsUnavailableError) {
      outcome = 'fallback';
    } else {
      console.error('Error loading home composer suggestion context:', error);
    }
    return { suggestions: [] };
  } finally {
    try {
      logger.info(
        `[home-suggestion-timing] outcome=${outcome} total_ms=${formatMetric(
          performance.now() - requestStartedAt,
        )} preference_guard_ms=${formatMetric(
          preferenceGuardMs,
        )} eligible_reference_lookup_ms=${formatMetric(
          eligibleReferenceLookupMs,
        )} context_cache_status=${contextCacheStatus} context_cache_ms=${formatMetric(
          contextCacheMs,
        )} brain_reads_ms=${formatMetric(
          brainReadsMs,
        )} generation_cache_status=${generationCacheStatus} generation_cache_ms=${formatMetric(
          generationCacheMs,
        )} helper_generation_ms=${formatMetric(
          helperGenerationMs,
        )} eligible_reference_count=${formatMetric(
          eligibleReferenceCount,
        )} readable_memory_count=${formatMetric(
          readableMemoryCount,
        )} suggestion_count=${suggestionCount}`,
      );
    } catch {
      // Timing instrumentation must never change the suggestion response.
    }
  }
}
