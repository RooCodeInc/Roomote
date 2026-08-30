import { describe, expect, it } from 'vitest';

import { buildFastSessionReplyFooterText } from '../fast-session-footer';

describe('buildFastSessionReplyFooterText', () => {
  it.each(['slack', 'discord', 'teams', 'telegram'] as const)(
    'builds a provider-attributed Fast session link for %s',
    (provider) => {
      const footer = buildFastSessionReplyFooterText({
        provider,
        sessionId: '11111111-1111-4111-8111-111111111111',
      });

      expect(footer).toContain('Reply or use the');
      expect(footer).toContain(
        '/sessions/11111111-1111-4111-8111-111111111111',
      );
      expect(footer).toContain(`utm_source=${provider}`);
    },
  );

  it.each([
    {
      provider: 'slack' as const,
      expectedPrLink: '<https://github.com/roomote/roomote/pull/123|PR #123>',
      expectedWebLink: '|web app>',
    },
    {
      provider: 'discord' as const,
      expectedPrLink: '[PR #123](https://github.com/roomote/roomote/pull/123)',
      expectedWebLink: '[web app](',
    },
    {
      provider: 'teams' as const,
      expectedPrLink: '[PR #123](https://github.com/roomote/roomote/pull/123)',
      expectedWebLink: '[web app](',
    },
    {
      provider: 'telegram' as const,
      expectedPrLink: '[PR #123](https://github.com/roomote/roomote/pull/123)',
      expectedWebLink: '[web app](',
    },
  ])(
    'includes a linked pull request in the $provider footer',
    ({ provider, expectedPrLink, expectedWebLink }) => {
      const footer = buildFastSessionReplyFooterText({
        provider,
        sessionId: '11111111-1111-4111-8111-111111111111',
        pullRequest: {
          number: 123,
          url: 'https://github.com/roomote/roomote/pull/123',
        },
      });

      expect(footer).toContain(`Working on ${expectedPrLink}`);
      expect(footer).toContain(expectedWebLink);
    },
  );

  it('includes multiple pull requests and a live preview', () => {
    const footer = buildFastSessionReplyFooterText({
      provider: 'discord',
      sessionId: '11111111-1111-4111-8111-111111111111',
      pullRequests: [
        {
          number: 123,
          url: 'https://github.com/roomote/roomote/pull/123',
        },
        {
          number: 456,
          url: 'https://github.com/roomote/roomote/pull/456',
        },
      ],
      livePreviewUrl: 'https://preview.roomote.dev',
    });

    expect(footer).toContain(
      'Working on [PR #123](https://github.com/roomote/roomote/pull/123) and [PR #456](https://github.com/roomote/roomote/pull/456), [live preview](https://preview.roomote.dev)',
    );
  });

  it('omits terminal pull requests', () => {
    const footer = buildFastSessionReplyFooterText({
      provider: 'telegram',
      sessionId: '11111111-1111-4111-8111-111111111111',
      pullRequest: {
        number: 123,
        url: 'https://github.com/roomote/roomote/pull/123',
        status: 'merged',
      },
    });

    expect(footer).not.toContain('Working on');
    expect(footer).toContain('Reply or use the');
  });
});
