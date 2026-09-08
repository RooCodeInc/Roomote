import type { AutomationRuntime } from '@roomote/db/server';
import {
  getCiFailureTriageRepositoryRoutes,
  type CommunicationProvider,
} from '@roomote/types';

import {
  resolveAutomationRuntimeDestination,
  type ResolvedAutomationDestination,
} from './destination';

export async function resolveCiFailureTriageRepositoryDestination(params: {
  runtime: AutomationRuntime;
  repositoryId: string;
  connectedProviders: readonly CommunicationProvider[];
  destination?: ResolvedAutomationDestination;
}): Promise<ResolvedAutomationDestination | null> {
  const routes = getCiFailureTriageRepositoryRoutes(params.runtime.settings);
  const route = routes?.find((entry) =>
    entry.repositoryIds.includes(params.repositoryId),
  );
  if (routes !== undefined && !route) return null;
  // A one-off destination overrides delivery, never the repository allowlist.
  if (params.destination) return params.destination;
  if (route && !params.connectedProviders.includes(route.target.provider))
    return null;
  return resolveAutomationRuntimeDestination({
    runtime: route
      ? {
          destination: {
            provider: route.target.provider,
            channelId: route.target.externalRef,
            source: 'automation_target',
          },
          targets: [route.target],
        }
      : params.runtime,
    slackConnected: params.connectedProviders.includes('slack'),
  });
}
