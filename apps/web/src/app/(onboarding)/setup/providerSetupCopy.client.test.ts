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
      },
    ],
  ] as const)('returns setup copy for %s', (providerId, expected) => {
    expect(getProviderSetupCopy(providerId)).toEqual(expected);
  });
});
