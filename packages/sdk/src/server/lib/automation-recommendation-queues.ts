import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { z } from 'zod';

import { getRedis } from '@roomote/redis';
import type { SourceControlProvider } from '@roomote/types';

import { AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION } from './automation-recommendations-policy';

export const AUTOMATION_RECOMMENDATIONS_QUEUE_NAME =
  'automation-recommendations';
export const AUTOMATION_SIGNAL_PREFETCH_QUEUE_NAME =
  'automation-signal-prefetch';
export const AUTOMATION_RECOMMENDATION_INITIAL_RUN_QUEUE_NAME =
  'automation-recommendation-initial-runs';
export const AUTOMATION_SIGNALS_VERSION = 2;
export const AUTOMATION_RECOMMENDATION_REPOSITORY_CAP = 10;
const AUTOMATION_SIGNAL_PREFETCH_CAP = AUTOMATION_RECOMMENDATION_REPOSITORY_CAP;

export const automationRecommendationJobSchema = z.object({
  fingerprint: z.string().min(1),
  repositoryIds: z.array(z.string().uuid()),
});
export type AutomationRecommendationJob = z.infer<
  typeof automationRecommendationJobSchema
>;

export const automationSignalPrefetchJobSchema = z.object({
  repositoryId: z.string().uuid(),
  signalsVersion: z.number().int().positive(),
});
export type AutomationSignalPrefetchJob = z.infer<
  typeof automationSignalPrefetchJobSchema
>;

export const automationRecommendationInitialRunJobSchema = z.object({
  fingerprint: z.string().min(1),
  recommendationId: z.string().min(1),
});
export type AutomationRecommendationInitialRunJob = z.infer<
  typeof automationRecommendationInitialRunJobSchema
>;

let recommendationQueue: Queue<AutomationRecommendationJob> | null = null;
let signalPrefetchQueue: Queue<AutomationSignalPrefetchJob> | null = null;
let recommendationInitialRunQueue: Queue<AutomationRecommendationInitialRunJob> | null =
  null;

function getRecommendationQueue() {
  recommendationQueue ??= new Queue<AutomationRecommendationJob>(
    AUTOMATION_RECOMMENDATIONS_QUEUE_NAME,
    {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 3_600, count: 100 },
        removeOnFail: { age: 24 * 3_600 },
      },
    },
  );
  return recommendationQueue;
}

function getSignalPrefetchQueue() {
  signalPrefetchQueue ??= new Queue<AutomationSignalPrefetchJob>(
    AUTOMATION_SIGNAL_PREFETCH_QUEUE_NAME,
    {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 24 * 3_600, count: 500 },
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    },
  );
  return signalPrefetchQueue;
}

function getRecommendationInitialRunQueue() {
  recommendationInitialRunQueue ??=
    new Queue<AutomationRecommendationInitialRunJob>(
      AUTOMATION_RECOMMENDATION_INITIAL_RUN_QUEUE_NAME,
      {
        connection: getRedis(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 24 * 3_600, count: 500 },
          removeOnFail: { age: 7 * 24 * 3_600 },
        },
      },
    );
  return recommendationInitialRunQueue;
}

export function buildAutomationRecommendationFingerprint(
  repositoryIds: readonly string[],
  provider: SourceControlProvider | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        repositoryIds: [...repositoryIds].sort(),
        provider,
        catalogVersion: AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION,
      }),
    )
    .digest('hex');
}

export async function enqueueAutomationRecommendations(
  input: AutomationRecommendationJob,
): Promise<void> {
  const request = automationRecommendationJobSchema.parse(input);
  const queue = getRecommendationQueue();
  const jobId = `automation-recommendations-${request.fingerprint}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') {
      await existing.remove();
    }
  }
  console.info(
    `[automation-recommendations] Enqueuing recommendation scoring for ${request.repositoryIds.length} repositories`,
  );
  await queue.add('score-automation-recommendations', request, { jobId });
}

export async function enqueueAutomationSignalPrefetch(
  repositoryIds: readonly string[],
): Promise<void> {
  const queue = getSignalPrefetchQueue();
  const collectionDay = new Date().toISOString().slice(0, 10);
  const cappedIds = [...new Set(repositoryIds)].slice(
    0,
    AUTOMATION_SIGNAL_PREFETCH_CAP,
  );
  await Promise.all(
    cappedIds.map((repositoryId) =>
      queue.add(
        'collect-automation-signals',
        { repositoryId, signalsVersion: AUTOMATION_SIGNALS_VERSION },
        {
          jobId: `automation-signals-${repositoryId}-${AUTOMATION_SIGNALS_VERSION}-${collectionDay}`,
        },
      ),
    ),
  );
}

export async function enqueueAutomationRecommendationInitialRun(
  input: AutomationRecommendationInitialRunJob,
  delay: number,
): Promise<void> {
  const request = automationRecommendationInitialRunJobSchema.parse(input);
  const queue = getRecommendationInitialRunQueue();
  const jobId = `automation-recommendation-initial-run-${request.fingerprint}-${request.recommendationId}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') {
      await existing.remove();
    } else {
      return;
    }
  }
  await queue.add('run-automation-recommendation', request, { jobId, delay });
}
