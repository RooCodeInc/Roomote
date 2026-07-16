import {
  buildDiscordInvocationIdentity,
  buildGitHubInvocationIdentity,
  buildSlackInvocationIdentity,
  buildTeamsInvocationIdentity,
  buildTelegramInvocationIdentity,
} from '../invocation-identity';

describe('invocation identity formatting', () => {
  it('formats the Discord bot identity as a mention and profile link', () => {
    expect(
      buildDiscordInvocationIdentity({
        botUserId: '123456789',
        username: 'roomote-bot',
        displayName: 'Roomote',
      }),
    ).toMatchObject({
      provider: 'discord',
      configured: true,
      displayName: 'Roomote',
      mentionText: '@roomote-bot',
      nativeMention: '<@123456789>',
      deepLinkUrl: 'https://discord.com/users/123456789',
    });
  });

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
      guidanceName: '@Acme Bot',
      examplePrompt: '@Acme Bot Add support for a reset password flow.',
    });

    expect(
      buildSlackInvocationIdentity({
        botUserId: 'U123',
      }),
    ).toMatchObject({
      displayName: null,
      mentionText: null,
      nativeMention: '<@U123>',
      guidanceName: 'Slack app',
      examplePrompt: null,
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
      examplePrompt: '@Contoso Bot Add support for a reset password flow.',
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

  it('builds Teams examples from the normalized mention text', () => {
    expect(buildTeamsInvocationIdentity('@Contoso')).toMatchObject({
      displayName: '@Contoso',
      mentionText: '@Contoso',
      examplePrompt: '@Contoso Add support for a reset password flow.',
    });
  });
});
