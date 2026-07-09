import { CloudAgentType } from './cloud-agents';
import { CloudTaskType, type TaskSuggestionSource } from './cloud-jobs';
import {
  getScheduledSuggestionBackgroundAutomationDescriptor,
  getTriggerableBackgroundAutomationDescriptorByKey,
} from './background-automation-registry';
import type { BackgroundAutomationKey } from './background-agents';

const PR_REVIEWER_AUTOMATION_LABEL = CloudAgentType.PrReviewer;
const PR_CONFLICT_AUTOMATION_LABEL = 'Resolve PR Conflicts';

type TaskAutomationDisplayInput = {
  type: CloudTaskType;
  payload?: {
    suggestionSource?: TaskSuggestionSource;
    automationKey?: BackgroundAutomationKey | string;
    [key: string]: unknown;
  } | null;
};

/**
 * User-facing automation name for task attribution/analytics when a task was
 * kicked by a known automation rather than a linked product user.
 */
export function resolveTaskAutomationDisplayName(
  task: TaskAutomationDisplayInput,
): string | null {
  switch (task.type) {
    case CloudTaskType.GithubPrReview:
    case CloudTaskType.GithubPrReviewSync:
    case CloudTaskType.GithubPrReviewFollowUp:
      return PR_REVIEWER_AUTOMATION_LABEL;
    case CloudTaskType.GithubPrConflictResolve:
      return PR_CONFLICT_AUTOMATION_LABEL;
    default:
      break;
  }

  const payload = task.payload;
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const automationKey =
    typeof payload.automationKey === 'string'
      ? payload.automationKey.trim()
      : null;
  if (automationKey) {
    const byKey = getTriggerableBackgroundAutomationDescriptorByKey(
      automationKey as BackgroundAutomationKey,
    );
    if (byKey?.label) {
      return byKey.label;
    }
  }

  if (payload.suggestionSource) {
    const bySource = getScheduledSuggestionBackgroundAutomationDescriptor(
      payload.suggestionSource,
    );
    if (bySource?.label) {
      return bySource.label;
    }
  }

  return null;
}

export function isKnownAutomationTaskType(type: CloudTaskType): boolean {
  return (
    type === CloudTaskType.GithubPrReview ||
    type === CloudTaskType.GithubPrReviewSync ||
    type === CloudTaskType.GithubPrReviewFollowUp ||
    type === CloudTaskType.GithubPrConflictResolve ||
    type === CloudTaskType.SuggestedTasks ||
    type === CloudTaskType.McpRecommendations ||
    type === CloudTaskType.LegacyOnboardingSuggestions
  );
}
