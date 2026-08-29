import { captureEvent } from '@roomote/telemetry/server';

import type { UserAuthSuccess } from '@/types';
import {
  getSetupStarterTask,
  type SetupStarterTaskId,
} from '@/lib/setup-starter-tasks';
import { startFastSessionCommand } from '../fast-sessions';
import { completeSetupCommand } from './index';
import { assertAdmin } from './shared';

type CompleteSetupWithStarterTasksResult = {
  launched: Array<{ starterTaskId: SetupStarterTaskId; sessionId: string }>;
  failed: Array<{ starterTaskId: SetupStarterTaskId; error: string }>;
  setupCompleted: boolean;
  completionError: string | null;
};

/**
 * Launches the selected setup starter tasks as ordinary web Sessions and
 * completes setup once every requested launch succeeded.
 *
 * An empty selection simply completes setup, and setup stays incomplete while
 * any requested launch is still failing.
 */
export async function completeSetupWithStarterTasksCommand(
  auth: UserAuthSuccess,
  input: {
    launchBatchId: string;
    selectedStarterTaskIds: SetupStarterTaskId[];
    anonymousAnalyticsEnabled?: boolean;
    productUpdatesEnabled?: boolean;
  },
): Promise<CompleteSetupWithStarterTasksResult> {
  assertAdmin(auth);

  type StarterTaskLaunchOutcome =
    | { starterTaskId: SetupStarterTaskId; sessionId: string }
    | { starterTaskId: SetupStarterTaskId; error: string };

  const selectedStarterTaskIds = [...new Set(input.selectedStarterTaskIds)];

  const outcomes = await Promise.all(
    selectedStarterTaskIds.map(
      async (starterTaskId): Promise<StarterTaskLaunchOutcome> => {
        const starterTask = getSetupStarterTask(starterTaskId);

        try {
          const result = await startFastSessionCommand(auth, {
            text: starterTask.prompt,
            conversationId: [
              'setup-starter',
              input.launchBatchId,
              starterTaskId,
            ].join(':'),
          });
          return { starterTaskId, sessionId: result.sessionId };
        } catch (error) {
          return {
            starterTaskId,
            error:
              error instanceof Error
                ? error.message
                : 'The task could not be started.',
          };
        }
      },
    ),
  );

  const launched: CompleteSetupWithStarterTasksResult['launched'] = [];
  const failed: CompleteSetupWithStarterTasksResult['failed'] = [];

  for (const outcome of outcomes) {
    if ('sessionId' in outcome) {
      launched.push(outcome);
    } else {
      failed.push(outcome);
    }
  }

  let setupCompleted = false;
  let completionError: string | null = null;

  if (failed.length === 0) {
    try {
      await completeSetupCommand(auth, {
        ...(input.anonymousAnalyticsEnabled === undefined
          ? {}
          : { anonymousAnalyticsEnabled: input.anonymousAnalyticsEnabled }),
        ...(input.productUpdatesEnabled === undefined
          ? {}
          : { productUpdatesEnabled: input.productUpdatesEnabled }),
      });
      setupCompleted = true;
    } catch (error) {
      completionError =
        error instanceof Error
          ? error.message
          : 'Setup could not be completed.';
    }
  }

  // Anonymous analytics: fixed catalog ids and counts only, never prompt text.
  void captureEvent('setup_starter_tasks_submitted', {
    userId: auth.userId,
    properties: {
      selectedCount: selectedStarterTaskIds.length,
      launchedCount: launched.length,
      failedCount: failed.length,
      starterTaskIds: selectedStarterTaskIds.join(','),
    },
  });

  return { launched, failed, setupCompleted, completionError };
}
