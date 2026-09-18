import { getHomeComposerRecommendations } from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import { logger } from '@/lib/server/logger';

function formatMetric(value: number | null): string {
  return value === null ? 'n/a' : String(Math.round(value * 10) / 10);
}

/** Build home placeholders from recent task memories, failing soft to none. */
export async function getHomeComposerSuggestionsCommand(
  auth: UserAuthSuccess,
): Promise<{ suggestions: string[] }> {
  const requestStartedAt = performance.now();
  let timing:
    | Awaited<ReturnType<typeof getHomeComposerRecommendations>>['timing']
    | null = null;
  let eligibleReferenceCount: number | null = null;
  let readableMemoryCount: number | null = null;
  let suggestionCount = 0;
  let failureReason: string | null = null;
  let outcome = 'error';

  try {
    const result = await getHomeComposerRecommendations(auth.userId);
    timing = result.timing;
    eligibleReferenceCount = result.eligibleReferenceCount;
    readableMemoryCount = result.readableMemoryCount;
    suggestionCount = result.suggestions.length;
    failureReason = result.failureReason;
    outcome = result.outcome;
    return { suggestions: result.suggestions };
  } catch (error) {
    console.error('Error loading home composer suggestion context:', error);
    return { suggestions: [] };
  } finally {
    try {
      logger.info(
        `[home-suggestion-timing] outcome=${outcome} total_ms=${formatMetric(
          performance.now() - requestStartedAt,
        )} eligible_reference_lookup_ms=${formatMetric(
          timing?.eligibleReferenceLookupMs ?? null,
        )} context_cache_status=${timing?.cacheStatus ?? 'not_checked'} context_cache_ms=${formatMetric(
          timing?.cacheMs ?? null,
        )} cached_source_validation_ms=${formatMetric(
          timing?.cachedSourceValidationMs ?? null,
        )} brain_reads_ms=${formatMetric(
          timing?.brainReadsMs ?? null,
        )} helper_generation_ms=${formatMetric(
          timing?.helperGenerationMs ?? null,
        )} post_generation_validation_ms=${formatMetric(
          timing?.postGenerationValidationMs ?? null,
        )} failure_reason=${failureReason ?? 'n/a'} eligible_reference_count=${formatMetric(
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
