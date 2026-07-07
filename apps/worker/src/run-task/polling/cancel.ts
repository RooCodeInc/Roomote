import { sdk } from '@roomote/sdk/client';

import type { ListenerOptions } from '../types';
import { runPollingSdkCall } from './poll-error-context';

/** Interval (ms) between polling the database to check if a job has been canceled. */
const CANCEL_CHECK_INTERVAL_MS = 10_000;

export function createCancelInterval({
  cloudJob,
  state,
  logger,
  cancelTask,
}: ListenerOptions): NodeJS.Timeout {
  const interval = setInterval(async () => {
    if (!state.sessionId || state.cancelTriggeredAt) {
      return;
    }

    const latestJob = await runPollingSdkCall({
      execute: () => sdk.cloudJobs.findRuntimeStateById(cloudJob.id),
      stage: 'listenForCancel',
      cloudJobId: cloudJob.id,
      sessionId: state.sessionId,
      sdkMethod: 'cloudJobs.findRuntimeStateById',
      logger,
      level: 'warn',
      message: `[listenForCancel] unable to check cancellation status for job ${cloudJob.id}`,
    });

    if (!latestJob) {
      return;
    }

    if (latestJob?.canceledAt) {
      logger.info(
        `[listenForCancel] cancelling parent task: ${state.sessionId}`,
      );

      state.cancelTriggeredAt = Date.now();
      cancelTask();
      clearInterval(interval);
    }
  }, CANCEL_CHECK_INTERVAL_MS);

  return interval;
}
