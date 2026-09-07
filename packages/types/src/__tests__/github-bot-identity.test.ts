import {
  findPrBodyAttributionLine,
  formatPrBodyAttribution,
  matchesRoomoteGitHubLogin,
  normalizePrBodyAttributionAppMention,
  rewritePrBodyAttribution,
} from '../constants';

describe('Roomote GitHub bot identity helpers', () => {
  describe('formatPrBodyAttribution', () => {
    it('keeps marker comments inline so the instruction renders as Markdown', () => {
      expect(
        formatPrBodyAttribution(
          'Opened on behalf of @octocat.',
          'Follow up in [the web UI](https://example.com/task/1).',
        ),
      ).toBe(
        '> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of @octocat.<!-- roomote:pr-attribution:end --> Follow up in [the web UI](https://example.com/task/1).',
      );
    });

    it.each(['&#8203;', '&amp;#8203;', '\u200B'])(
      'finds marker-wrapped attribution with the %s prefix',
      (prefix) => {
        const body = `\n\n> ${prefix}<!-- roomote:pr-attribution:start -->Created by Roomote.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote.`;

        expect(findPrBodyAttributionLine(body)).toBe('> Created by Roomote.');
      },
    );
  });

  describe('matchesRoomoteGitHubLogin', () => {
    it('matches only exact logins for the configured slug', () => {
      expect(matchesRoomoteGitHubLogin('Acme[bot]', ' acme ')).toBe(true);
      expect(matchesRoomoteGitHubLogin('APP/ACME', 'acme')).toBe(true);
      expect(matchesRoomoteGitHubLogin('acme[bot]', 'roomote')).toBe(false);
      expect(matchesRoomoteGitHubLogin('roomote-preview[bot]', 'roomote')).toBe(
        false,
      );
    });

    it('matches nothing without a configured slug', () => {
      expect(matchesRoomoteGitHubLogin('roomote[bot]')).toBe(false);
      expect(matchesRoomoteGitHubLogin('app/roomote')).toBe(false);
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

    it('continues to rewrite legacy line-leading markers', () => {
      const legacy =
        '> <!-- roomote:pr-attribution:start -->Opened on behalf of Private Name.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote.';

      expect(rewritePrBodyAttribution(legacy, '@octocat')).toBe(
        '> <!-- roomote:pr-attribution:start -->Opened on behalf of @octocat.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote.',
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
