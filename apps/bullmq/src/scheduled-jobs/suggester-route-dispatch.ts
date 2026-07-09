import {
  buildSuggestedTasksPrompt,
  enqueueCloudTask,
} from '@roomote/cloud-agents/server';
import {
  completeBackgroundAutomationRun,
  completeBackgroundAutomationRunByJobId,
  db,
  startBackgroundAutomationRun,
} from '@roomote/db/server';
import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';
import type { TaskSuggestionStatus } from '@roomote/types';

import {
  formatSlackChannelName,
  type SuggesterDeploymentContext,
  type SuggestionDispatchPlan,
  type SuggestionDispatchRoute,
} from './suggester-route-planner';

const LOG_PREFIX = '[suggester]';

type EnvironmentBackedRepositoryCoverage = Array<{
  repositoryFullName: string;
  targetEnvironmentId: string;
}>;

function getSuggestionRouteKind(route: SuggestionDispatchRoute) {
  if (route.isLegacyRoute) {
    return 'legacy';
  }

  if (route.isFallbackRoute) {
    return 'fallback';
  }

  return 'grouped';
}

async function enqueueSuggestionRoute(params: {
  deployment: SuggesterDeploymentContext;
  previousSuggestions: Array<{
    title: string;
    brief: string;
    status: TaskSuggestionStatus;
  }>;
  repositoryCoverage: EnvironmentBackedRepositoryCoverage;
  repositoryFullNames: string[];
  route: SuggestionDispatchRoute;
  triggerKind: 'manual' | 'scheduled';
}): Promise<{ error?: string; success: boolean }> {
  let runId: string | null = null;

  try {
    runId = (
      await startBackgroundAutomationRun(db, {
        automationKey: 'suggester',
        bullmqJobId: params.route.bullmqJobId,
        triggerKind: params.triggerKind,
        startedAt: new Date(),
        metadata: {
          routeChannelId: params.route.channelId,
          routeChannelName: params.route.channelName,
          routeGroupLabel: params.route.groupLabel,
          routeKind: getSuggestionRouteKind(params.route),
        },
      })
    ).id;

    // Suggestion scans run as the deployment service principal.
    const launchResult = await enqueueCloudTask({
      task: {
        type: TaskPayloadKind.Scan,
        payload: {
          repo: ALL_REPOSITORIES,
          selectedRepositories: params.repositoryFullNames,
          teamId: params.deployment.slackTeamId,
          description: buildSuggestedTasksPrompt({
            repositoryFullNames: params.repositoryFullNames,
            repositoryCoverage: params.repositoryCoverage,
            routeContext: params.route.routeInstructions
              ? {
                  destinationChannelName: params.route.channelName,
                  excludedGroupLabels: params.route.excludedGroupLabels,
                  groupLabel:
                    params.route.groupLabel ??
                    formatSlackChannelName(null, params.route.channelId),
                  isFallbackRoute: params.route.isFallbackRoute,
                  routeInstructions: params.route.routeInstructions,
                }
              : null,
            setupGuidance: null,
            suggesterInstructions: params.route.suggesterInstructions,
            previousSuggestions: params.previousSuggestions,
            recentThreadFeedback: params.route.recentThreadFeedback,
          }),
          trigger: 'scheduled',
          notifySlack: true,
          slackChannel: params.route.channelId,
          suggestionSource: 'suggest_ideas',
          visibleInTranscript: false,
        },
      },
      initiator: { kind: 'automation', key: 'suggester' },
      workflow: 'scan',
      surface: 'system',
      trigger: params.triggerKind === 'manual' ? 'manual' : 'schedule',
      visibility: 'hidden',
      channels: { slackChannelId: params.route.channelId },
    });

    await completeBackgroundAutomationRun(db, {
      runId,
      automationKey: 'suggester',
      status: 'succeeded',
      finishedAt: new Date(),
      taskId: launchResult.taskId,
      slackChannelId: params.route.channelId,
      metadata: {
        cloudJobId: launchResult.id,
        routeChannelName: params.route.channelName,
        routeGroupLabel: params.route.groupLabel,
        routeKind: getSuggestionRouteKind(params.route),
      },
    });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (runId) {
      await completeBackgroundAutomationRun(db, {
        runId,
        automationKey: 'suggester',
        status: 'failed',
        finishedAt: new Date(),
        error: message,
        slackChannelId: params.route.channelId,
      });
    } else {
      await completeBackgroundAutomationRunByJobId(db, {
        automationKey: 'suggester',
        bullmqJobId: params.route.bullmqJobId,
        status: 'failed',
        finishedAt: new Date(),
        error: message,
      });
    }

    return {
      success: false,
      error: message,
    };
  }
}

export async function dispatchSuggestionRoutes(params: {
  deployment: SuggesterDeploymentContext;
  previousSuggestions: Array<{
    title: string;
    brief: string;
    status: TaskSuggestionStatus;
  }>;
  repositoryCoverage: EnvironmentBackedRepositoryCoverage;
  repositoryFullNames: string[];
  routePlan: SuggestionDispatchPlan;
  triggerKind: 'manual' | 'scheduled';
}): Promise<{ errors: string[]; successfulRoutes: number }> {
  let successfulRoutes = 0;
  const errors: string[] = [];

  for (const route of params.routePlan.routes) {
    const result = await enqueueSuggestionRoute({
      deployment: params.deployment,
      previousSuggestions: params.previousSuggestions,
      repositoryCoverage: params.repositoryCoverage,
      repositoryFullNames: params.repositoryFullNames,
      route: {
        ...route,
        recentThreadFeedback:
          route.recentThreadFeedback ??
          (await params.routePlan.loadRecentThreadFeedbackForChannel(
            route.channelId,
          )),
      },
      triggerKind: params.triggerKind,
    });

    if (result.success) {
      successfulRoutes++;
      continue;
    }

    if (!result.error) {
      continue;
    }

    const routeLabel = route.groupLabel ?? route.channelId;
    errors.push(`${routeLabel}: ${result.error}`);
    console.error(`${LOG_PREFIX} Failed route ${routeLabel}: ${result.error}`);
  }

  return { errors, successfulRoutes };
}
