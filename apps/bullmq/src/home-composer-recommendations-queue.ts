import { Queue, QueueEvents, Worker } from 'bullmq';

import {
  HOME_COMPOSER_RECOMMENDATION_JOB_OPTIONS,
  HOME_COMPOSER_RECOMMENDATIONS_QUEUE_NAME,
  processHomeComposerRecommendationPrecompute,
  type HomeComposerRecommendationJob,
} from '@roomote/sdk/server';

import { getRedis } from './redis';

function formatMetric(value: number | null): string {
  return value === null ? 'n/a' : String(Math.round(value * 10) / 10);
}

export function startHomeComposerRecommendationsQueue() {
  const connection = getRedis();
  const queue = new Queue<HomeComposerRecommendationJob>(
    HOME_COMPOSER_RECOMMENDATIONS_QUEUE_NAME,
    { connection, defaultJobOptions: HOME_COMPOSER_RECOMMENDATION_JOB_OPTIONS },
  );
  const worker = new Worker<HomeComposerRecommendationJob>(
    HOME_COMPOSER_RECOMMENDATIONS_QUEUE_NAME,
    async (job) => {
      const result = await processHomeComposerRecommendationPrecompute(
        job.data,
      );
      const timing = result.timing;
      console.info(
        `[home-suggestion-precompute-timing] outcome=${result.outcome} total_ms=${formatMetric(timing.totalMs)} eligible_reference_lookup_ms=${formatMetric(timing.eligibleReferenceLookupMs)} context_cache_status=${timing.cacheStatus} context_cache_ms=${formatMetric(timing.cacheMs)} cached_source_validation_ms=${formatMetric(timing.cachedSourceValidationMs)} brain_reads_ms=${formatMetric(timing.brainReadsMs)} helper_generation_ms=${formatMetric(timing.helperGenerationMs)} post_generation_validation_ms=${formatMetric(timing.postGenerationValidationMs)} failure_reason=${result.failureReason ?? 'n/a'} eligible_reference_count=${formatMetric(result.eligibleReferenceCount)} readable_memory_count=${formatMetric(result.readableMemoryCount)} suggestion_count=${result.suggestions.length}`,
      );
      if (result.outcome === 'fallback') {
        throw new Error('Home composer recommendation precompute failed.');
      }
    },
    { connection, concurrency: 2, autorun: true },
  );
  const queueEvents = new QueueEvents(
    HOME_COMPOSER_RECOMMENDATIONS_QUEUE_NAME,
    { connection },
  );

  worker.on('failed', (_job, error) =>
    console.error(
      '[HomeComposerRecommendationsQueue] precompute job failed:',
      error,
    ),
  );

  return { queue, worker, queueEvents };
}
