import type { SetupAuthProviderId } from '@roomote/types';

type ProviderSetupCopyId = SetupAuthProviderId | 'telegram';

type ProviderSetupCopy = {
  creationHref: string;
  setupLabel: string;
};

const PROVIDER_SETUP_COPY: Record<ProviderSetupCopyId, ProviderSetupCopy> = {
  slack: {
    creationHref: 'https://api.slack.com/apps?new_app=1',
    setupLabel: 'Slack app',
  },
  microsoft: {
    creationHref:
      'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setupLabel: 'Microsoft Teams app',
  },
  telegram: {
    creationHref: 'https://t.me/BotFather',
    setupLabel: 'Telegram bot',
  },
};

export function getProviderSetupCopy(
  providerId: ProviderSetupCopyId,
): ProviderSetupCopy {
  return PROVIDER_SETUP_COPY[providerId];
}
