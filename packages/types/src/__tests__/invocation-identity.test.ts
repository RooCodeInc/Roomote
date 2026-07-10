import {
  buildGitHubInvocationIdentity,
  buildSlackInvocationIdentity,
  buildTeamsInvocationIdentity,
  buildTelegramInvocationIdentity,
} from '../invocation-identity';

describe('invocation identity formatting', () => {
  it('formats a custom GitHub app slug as a mention', () => {
    expect(buildGitHubInvocationIdentity('custom-slug')).toMatchObject({
      provider: 'github',
      mentionText: '@custom-slug',
      nativeMention: '@custom-slug',
      examplePrompt: '@custom-slug address the PR feedback above',
    });
  });

  it('formats a Telegram username as a handle and deep link', () => {
    expect(buildTelegramInvocationIdentity('@custom_bot')).toMatchObject({
      provider: 'telegram',
      mentionText: '@custom_bot',
      nativeMention: '@custom_bot',
      deepLinkUrl: 'https://t.me/custom_bot',
    });
  });

  it('formats Slack display and native mentions without inventing a fallback handle', () => {
    expect(
      buildSlackInvocationIdentity({
        botUserId: 'U123',
        botName: 'Acme Bot',
      }),
    ).toMatchObject({
      displayName: 'Acme Bot',
      mentionText: '@Acme Bot',
      nativeMention: '<@U123>',
    });

    expect(
      buildSlackInvocationIdentity({
        botUserId: 'U123',
      }),
    ).toMatchObject({
      displayName: null,
      mentionText: null,
      nativeMention: '<@U123>',
    });
  });

  it('marks Teams package defaults separately from configured names', () => {
    expect(
      buildTeamsInvocationIdentity({
        displayName: 'Contoso Bot',
        configured: true,
      }),
    ).toMatchObject({
      displayName: 'Contoso Bot',
      mentionText: '@Contoso Bot',
      configured: true,
    });

    expect(
      buildTeamsInvocationIdentity({
        displayName: 'Roomote',
        configured: false,
      }),
    ).toMatchObject({
      displayName: 'Roomote',
      mentionText: '@Roomote',
      configured: false,
    });
  });
});
