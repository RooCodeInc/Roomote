import {
  getRoomoteGitHubAppSlugs,
  getRoomoteManagedGitHubLogins,
  formatPrBodyAttribution,
  matchesRoomoteGitHubLogin,
  normalizePrBodyAttributionAppMention,
  rewritePrBodyAttribution,
} from '../constants';

describe('Roomote GitHub bot identity helpers', () => {
  describe('getRoomoteGitHubAppSlugs', () => {
    it('always includes hosted-product slugs and a custom configured slug', () => {
      expect(getRoomoteGitHubAppSlugs().sort()).toEqual(
        ['roomote', 'roomote-dev'].sort(),
      );
      expect(getRoomoteGitHubAppSlugs('Acme').sort()).toEqual(
        ['acme', 'roomote', 'roomote-dev'].sort(),
      );
    });
  });

  describe('getRoomoteManagedGitHubLogins', () => {
    it('returns exact bot and app logins for hosted and configured slugs', () => {
      expect(getRoomoteManagedGitHubLogins('acme').sort()).toEqual(
        [
          'app/acme',
          'app/roomote',
          'app/roomote-dev',
          'acme[bot]',
          'roomote-dev[bot]',
          'roomote[bot]',
        ].sort(),
      );
    });

    it('does not invent open roomote-* prefix logins', () => {
      expect(
        getRoomoteManagedGitHubLogins('roomote').some((login) =>
          login.startsWith('roomote-staging'),
        ),
      ).toBe(false);
    });
  });

  describe('matchesRoomoteGitHubLogin', () => {
    it('matches exact managed logins for a custom slug', () => {
      expect(matchesRoomoteGitHubLogin('acme[bot]', 'acme')).toBe(true);
      expect(matchesRoomoteGitHubLogin('app/acme', 'acme')).toBe(true);
      expect(matchesRoomoteGitHubLogin('acme[bot]', 'roomote')).toBe(false);
    });

    it('matches roomote-dev and hosted logins without a custom slug', () => {
      expect(matchesRoomoteGitHubLogin('roomote[bot]')).toBe(true);
      expect(matchesRoomoteGitHubLogin('roomote-dev[bot]')).toBe(true);
      expect(matchesRoomoteGitHubLogin('app/roomote-dev')).toBe(true);
    });

    it('matches open roomote-* and app/roomote-* prefix forms', () => {
      expect(matchesRoomoteGitHubLogin('roomote-staging[bot]')).toBe(true);
      expect(matchesRoomoteGitHubLogin('app/roomote-canary')).toBe(true);
      expect(matchesRoomoteGitHubLogin('Roomote-Edge[bot]')).toBe(true);
    });

    it('rejects unrelated logins', () => {
      expect(matchesRoomoteGitHubLogin('octocat')).toBe(false);
      expect(matchesRoomoteGitHubLogin('app/dependabot')).toBe(false);
    });
  });

  describe('normalizePrBodyAttributionAppMention', () => {
    it('rewrites a hardcoded @roomote mention to the configured app slug', () => {
      const body = `${formatPrBodyAttribution(
        'Created by Roomote.',
        'Follow up by mentioning @roomote or in [the web UI](https://example.com/task/1).',
      )}\n\n## What changed\n\nDone.`;

      expect(
        normalizePrBodyAttributionAppMention(body, 'roomote-roomote'),
      ).toBe(
        `${formatPrBodyAttribution(
          'Created by Roomote.',
          'Follow up by mentioning @roomote-roomote or in [the web UI](https://example.com/task/1).',
        )}\n\n## What changed\n\nDone.`,
      );
    });

    it('keeps the shorthand when it is enabled', () => {
      const body = formatPrBodyAttribution(
        'Created by Roomote.',
        'Follow up by mentioning @roomote-roomote.',
      );

      expect(
        normalizePrBodyAttributionAppMention(body, 'roomote-roomote', true),
      ).toBe(
        formatPrBodyAttribution(
          'Created by Roomote.',
          'Follow up by mentioning @roomote.',
        ),
      );
    });

    it('rewrites Opened on behalf of attribution mentions', () => {
      const body = formatPrBodyAttribution(
        'Opened on behalf of Matt Rubens.',
        '[View the task](https://example.com/task/1) or mention @roomote for follow-up asks.',
      );

      expect(normalizePrBodyAttributionAppMention(body, 'openmote')).toBe(
        formatPrBodyAttribution(
          'Opened on behalf of Matt Rubens.',
          '[View the task](https://example.com/task/1) or mention @openmote for follow-up asks.',
        ),
      );
    });

    it('leaves already-correct mentions and non-attribution body text alone', () => {
      const body =
        '> Created by Roomote. Follow up by mentioning @roomote-roomote or in [the web UI](https://example.com/task/1).\n\nSee also @roomote in the body.';

      expect(
        normalizePrBodyAttributionAppMention(body, 'roomote-roomote'),
      ).toBe(body);
    });

    it('does nothing when there is no attribution line', () => {
      const body = '## What changed\n\nNo provenance line.';

      expect(normalizePrBodyAttributionAppMention(body, 'openmote')).toBe(body);
    });

    it('leaves unmarked historical attribution alone', () => {
      const body =
        '> Created by Roomote from an unlinked Slack user. Follow up by mentioning @roomote or in the web UI.';

      expect(
        normalizePrBodyAttributionAppMention(body, 'roomote-roomote'),
      ).toBe(body);
    });
  });

  describe('rewritePrBodyAttribution', () => {
    const instruction =
      '[View the task](https://example.com/task/1) or mention @roomote for follow-up asks.';
    const body = `${formatPrBodyAttribution(
      'Opened on behalf of Private Name.',
      instruction,
    )}\n\n## What changed\n\nDone.`;

    it('uses a public handle without changing the attribution tail', () => {
      expect(rewritePrBodyAttribution(body, '@octocat')).toBe(
        `${formatPrBodyAttribution('Opened on behalf of @octocat.', instruction)}\n\n## What changed\n\nDone.`,
      );
    });

    it('uses generic Roomote provenance when no public identity exists', () => {
      expect(rewritePrBodyAttribution(body, null)).toBe(
        `${formatPrBodyAttribution('Created by Roomote.', instruction)}\n\n## What changed\n\nDone.`,
      );
    });

    it('handles periods in marked display names without parsing them', () => {
      const marked = formatPrBodyAttribution(
        'Opened on behalf of Jane R. Doe.',
        instruction,
      );

      expect(rewritePrBodyAttribution(marked, null)).toBe(
        formatPrBodyAttribution('Created by Roomote.', instruction),
      );
    });

    it('rewrites a marked attribution line after a preamble', () => {
      const marked = `Preamble\n${formatPrBodyAttribution(
        'Opened on behalf of Private Name.',
        instruction,
      )}`;

      expect(rewritePrBodyAttribution(marked, null)).toBe(
        `Preamble\n${formatPrBodyAttribution('Created by Roomote.', instruction)}`,
      );
    });

    it('ignores markers outside an attribution blockquote', () => {
      const unquoted = formatPrBodyAttribution(
        'Opened on behalf of Private Name.',
        instruction,
      ).slice(2);
      expect(rewritePrBodyAttribution(unquoted, null)).toBe(unquoted);
    });

    it('does not parse or upgrade unmarked attribution', () => {
      const legacy =
        '> Opened on behalf of Jane R. Doe. Follow up by mentioning @roomote.';
      expect(rewritePrBodyAttribution(legacy, null)).toBe(legacy);
    });
  });
});
