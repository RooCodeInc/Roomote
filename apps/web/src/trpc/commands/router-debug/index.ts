import {
  getRouterDebugSettings,
  normalizeRouterDebugDestination,
  updateRouterDebugSettings,
} from '@roomote/db/server';
import type { CommunicationProvider } from '@roomote/types';
import { getCommunicationProviderAdapter } from '@roomote/sdk/server';
import { SlackNotifier } from '@roomote/slack';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../automations/feature-gates';
import { findActiveSlackInstallationForOrg } from '../automations/slack-channels';

export async function getRouterDebugSettingsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  return getRouterDebugSettings();
}

export async function updateRouterDebugSettingsCommand(
  auth: UserAuthSuccess,
  input: {
    provider: CommunicationProvider | null;
    channelId: string | null;
  },
) {
  assertAdmin(auth);

  const destination =
    input.provider && input.channelId
      ? normalizeRouterDebugDestination({
          provider: input.provider,
          channelId: input.channelId,
        })
      : null;

  if ((input.provider || input.channelId) && !destination) {
    throw new Error('Choose a provider and destination.');
  }

  if (destination?.provider === 'slack') {
    const slackInstallation = await findActiveSlackInstallationForOrg();

    if (!slackInstallation?.botAccessToken) {
      throw new Error('Connect Slack before choosing a router debug channel.');
    }

    const notifier = new SlackNotifier(slackInstallation.botAccessToken);
    const hasChannelAccess = await notifier.isAppInChannel(
      destination.channelId,
    );

    if (hasChannelAccess !== true) {
      throw new Error('Invite Roomote to that Slack channel before saving.');
    }
  } else if (destination) {
    const adapter = await getCommunicationProviderAdapter(destination.provider);
    if (!adapter) {
      throw new Error(
        `Connect ${destination.provider} before choosing a destination.`,
      );
    }
  }

  await updateRouterDebugSettings({
    destination,
  });

  return getRouterDebugSettings();
}
