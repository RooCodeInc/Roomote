import type { SetupAuthProviderId } from '@roomote/types';

type ProviderSetupCopyId = SetupAuthProviderId | 'telegram';

type ProviderSetupCopy = {
  creationHref: string;
  setupLabel: string;
  notes?: readonly string[];
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
    notes: [
      'In the BotFather chat, send /newbot, pick a display name, then a username ending in "bot".',
      'Copy the bot token BotFather replies with into the field below.',
      'Roomote registers the webhook automatically when you save.',
    ],
  },
};

export function getProviderSetupCopy(
  providerId: ProviderSetupCopyId,
): ProviderSetupCopy {
  return PROVIDER_SETUP_COPY[providerId];
}
