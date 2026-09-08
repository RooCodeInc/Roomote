import {
  ciFailureTriageRepositoryRoutesSchema,
  getTriggerableBackgroundAutomationDescriptorByKey,
  type CiFailureTriageRepositoryRoute,
} from '@roomote/types';
import {
  findDiscordDestinationByChannelId,
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
} from '@roomote/sdk/server';
import { SlackNotifier } from '@roomote/slack';

import { getRepositories } from '@/lib/server/source-control';
import type { UserAuthSuccess } from '@/types';

import {
  findActiveSlackInstallationForOrg,
  resolveChannelId,
} from './slack-channels';

export async function resolveCiFailureTriageRepositoryRoutes(
  auth: UserAuthSuccess,
  input: CiFailureTriageRepositoryRoute[],
): Promise<CiFailureTriageRepositoryRoute[]> {
  const routes = ciFailureTriageRepositoryRoutesSchema.parse(input);
  if (routes.length === 0) return routes;
  const descriptor =
    getTriggerableBackgroundAutomationDescriptorByKey('ci_failure_triage')!;
  const available = await getRepositories(auth);
  const eligibleIds = new Set(
    available
      .filter((repo) =>
        descriptor.supportedSourceControlProviders.some(
          (provider) => provider === repo.sourceControlProvider,
        ),
      )
      .map((repo) => repo.id),
  );
  if (
    routes.some((route) =>
      route.repositoryIds.some((id) => !eligibleIds.has(id)),
    )
  ) {
    throw new Error(
      'Choose active, accessible repositories supported by CI Failure Triage.',
    );
  }
  const connected = await listConnectedCommunicationProviders();
  const installation = routes.some((route) => route.target.provider === 'slack')
    ? await findActiveSlackInstallationForOrg()
    : null;
  const notifier = installation
    ? new SlackNotifier(installation.botAccessToken)
    : null;
  for (const route of routes) {
    const target = route.target;
    if (
      !connected.includes(target.provider) ||
      !descriptor.supportedCommunicationProviders.some(
        (provider) => provider === target.provider,
      )
    ) {
      throw new Error(
        `Connect ${target.provider} before saving a ${target.provider} report destination.`,
      );
    }
    if (target.provider === 'slack') {
      const resolved = await resolveChannelId({
        field: 'ciFailureTriageSlackChannel',
        input: target.externalRef,
        notifier,
      });
      if (!resolved.channelId)
        throw new Error(resolved.error?.message ?? 'Choose a Slack channel.');
      target.externalRef = resolved.channelId;
    } else if (target.provider === 'discord') {
      if (!(await findDiscordDestinationByChannelId(target.externalRef))) {
        throw new Error('This Discord channel is not available to Roomote.');
      }
    } else {
      const destination = await resolveAutomationRuntimeDestination({
        runtime: {
          targets: [target],
          destination: {
            provider: target.provider,
            channelId: target.externalRef,
            source: 'automation_target',
          },
        },
        slackConnected: connected.includes('slack'),
      });
      if (!destination)
        throw new Error(
          `This ${target.provider} destination is not available to Roomote.`,
        );
    }
  }
  return routes;
}
