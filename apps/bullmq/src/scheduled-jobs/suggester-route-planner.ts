import { planSuggestionRoutes } from '@roomote/cloud-agents/server';
import { SlackNotifier } from '@roomote/slack';

import { loadAutomationThreadFeedbackReport } from './automation-thread-feedback';
import type { SlackDeploymentContext } from './scheduling-utils';

const LOG_PREFIX = '[suggester]';
const DEFAULT_FALLBACK_ROUTE_INSTRUCTIONS =
  'Only surface ideas that do not clearly belong to any defined routed group. Use this fallback route for ambiguous or uncategorized ideas.';

export type SuggesterDeploymentContext = SlackDeploymentContext;

export type RepositoryCoverage = Array<{
  repositoryFullName: string;
  workspaceReadiness: 'environment_backed' | 'bare_repo';
  targetEnvironmentId?: string;
}>;

export type SuggestionDispatchRoute = {
  bullmqJobId: string;
  channelId: string;
  channelName: string;
  excludedGroupLabels: string[];
  groupLabel: string | null;
  isFallbackRoute: boolean;
  isLegacyRoute: boolean;
  recentThreadFeedback: string | null;
  routeInstructions: string | null;
  suggesterInstructions: string | null;
};

export type SuggestionDispatchPlan = {
  routes: SuggestionDispatchRoute[];
  loadRecentThreadFeedbackForChannel: (
    slackChannelId: string,
  ) => Promise<string | null>;
};

type SuggestionRoutingSettings = {
  suggesterInstructions: string | null;
  suggesterRoutingInstructions: string | null;
  suggesterRoutingMode: string | null;
};

export function formatSlackChannelName(
  channelName: string | null,
  channelId: string,
) {
  return channelName ? `#${channelName}` : channelId;
}

function buildLegacySuggestionDispatchRoute(params: {
  baseJobId: string;
  managerChannelId: string;
  settings: SuggestionRoutingSettings;
}): SuggestionDispatchRoute {
  return {
    bullmqJobId: params.baseJobId,
    channelId: params.managerChannelId,
    channelName: formatSlackChannelName(null, params.managerChannelId),
    excludedGroupLabels: [],
    groupLabel: null,
    isFallbackRoute: false,
    isLegacyRoute: true,
    recentThreadFeedback: null,
    routeInstructions: null,
    suggesterInstructions: params.settings.suggesterInstructions,
  };
}

async function buildGroupedSuggestionDispatchRoutes(params: {
  baseJobId: string;
  deployment: SuggesterDeploymentContext;
  managerChannelId: string;
  repositoryCoverage: RepositoryCoverage;
  routingInstructions: string;
}): Promise<SuggestionDispatchRoute[] | null> {
  try {
    const notifier = new SlackNotifier(params.deployment.slackBotToken);
    const [availableChannels, managerChannelName] = await Promise.all([
      notifier.listAccessibleChannels(),
      notifier.getChannelName(params.managerChannelId),
    ]);
    const plan = await planSuggestionRoutes({
      routingInstructions: params.routingInstructions,
      availableChannels,
      managerFallbackChannel: {
        id: params.managerChannelId,
        name: managerChannelName,
      },
      repositoryCoverage: params.repositoryCoverage,
    });

    if (plan.routes.length === 0) {
      return null;
    }

    const groupedLabels = plan.routes.map((route) => route.groupLabel);
    const routes: SuggestionDispatchRoute[] = plan.routes.map(
      (route, index) => ({
        bullmqJobId: `${params.baseJobId}:route:${index + 1}`,
        channelId: route.channelId,
        channelName: formatSlackChannelName(route.channelName, route.channelId),
        excludedGroupLabels: groupedLabels.filter(
          (groupLabel) => groupLabel !== route.groupLabel,
        ),
        groupLabel: route.groupLabel,
        isFallbackRoute: false,
        isLegacyRoute: false,
        recentThreadFeedback: null,
        routeInstructions: route.routeInstructions,
        suggesterInstructions: null,
      }),
    );

    const fallbackInstructions =
      plan.fallbackInstructions?.trim() ||
      (plan.issues.length > 0 ? DEFAULT_FALLBACK_ROUTE_INSTRUCTIONS : null);

    if (fallbackInstructions) {
      routes.push({
        bullmqJobId: `${params.baseJobId}:route:${routes.length + 1}`,
        channelId: params.managerChannelId,
        channelName: formatSlackChannelName(
          plan.fallbackChannelName,
          params.managerChannelId,
        ),
        excludedGroupLabels: groupedLabels,
        groupLabel: 'Manager fallback',
        isFallbackRoute: true,
        isLegacyRoute: false,
        recentThreadFeedback: null,
        routeInstructions: fallbackInstructions,
        suggesterInstructions: null,
      });
    }

    return routes;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Falling back to the manager channel for deployment: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function prepareSuggestionDispatchPlan(params: {
  baseJobId: string;
  deployment: SuggesterDeploymentContext;
  groupedRoutingEnabled: boolean;
  managerChannelId: string;
  now: Date;
  repositoryCoverage: RepositoryCoverage;
  settings: SuggestionRoutingSettings;
}): Promise<SuggestionDispatchPlan> {
  const threadFeedbackByChannelId = new Map<string, string | null>();
  const loadRecentThreadFeedbackForChannel = async (slackChannelId: string) => {
    const cached = threadFeedbackByChannelId.get(slackChannelId);

    if (cached !== undefined) {
      return cached;
    }

    const feedback = await loadAutomationThreadFeedbackReport({
      automationKey: 'suggester',
      slackChannelId,
      now: params.now,
    });

    threadFeedbackByChannelId.set(slackChannelId, feedback.promptText);

    return feedback.promptText;
  };

  await loadRecentThreadFeedbackForChannel(params.managerChannelId);

  const groupedRoutes =
    params.groupedRoutingEnabled &&
    params.settings.suggesterRoutingMode === 'group_by_instructions' &&
    params.settings.suggesterRoutingInstructions
      ? await buildGroupedSuggestionDispatchRoutes({
          baseJobId: params.baseJobId,
          deployment: params.deployment,
          managerChannelId: params.managerChannelId,
          repositoryCoverage: params.repositoryCoverage,
          routingInstructions: params.settings.suggesterRoutingInstructions,
        })
      : null;

  return {
    routes:
      groupedRoutes && groupedRoutes.length > 0
        ? groupedRoutes
        : [
            buildLegacySuggestionDispatchRoute({
              baseJobId: params.baseJobId,
              managerChannelId: params.managerChannelId,
              settings: params.settings,
            }),
          ],
    loadRecentThreadFeedbackForChannel,
  };
}
