import { getTaskSummary } from './tasks-api-client.js';
import { getHarnessLabel, getTaskStatusLabel } from './task-display.js';
import { textResult, catchError } from './tool-result.js';
import type {
  RoomoteConfig,
  TaskSummaryResponse,
  ToolResult,
} from './types.js';

/**
 * Lifecycle of the task's environment setup (repository setup commands and
 * Docker projects), which can keep running in the background after the agent
 * has started. Surfaced so a caller monitoring another task — e.g. the
 * environment-setup workflow watching its verification task — can tell
 * whether that task's environment actually finished setting up, instead of
 * inferring it from the task's prose.
 */
function getEnvironmentSetupLine(state: string | null): string | null {
  switch (state) {
    case 'running':
      return 'Environment Setup: still running in the background (workspace dependencies and services may not be ready yet)';
    case 'completed':
      return 'Environment Setup: completed';
    case 'completed_with_warnings':
      return 'Environment Setup: completed with warnings (one or more setup commands failed; details in the workspace `.roomote/setup-status.json` and `.roomote/setup-logs/`)';
    case 'failed':
      return 'Environment Setup: failed (workspace may be missing dependencies or services; details in the workspace `.roomote/setup-status.json` and `.roomote/setup-logs/`)';
    default:
      return null;
  }
}

function getGoalLines(
  goal: TaskSummaryResponse['goal'],
  hasUsedGoalMode: boolean | undefined,
): string[] {
  if (!goal) {
    return hasUsedGoalMode ? ['Goal Mode: used previously'] : [];
  }

  const status = (() => {
    switch (goal.status) {
      case 'active':
        return 'Active';
      case 'complete':
        return 'Completed';
      case 'blocked':
        return 'Blocked';
      case 'budget_limited':
        return 'Continuation limit reached';
      default:
        return 'Used';
    }
  })();

  return [
    `Goal Mode: ${status}`,
    goal.objective ? `Goal Objective: ${goal.objective}` : null,
    goal.blockedReason ? `Goal Blocker: ${goal.blockedReason}` : null,
  ].filter((line): line is string => line !== null);
}

export async function handleGetTaskSummary(
  params: { taskId: string },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await getTaskSummary(config, params.taskId);
    const harnessLabel = getHarnessLabel(result.harness);

    const lines = [
      `Task: ${result.title || '(untitled)'}`,
      `ID: ${result.id}`,
      `Status: ${getTaskStatusLabel(result)}`,
      result.mode ? `Mode: ${result.mode}` : null,
      ...getGoalLines(result.goal, result.hasUsedGoalMode),
      harnessLabel ? `Harness: ${harnessLabel}` : null,
      result.repositoryName ? `Repository: ${result.repositoryName}` : null,
      result.linkedEnvironmentName
        ? `Linked Environment: ${result.linkedEnvironmentName}`
        : null,
      result.linkedEnvironmentId
        ? `Linked Environment ID: ${result.linkedEnvironmentId}`
        : null,
      result.taskRunError ? `Error: ${result.taskRunError}` : null,
      getEnvironmentSetupLine(result.environmentSetupState ?? null),
    ].filter(Boolean);

    return textResult(lines.join('\n'));
  } catch (error) {
    return catchError(error);
  }
}
