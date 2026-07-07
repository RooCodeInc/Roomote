import {
  getRouterDebugSettings,
  normalizeRouterDebugSlackChannelId,
  updateRouterDebugSettings,
} from '@roomote/db/server';
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
    routerDebugSlackChannelId: string | null;
  },
) {
  assertAdmin(auth);

  const routerDebugSlackChannelId = input.routerDebugSlackChannelId
    ? normalizeRouterDebugSlackChannelId(input.routerDebugSlackChannelId)
    : null;

  if (input.routerDebugSlackChannelId && !routerDebugSlackChannelId) {
    throw new Error('Choose a valid Slack channel.');
  }

  if (routerDebugSlackChannelId) {
    const slackInstallation = await findActiveSlackInstallationForOrg();

    if (!slackInstallation?.botAccessToken) {
      throw new Error('Connect Slack before choosing a router debug channel.');
    }

    const notifier = new SlackNotifier(slackInstallation.botAccessToken);
    const hasChannelAccess = await notifier.isAppInChannel(
      routerDebugSlackChannelId,
    );

    if (hasChannelAccess !== true) {
      throw new Error('Invite Roomote to that Slack channel before saving.');
    }
  }

  await updateRouterDebugSettings({
    routerDebugSlackChannelId,
  });

  return getRouterDebugSettings();
}
