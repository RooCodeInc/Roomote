import { getProviderSetupCopy } from './providerSetupCopy';

describe('getProviderSetupCopy', () => {
  it.each([
    [
      'slack',
      {
        creationHref: 'https://api.slack.com/apps?new_app=1',
        setupLabel: 'Slack app',
      },
    ],
    [
      'microsoft',
      {
        creationHref:
          'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
        setupLabel: 'Microsoft Teams app',
      },
    ],
    [
      'telegram',
      {
        creationHref: 'https://t.me/BotFather',
        setupLabel: 'Telegram bot',
        notes: [
          'In the BotFather chat, send /newbot, pick a display name, then a username ending in "bot".',
          'Copy the bot token BotFather replies with into the field below.',
          'Roomote registers the webhook automatically when you save.',
        ],
      },
    ],
  ] as const)('returns setup copy for %s', (providerId, expected) => {
    expect(getProviderSetupCopy(providerId)).toEqual(expected);
  });
});
