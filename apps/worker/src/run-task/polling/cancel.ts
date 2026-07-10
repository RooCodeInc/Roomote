import { sdk } from '@roomote/sdk/client';

import type { ListenerOptions } from '../types';
import { runPollingSdkCall } from './poll-error-context';

/** Interval (ms) between polling the database to check if a job has been canceled. */
const CANCEL_CHECK_INTERVAL_MS = 10_000;

export function createCancelInterval({
  taskRun,
  state,
  logger,
  cancelTask,
}: ListenerOptions): NodeJS.Timeout {
  const interval = setInterval(async () => {
    if (!state.sessionId || state.cancelTriggeredAt) {
      return;
    }

    const latestRun = await runPollingSdkCall({
      execute: () => sdk.taskRuns.findRuntimeStateById(taskRun.id),
      stage: 'listenForCancel',
      runId: taskRun.id,
      sessionId: state.sessionId,
      sdkMethod: 'taskRuns.findRuntimeStateById',
      logger,
      level: 'warn',
      message: `[listenForCancel] unable to check cancellation status for job ${taskRun.id}`,
    });

    if (!latestRun) {
      return;
    }

    if (latestRun?.canceledAt) {
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
