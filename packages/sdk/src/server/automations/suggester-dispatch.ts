import {
  buildSuggestedTasksPrompt,
  enqueueTask,
} from '@roomote/cloud-agents/server';
import { db, recordAutomationRunOutcome } from '@roomote/db/server';
import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';
import type { WorkItemStatus } from '@roomote/types';

import { loadAutomationThreadFeedbackReport } from './automation-thread-feedback';
import {
  partitionActiveRepositoriesByProvider,
  type ActiveRepositoryProviderPartition,
} from './github-deployment-scope';

export type SuggesterDeploymentContext = {
  slackBotToken: string | null;
  slackTeamId: string | null;
};

export type RepositoryCoverage = Array<{
  repositoryFullName: string;
  workspaceReadiness: 'environment_backed' | 'bare_repo';
  targetEnvironmentId?: string;
}>;

type EnvironmentBackedRepositoryCoverage = Array<{
  repositoryFullName: string;
  targetEnvironmentId: string;
}>;

export async function dispatchSuggestionScan(params: {
  channelId: string;
  deployment: SuggesterDeploymentContext;
  now: Date;
  previousSuggestions: Array<{
    title: string;
    brief: string;
    status: WorkItemStatus;
  }>;
  repositoryCoverage: EnvironmentBackedRepositoryCoverage;
  repositoryFullNames: string[];
  suggesterInstructions: string | null;
  triggerKind: 'manual' | 'scheduled';
  destinationPayloadFields?: Record<string, string>;
}): Promise<{
  errors: string[];
  firstLaunchedTaskId: string | null;
  successfulScans: number;
}> {
  try {
    const destinationFields = params.destinationPayloadFields ?? {};
    const isSlackDestination =
      !destinationFields.communicationProvider ||
      destinationFields.communicationProvider === 'slack';
    const partitions = await partitionActiveRepositoriesByProvider(
      params.repositoryFullNames,
    );

    if (partitions.length === 0) {
      throw new Error(
        'No active repositories matched the suggestion scan scope.',
      );
    }

    const recentThreadFeedback = await loadAutomationThreadFeedbackReport({
      automationKey: 'suggester',
      slackChannelId: params.channelId,
      now: params.now,
    });
    let firstLaunchedTaskId: string | null = null;

    const launchPartition = async (
      partition: ActiveRepositoryProviderPartition,
    ): Promise<string> => {
      const partitionNames = new Set(partition.repositoryFullNames);
      const launchResult = await enqueueTask({
        task: {
          type: TaskPayloadKind.Scan,
          payload: {
            repo: ALL_REPOSITORIES,
            selectedRepositories: partition.repositoryFullNames,
            sourceControlProvider: partition.provider,
            ...(partition.host ? { sourceControlHost: partition.host } : {}),
            ...(params.deployment.slackTeamId
              ? { teamId: params.deployment.slackTeamId }
              : {}),
            description: buildSuggestedTasksPrompt({
              repositoryFullNames: partition.repositoryFullNames,
              repositoryCoverage: params.repositoryCoverage.filter((coverage) =>
                partitionNames.has(coverage.repositoryFullName),
              ),
              setupGuidance: null,
              suggesterInstructions: params.suggesterInstructions,
              previousSuggestions: params.previousSuggestions,
              recentThreadFeedback: recentThreadFeedback.promptText,
            }),
            trigger: 'scheduled',
            notifySlack: true,
            suggestionSource: 'suggest_ideas',
            visibleInTranscript: false,
            ...(isSlackDestination ? { slackChannel: params.channelId } : {}),
            ...destinationFields,
          },
        },
        initiator: { kind: 'automation', key: 'suggester' },
        workflow: 'scan',
        surface: 'system',
        trigger: params.triggerKind === 'manual' ? 'manual' : 'schedule',
        visibility: 'hidden',
        ...(isSlackDestination
          ? { channels: { slackChannelId: params.channelId } }
          : {}),
      });

      return launchResult.taskId;
    };

    for (const partition of partitions) {
      const taskId = await launchPartition(partition);
      firstLaunchedTaskId ??= taskId;
    }

    await recordAutomationRunOutcome(db, {
      key: 'suggester',
      status: 'succeeded',
      at: new Date(),
    });

    return { errors: [], firstLaunchedTaskId, successfulScans: 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await recordAutomationRunOutcome(db, {
      key: 'suggester',
      status: 'failed',
      at: new Date(),
      error: message,
    });

    return {
      errors: [message],
      firstLaunchedTaskId: null,
      successfulScans: 0,
    };
  }
}
