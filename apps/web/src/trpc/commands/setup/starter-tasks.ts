import { captureEvent } from '@roomote/telemetry/server';
import { getUserDisplayName } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import {
  getSetupStarterTask,
  type SetupStarterTaskId,
} from '@/lib/setup-starter-tasks';
import { startSetupFastSessionCommand } from '../fast-sessions';
import { getSetupNewStatusCommand } from '../setup-new';
import { completeSetupCommand } from './index';
import { assertAdmin } from './shared';

type CompleteSetupWithStarterTasksResult = {
  /** Setup session to land in, or null when nothing was selected. */
  sessionId: string | null;
  setupCompleted: boolean;
  completionError: string | null;
};

/**
 * Completes setup, then drops the administrator into one "Set up Roomote"
 * Fast session whose kickoff turn launches the selected starter tasks and
 * opens the conversation around them.
 *
 * Setup completion is deterministic and happens before the session's first
 * turn runs, so a failed or slow model turn can never leave setup incomplete.
 * An empty selection simply completes setup with no session.
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
  const status = await getSetupNewStatusCommand(auth);
  if (
    !status.setupNewState.onboardingTaskId ||
    !status.setupNewState.onboardingTaskStartedAt
  ) {
    throw new Error(
      'This legacy setup completion path is available only for an already-started onboarding task.',
    );
  }

  const selectedStarterTaskIds = [...new Set(input.selectedStarterTaskIds)];

  try {
    await completeSetupCommand(auth, {
      ...(input.anonymousAnalyticsEnabled === undefined
        ? {}
        : { anonymousAnalyticsEnabled: input.anonymousAnalyticsEnabled }),
      ...(input.productUpdatesEnabled === undefined
        ? {}
        : { productUpdatesEnabled: input.productUpdatesEnabled }),
    });
  } catch (error) {
    return {
      sessionId: null,
      setupCompleted: false,
      completionError:
        error instanceof Error
          ? error.message
          : 'Setup could not be completed.',
    };
  }

  if (selectedStarterTaskIds.length === 0) {
    return { sessionId: null, setupCompleted: true, completionError: null };
  }

  const adminName = getUserDisplayName({
    name: auth.name,
    email: auth.primaryEmail,
  });

  const { sessionId, created } = await startSetupFastSessionCommand(auth, {
    conversationId: `setup-session:${input.launchBatchId}`,
    title: 'Set up Roomote',
    event: {
      type: 'setup_session_started',
      description:
        'The administrator finished initial setup and selected these starter tasks to launch.',
      ...(adminName ? { adminName } : {}),
      starterTasks: selectedStarterTaskIds.map((starterTaskId) => {
        const starterTask = getSetupStarterTask(starterTaskId);
        return {
          id: starterTask.id,
          title: starterTask.title,
          description: starterTask.description,
          prompt: starterTask.prompt,
        };
      }),
    },
  });

  // Anonymous analytics: fixed catalog ids and counts only, never prompt text.
  void captureEvent('setup_starter_tasks_submitted', {
    userId: auth.userId,
    properties: {
      selectedCount: selectedStarterTaskIds.length,
      starterTaskIds: selectedStarterTaskIds.join(','),
      setupSessionCreated: created,
    },
  });

  return { sessionId, setupCompleted: true, completionError: null };
}
