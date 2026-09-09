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
import {
  db,
  eq,
  slackInstallationChannels,
  slackInstallations,
} from '@roomote/db/server';

import { getRepositories } from '@/lib/server/source-control';
import type { UserAuthSuccess } from '@/types';

import {
  normalizeSlackChannelIdInput,
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
      const active = await db.query.slackInstallations.findMany({
        where: eq(slackInstallations.isActive, true),
      });
      let channelId = normalizeSlackChannelIdInput(target.externalRef);
      if (!channelId) {
        if (active.length !== 1)
          throw new Error(
            'Use a Slack channel ID when multiple workspaces are connected.',
          );
        const resolved = await resolveChannelId({
          field: 'ciFailureTriageSlackChannel',
          input: target.externalRef.trim(),
          notifier: new SlackNotifier(active[0]!.botAccessToken),
        });
        channelId = normalizeSlackChannelIdInput(resolved.channelId);
        if (!channelId)
          throw new Error(resolved.error?.message ?? 'Choose a Slack channel.');
      }
      const mappings = await db.query.slackInstallationChannels.findMany({
        where: eq(slackInstallationChannels.channelId, channelId),
        with: { slackInstallation: true },
        limit: 2,
      });
      if (
        mappings.length > 1 ||
        (mappings[0] && !mappings[0].slackInstallation.isActive)
      )
        throw new Error(
          'This Slack channel has ambiguous or inactive workspace ownership.',
        );
      const candidates = mappings[0] ? [mappings[0].slackInstallation] : active;
      const memberships = await Promise.all(
        candidates.map(async (installation) => {
          try {
            return await new SlackNotifier(
              installation.botAccessToken,
            ).isAppInChannel(channelId);
          } catch {
            return null;
          }
        }),
      );
      const owners = candidates.filter(
        (_, index) => memberships[index] === true,
      );
      if (
        owners.length !== 1 ||
        memberships.some(
          (membership) => membership !== true && membership !== false,
        )
      )
        throw new Error(
          'Could not verify a unique Slack workspace with Roomote in this channel.',
        );
      const owner = owners[0]!;
      if (mappings.length === 0) {
        await db
          .insert(slackInstallationChannels)
          .values({
            slackInstallationId: owner.id,
            channelId,
          })
          .onConflictDoNothing();
      }
      // Recheck after probing/inserting so a changed mapping cannot select another bot.
      const verified = await db.query.slackInstallationChannels.findMany({
        where: eq(slackInstallationChannels.channelId, channelId),
        with: { slackInstallation: true },
        limit: 2,
      });
      if (
        verified.length !== 1 ||
        verified[0]!.slackInstallationId !== owner.id ||
        !verified[0]!.slackInstallation.isActive
      )
        throw new Error(
          'Slack channel ownership changed. Choose the channel again.',
        );
      target.externalRef = channelId;
      target.metadata = { teamId: owner.teamId };
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
