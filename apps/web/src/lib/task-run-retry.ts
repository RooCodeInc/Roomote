import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/db';

/**
 * Client-side eligibility for start retry. Keep in lockstep with
 * `isRelaunchableFailedStartPayloadKind` in packages/cloud-agents.
 *
 * Shared by the startup sequence and the historical failure message: a run
 * that failed to start can land in either view depending on whether any
 * assistant output arrived, and both must offer the same retry.
 */
export function canRelaunchFailedStart(
  taskRun: Pick<TaskRun, 'payloadKind' | 'status'>,
): boolean {
  if (taskRun.status !== RunStatus.Failed) {
    return false;
  }

  switch (taskRun.payloadKind) {
    case TaskPayloadKind.StandardTask:
    case TaskPayloadKind.Scan:
    case TaskPayloadKind.SlackAppMention:
    case TaskPayloadKind.LinearAgentSession:
    case TaskPayloadKind.GithubPrReviewFollowUp:
    case TaskPayloadKind.McpRecommendations:
      return true;
    default:
      return false;
  }
}
