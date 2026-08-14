import { Queue, QueueEvents, Worker } from 'bullmq';

import {
  AUTOMATION_RECOMMENDATIONS_QUEUE_NAME,
  AUTOMATION_SIGNAL_PREFETCH_QUEUE_NAME,
  collectAutomationSignalsJob,
  processAutomationRecommendationsJob,
  type AutomationRecommendationJob,
  type AutomationSignalPrefetchJob,
} from '@roomote/sdk/server';

import { getRedis } from './redis';

export function startAutomationRecommendationsQueue() {
  const connection = getRedis();
  const recommendationQueue = new Queue<AutomationRecommendationJob>(
    AUTOMATION_RECOMMENDATIONS_QUEUE_NAME,
    { connection },
  );
  const recommendationWorker = new Worker<AutomationRecommendationJob>(
    AUTOMATION_RECOMMENDATIONS_QUEUE_NAME,
    (job) => processAutomationRecommendationsJob(job.data),
    { connection, concurrency: 2, autorun: true },
  );
  const recommendationQueueEvents = new QueueEvents(
    AUTOMATION_RECOMMENDATIONS_QUEUE_NAME,
    { connection },
  );

  const signalPrefetchQueue = new Queue<AutomationSignalPrefetchJob>(
    AUTOMATION_SIGNAL_PREFETCH_QUEUE_NAME,
    { connection },
  );
  const signalPrefetchWorker = new Worker<AutomationSignalPrefetchJob>(
    AUTOMATION_SIGNAL_PREFETCH_QUEUE_NAME,
    (job) => collectAutomationSignalsJob(job.data),
    { connection, concurrency: 5, autorun: true },
  );
  const signalPrefetchQueueEvents = new QueueEvents(
    AUTOMATION_SIGNAL_PREFETCH_QUEUE_NAME,
    { connection },
  );

  recommendationWorker.on('failed', (job, error) =>
    console.error(
      `[AutomationRecommendationsQueue] recommendation job ${job?.id} failed:`,
      error,
    ),
  );
  signalPrefetchWorker.on('failed', (job, error) =>
    console.error(
      `[AutomationRecommendationsQueue] signal job ${job?.id} failed:`,
      error,
    ),
  );

  return {
    recommendationQueue,
    recommendationWorker,
    recommendationQueueEvents,
    signalPrefetchQueue,
    signalPrefetchWorker,
    signalPrefetchQueueEvents,
  };
}
