import {
  RunStatus,
  TaskPayloadKind,
  isBootingRunStatus,
  isExitedRunStatus,
} from '@roomote/types';

import type { TaskRunDetail } from '@/lib/server';
import { getTaskRunError } from '@/lib/task-run-errors';

type SessionState =
  | 'interactive'
  | 'booting'
  | 'resuming'
  | 'boot-failed'
  | 'historical';

/**
 * Maximum time (ms) to wait for the first harness message before falling
 * through to 'interactive'. This prevents prompt-less sessions (e.g. plain
 * web snapshot resumes) from being stuck in booting/resuming indefinitely.
 */
const HARNESS_MESSAGE_TIMEOUT_MS = 7_000;

export function getSessionState(
  taskRun: TaskRunDetail,
  {
    hasMessages,
    hasHarnessMessages,
    now = Date.now(),
  }: { hasMessages: boolean; hasHarnessMessages: boolean; now?: number },
): SessionState {
  const taskRunStatus = taskRun.status;
  const taskRunError = getTaskRunError(taskRun);

  // If the job exited before the task ever produced output, keep showing the
  // startup screen so the user can see boot logs and the error. We check
  // `hasMessages` instead of `sandboxServerUrl` because the URL can exist
  // before setup finishes.
  if (
    !hasMessages &&
    (taskRunStatus === RunStatus.Failed ||
      (taskRunStatus === RunStatus.Canceled && !!taskRunError))
  ) {
    return 'boot-failed';
  }

  if (isExitedRunStatus(taskRunStatus)) {
    return 'historical';
  }

  if (isBootingRunStatus(taskRunStatus)) {
    // Runtime dispatch: payloadKind is the run-level resume signal.
    if (taskRun.payloadKind === TaskPayloadKind.SnapshotResume) {
      return 'resuming';
    }
    return 'booting';
  }

  // Keep the startup/resume surface visible until the harness has produced at
  // least one non-user message. This avoids switching to the live chat view
  // while the agent is still warming up after the sandbox is ready.
  //
  // However, prompt-less sessions (e.g. plain web snapshot resumes) may
  // legitimately stay running with zero harness messages until the user sends
  // the next prompt. To avoid blocking those sessions indefinitely, fall
  // through to 'interactive' once the job has been running for longer than
  // HARNESS_MESSAGE_TIMEOUT_MS.
  if (!hasHarnessMessages) {
    const timedOut =
      taskRun.startedAt != null &&
      now - taskRun.startedAt.getTime() >= HARNESS_MESSAGE_TIMEOUT_MS;

    if (!timedOut) {
      if (taskRun.payloadKind === TaskPayloadKind.SnapshotResume) {
        return 'resuming';
      }

      return 'booting';
    }
  }

  return 'interactive';
}

export function isWaitingForFirstHarnessMessage({
  sessionState,
  hasHarnessMessages,
}: {
  sessionState: SessionState;
  hasHarnessMessages: boolean;
}): boolean {
  return (
    !hasHarnessMessages &&
    (sessionState === 'booting' || sessionState === 'resuming')
  );
}

export function shouldPollForFirstHarnessMessage({
  sessionState,
  taskRunStatus,
  hasHarnessMessages,
  hasInitialPrompt,
}: {
  sessionState: SessionState;
  taskRunStatus: RunStatus;
  hasHarnessMessages: boolean;
  hasInitialPrompt: boolean;
}): boolean {
  if (hasHarnessMessages || isExitedRunStatus(taskRunStatus)) {
    return false;
  }

  if (isWaitingForFirstHarnessMessage({ sessionState, hasHarnessMessages })) {
    return true;
  }

  return hasInitialPrompt && sessionState === 'interactive';
}

export function shouldExposeOnboardingEnvironment({
  taskWorkflow,
  taskRunStatus,
  taskRunPhase,
}: {
  taskWorkflow: string | null | undefined;
  taskRunStatus: RunStatus;
  taskRunPhase: string | null;
}): boolean {
  return (
    taskWorkflow === 'setup_onboarding' &&
    (taskRunStatus === RunStatus.Completed ||
      (taskRunStatus === RunStatus.Idle &&
        taskRunPhase === 'waiting_for_prompt'))
  );
}
