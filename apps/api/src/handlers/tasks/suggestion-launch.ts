import {
  db,
  finalizeWorkItemLaunched,
  releaseWorkItemClaim,
} from '@roomote/db/server';
import { isDeploymentReadOnlyError } from '@roomote/types';

import { resolveFastAgentEntryMode } from '../fast-agent-entry.js';
import { cancelOrphanedWorkItemRunBestEffort } from './orphaned-work-item-run.js';

export type SuggestedTaskLaunchMode = 'fast' | 'coding';

export type SuggestedTaskLaunchAttempt =
  | {
      accepted: true;
      runId: number | null;
      taskId: string | null;
    }
  | {
      accepted: false;
      reason?: string;
    };

export type SuggestedTaskLaunchResult =
  | {
      status: 'started';
      mode: SuggestedTaskLaunchMode;
      runId: number | null;
      taskId: string | null;
    }
  | {
      status: 'rejected';
      mode: SuggestedTaskLaunchMode;
      reason?: string;
    }
  | {
      status: 'finalize_lost';
      mode: SuggestedTaskLaunchMode;
      runId: number | null;
      taskId: string | null;
      cancelNote: string;
    }
  | {
      status: 'finalize_failed';
      mode: SuggestedTaskLaunchMode;
      runId: number | null;
      taskId: string | null;
      error: unknown;
      cancelNote: string;
    }
  | {
      status: 'failed';
      mode: SuggestedTaskLaunchMode;
      error: unknown;
      readOnly: boolean;
    };

export function resolveSuggestedTaskLaunchMode(input: {
  usesRouterLaunch: boolean;
  userDefaultEnabled: boolean;
  fastAvailable: boolean;
}): SuggestedTaskLaunchMode {
  if (!input.usesRouterLaunch) {
    return 'coding';
  }

  return resolveFastAgentEntryMode({
    explicitInvocation: false,
    userDefaultEnabled: input.userDefaultEnabled,
    fastAvailable: input.fastAvailable,
  })
    ? 'fast'
    : 'coding';
}

export async function launchClaimedSuggestedTask(input: {
  suggestion: { id: string; launchClaimedAt: Date };
  policy: {
    usesRouterLaunch: boolean;
    userDefaultEnabled: boolean;
    fastAvailable: boolean;
  };
  launch: (
    mode: SuggestedTaskLaunchMode,
  ) => Promise<SuggestedTaskLaunchAttempt>;
  finalize?: (taskId: string | null) => Promise<boolean>;
  release?: () => Promise<unknown>;
}): Promise<SuggestedTaskLaunchResult> {
  const mode = resolveSuggestedTaskLaunchMode(input.policy);
  const finalize =
    input.finalize ??
    ((taskId: string | null) =>
      finalizeWorkItemLaunched(db, {
        id: input.suggestion.id,
        taskId,
        claimedAt: input.suggestion.launchClaimedAt,
      }));
  const release =
    input.release ??
    (() =>
      releaseWorkItemClaim(db, {
        id: input.suggestion.id,
        claimedAt: input.suggestion.launchClaimedAt,
      }));

  let attempt: SuggestedTaskLaunchAttempt;
  try {
    attempt = await input.launch(mode);
  } catch (error) {
    await release().catch(() => undefined);
    return {
      status: 'failed',
      mode,
      error,
      readOnly: isDeploymentReadOnlyError(error),
    };
  }

  if (!attempt.accepted) {
    await release();
    return {
      status: 'rejected',
      mode,
      ...(attempt.reason ? { reason: attempt.reason } : {}),
    };
  }

  let finalized: boolean;
  try {
    finalized = await finalize(attempt.taskId);
  } catch (error) {
    const cancelNote =
      attempt.runId === null
        ? 'no run id to cancel'
        : await cancelOrphanedWorkItemRunBestEffort(attempt.runId);
    return {
      status: 'finalize_failed',
      mode,
      runId: attempt.runId,
      taskId: attempt.taskId,
      error,
      cancelNote,
    };
  }
  if (finalized) {
    return {
      status: 'started',
      mode,
      runId: attempt.runId,
      taskId: attempt.taskId,
    };
  }

  const cancelNote =
    attempt.runId === null
      ? 'no run id to cancel'
      : await cancelOrphanedWorkItemRunBestEffort(attempt.runId);
  return {
    status: 'finalize_lost',
    mode,
    runId: attempt.runId,
    taskId: attempt.taskId,
    cancelNote,
  };
}
