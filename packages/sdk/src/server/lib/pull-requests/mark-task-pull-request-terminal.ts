import type { SourceControlProvider } from '@roomote/types';

import {
  formatPullRequestReference,
  recordPrStatusChangeInTaskHistory,
  type RecordPrStatusChangeInTaskHistoryInput,
} from '../task-runs/record-pr-status-change';
import { updateTaskPrStatus } from './update-task-pr-status';

export type MarkTaskPullRequestTerminalInput =
  RecordPrStatusChangeInTaskHistoryInput & {
    sourceControlProvider: SourceControlProvider;
  };

/**
 * Owns the co-required terminal PR side effects for merged/closed webhooks:
 * update matching `task_pull_requests` rows, then record status into linked
 * task history best-effort (history failures are logged, never thrown).
 *
 * Status-update failures still propagate so callers can choose await vs
 * fire-and-forget semantics intentionally.
 */
export async function markTaskPullRequestTerminal(
  input: MarkTaskPullRequestTerminalInput,
  options?: { logLabel?: string },
): Promise<void> {
  const logLabel = options?.logLabel ?? 'markTaskPullRequestTerminal';
  const {
    sourceControlProvider,
    repository,
    prNumber,
    status,
    prTitle,
    prUrl,
    actorLogin,
  } = input;

  await updateTaskPrStatus(sourceControlProvider, repository, prNumber, status);

  try {
    await recordPrStatusChangeInTaskHistory({
      sourceControlProvider,
      repository,
      prNumber,
      status,
      prTitle,
      prUrl,
      actorLogin,
    });
  } catch (error) {
    const reference = formatPullRequestReference({
      repository,
      prNumber,
      sourceControlProvider,
    });

    console.warn(
      `[${logLabel}] Failed to record PR status in task history for ${reference}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
