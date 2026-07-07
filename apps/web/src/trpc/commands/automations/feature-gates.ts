import { getBackgroundAgentSettingsForDeployment } from '@roomote/db/server';
import { DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

export function assertAdmin(auth: UserAuthSuccess) {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

export function maskSlackChannelAutoStartSettings(
  auth: UserAuthSuccess,
  settings: Awaited<ReturnType<typeof getBackgroundAgentSettingsForDeployment>>,
): Awaited<ReturnType<typeof getBackgroundAgentSettingsForDeployment>> {
  return {
    ...settings,
    channelAutoStartSlackChannels: settings.channelAutoStartSlackChannels.map(
      (row) => ({
        ...row,
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
      }),
    ),
  };
}
