import {
  db,
  finalizeWorkItemLaunched,
  releaseWorkItemClaim,
  getSessionForTask,
  eq,
  sessions,
} from '@roomote/db/server';
import { isDeploymentReadOnlyError } from '@roomote/types';

import { resolveFastAgentEntryMode } from '../fast-agent-entry.js';
import { cancelOrphanedWorkItemRunBestEffort } from './orphaned-work-item-run.js';

type SuggestedTaskLaunchMode = 'fast' | 'coding';

type SuggestedTaskLaunchAttempt =
  | {
      accepted: true;
      runId: number | null;
      taskId: string | null;
      abort?: () => Promise<void>;
    }
  | {
      accepted: false;
      reason?: string;
    };

type SuggestedTaskLaunchResult =
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
  fastEligible: boolean;
  userDefaultEnabled: boolean;
  fastAvailable: boolean;
  requiredMode?: SuggestedTaskLaunchMode;
}): SuggestedTaskLaunchMode {
  if (input.requiredMode) {
    return input.requiredMode;
  }
  if (!input.fastEligible) {
    return 'coding';
  }

  return resolveFastAgentEntryMode({
    userDefaultEnabled: input.userDefaultEnabled,
    fastAvailable: input.fastAvailable,
  })
    ? 'fast'
    : 'coding';
}

export async function launchClaimedSuggestedTask(input: {
  suggestion: { id: string; launchClaimedAt: Date };
  policy: {
    fastEligible: boolean;
    userDefaultEnabled: boolean;
    fastAvailable: boolean;
    requiredMode?: SuggestedTaskLaunchMode;
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

  const cancelAcceptedAttempt = async () => {
    if (attempt.runId !== null) {
      return cancelOrphanedWorkItemRunBestEffort(attempt.runId);
    }
    if (!attempt.abort) {
      return 'no run id to cancel';
    }
    try {
      await attempt.abort();
      return 'Fast turn aborted';
    } catch {
      return 'Fast turn abort failed';
    }
  };

  let finalized: boolean;
  try {
    finalized = await finalize(attempt.taskId);
  } catch (error) {
    const cancelNote = await cancelAcceptedAttempt();
    await release().catch(() => undefined);
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

  const cancelNote = await cancelAcceptedAttempt();
  return {
    status: 'finalize_lost',
    mode,
    runId: attempt.runId,
    taskId: attempt.taskId,
    cancelNote,
  };
}

/**
 * Fast reports can produce suggestions without a source task. Their tracked
 * cards retain the canonical Session; older task-backed cards resolve via the
 * task instead. Neither path derives ownership from message timestamps.
 */
export async function resolveSuggestionOriginSessionId(
  sourceTaskId: string | null | undefined,
  originSessionId?: unknown,
): Promise<string | null> {
  if (typeof originSessionId === 'string' && originSessionId.trim()) {
    const session = await db.query.sessions.findFirst({
      where: eq(sessions.id, originSessionId),
      columns: { id: true },
    });
    if (!session) {
      throw new Error('The suggestion origin Session is no longer available.');
    }
    return session.id;
  }
  if (!sourceTaskId) {
    return null;
  }
  try {
    const session = await getSessionForTask(db, sourceTaskId);
    return session?.id ?? null;
  } catch (error) {
    console.warn(
      `[suggestion-launch] Could not resolve the origin Session for task ${sourceTaskId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
