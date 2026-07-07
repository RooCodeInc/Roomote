import { getSlackThreadTsFromTaskPayload } from '@roomote/types';

import {
  AutomationWorkItemValidationError,
  resolvePreparedAutomationWorkItems,
} from './prepare.js';
import { persistAutomationWorkItems } from './persistence.js';
import { resolveRepositoryIdsForSuggestedTask } from './repositories.js';
import type { AutomationWorkItemInput } from './schema.js';
import { launchActWorkItems, type AutomationChatTarget } from './launch.js';
import { resolveAutomationTelegramTarget } from './telegram.js';
import { resolveAutomationTeamsTarget } from './teams.js';
import { resolveAutomationSlackTarget } from './slack.js';
import type { AutomationKey } from './source.js';
import type {
  PersistedAutomationWorkItem,
  SuggestedTasksPayload,
} from './types.js';
import { resolveScheduledSuggestionSlackConfig } from '../background-automation-slack.js';

type AutomationWorkItemsSubmissionResult = {
  success: true;
  workItemCount: number;
  actedCount: number;
  launchedCount: number;
  failedCount: number;
  duplicateCount: number;
};

type AutoActAutomationConfig = {
  label: string;
  maxActItems: number;
  executionTaskBootstrap: '$implement-changes' | '$update-dependencies';
  enforceUniqueTargetEnvironments: boolean;
};

const AUTO_ACT_AUTOMATION_CONFIG: Record<
  AutomationKey,
  AutoActAutomationConfig
> = {
  sentry_triage: {
    label: 'Sentry triage',
    maxActItems: 1,
    executionTaskBootstrap: '$implement-changes',
    enforceUniqueTargetEnvironments: false,
  },
  dependabot_triage: {
    label: 'Dependabot triage',
    maxActItems: 3,
    executionTaskBootstrap: '$update-dependencies',
    enforceUniqueTargetEnvironments: true,
  },
  security_auditor: {
    label: 'Security Auditor',
    maxActItems: 5,
    executionTaskBootstrap: '$implement-changes',
    enforceUniqueTargetEnvironments: false,
  },
  code_quality_auditor: {
    label: 'Code Quality Auditor',
    maxActItems: 5,
    executionTaskBootstrap: '$implement-changes',
    enforceUniqueTargetEnvironments: false,
  },
  ci_failure_triage: {
    label: 'CI Failure Triage',
    maxActItems: 3,
    executionTaskBootstrap: '$implement-changes',
    enforceUniqueTargetEnvironments: true,
  },
};

function validateAutoActWorkItems(
  config: AutoActAutomationConfig,
  workItems: AutomationWorkItemInput[],
): void {
  if (workItems.some((workItem) => workItem.disposition === 'suggest')) {
    throw new AutomationWorkItemValidationError(
      `${config.label} acts directly and may not submit suggestion work items.`,
    );
  }

  const actWorkItems = workItems.filter(
    (workItem) => workItem.disposition === 'act',
  );

  if (actWorkItems.length > config.maxActItems) {
    throw new AutomationWorkItemValidationError(
      `${config.label} may submit at most ${config.maxActItems} act work item${
        config.maxActItems === 1 ? '' : 's'
      } per run.`,
    );
  }

  if (!config.enforceUniqueTargetEnvironments) {
    return;
  }

  const seenTargetEnvironmentIds = new Set<string>();

  for (const workItem of actWorkItems) {
    if (!workItem.targetEnvironmentId) {
      continue;
    }

    if (seenTargetEnvironmentIds.has(workItem.targetEnvironmentId)) {
      throw new AutomationWorkItemValidationError(
        `${config.label} may submit at most one work item per targetEnvironmentId.`,
      );
    }

    seenTargetEnvironmentIds.add(workItem.targetEnvironmentId);
  }
}

function isLaunchableActWorkItem(
  workItem: PersistedAutomationWorkItem,
): boolean {
  return (
    workItem.disposition === 'act' &&
    workItem.executionTaskId === null &&
    (workItem.status === 'open' || workItem.status === 'acting')
  );
}

/**
 * Automation scans hand off work as `act` items only: each item launches a
 * silent execution task that posts a single Slack closeout when it has a
 * terminal result. There is no root thread, no per-item Slack messages, and
 * no reaction-based approval flow.
 */
export async function submitAutoActWorkItems(params: {
  userId: string | null;
  taskId: string;
  automationRunId: string | null;
  automationKey: AutomationKey;
  payload: SuggestedTasksPayload;
  workItems: AutomationWorkItemInput[];
}): Promise<AutomationWorkItemsSubmissionResult> {
  const config = AUTO_ACT_AUTOMATION_CONFIG[params.automationKey];

  validateAutoActWorkItems(config, params.workItems);

  const candidateRepositories = await resolveRepositoryIdsForSuggestedTask({
    payload: params.payload,
  });

  if (candidateRepositories.length === 0) {
    throw new AutomationWorkItemValidationError(
      'This automation run did not resolve to any repositories in the deployment.',
    );
  }

  const preparedWorkItems = await resolvePreparedAutomationWorkItems({
    workItems: params.workItems,
    candidateRepositories,
  });
  const persisted = await persistAutomationWorkItems({
    sourceTaskId: params.taskId,
    automationKey: params.automationKey,
    backgroundAutomationRunId: params.automationRunId,
    preparedWorkItems,
    repositoryIds: candidateRepositories.map((repository) => repository.id),
  });
  const actItems = persisted.workItems.filter(
    (workItem) => workItem.disposition === 'act',
  );
  const launchableActItems = actItems.filter(isLaunchableActWorkItem);
  const resolvedSlackTarget =
    launchableActItems.length > 0
      ? await resolveAutomationSlackTarget({
          slackConfig: resolveScheduledSuggestionSlackConfig(
            params.automationKey,
          ),
        })
      : null;
  // When the scan task already owns a Slack thread (the CI failure webhook
  // posts an "investigating" announcement), execution tasks reply there
  // instead of late-binding a new root.
  const sourceThreadTs = getSlackThreadTsFromTaskPayload(params.payload);
  const chatTarget = resolvedSlackTarget
    ? ({
        provider: 'slack' as const,
        ...resolvedSlackTarget,
        threadTs: sourceThreadTs ?? null,
      } satisfies AutomationChatTarget)
    : launchableActItems.length > 0
      ? ((await resolveAutomationTelegramTarget()) ??
        (await resolveAutomationTeamsTarget()))
      : null;
  const launchResult = await launchActWorkItems({
    userId: params.userId,
    workItems: launchableActItems,
    executionTaskBootstrap: config.executionTaskBootstrap,
    chatTarget,
  });

  return {
    success: true,
    workItemCount: persisted.workItems.length,
    actedCount: actItems.length,
    launchedCount: launchResult.launchedCount,
    failedCount: launchResult.failedCount,
    duplicateCount: persisted.duplicateCount,
  };
}
