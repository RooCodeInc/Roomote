import { describe, expect, it } from 'vitest';

import {
  buildFastSessionReplyFooterText,
  buildFastSessionUrl,
  buildSelectedTaskSessionUrl,
} from '../fast-session-footer';
import {
  AGENTMAIL_MAX_TEXT_LENGTH,
  buildAgentMailEmailBody,
  buildAgentMailButtonSections,
  escapeAgentMailHtml,
} from '../agentmail-format';

describe('buildSelectedTaskSessionUrl', () => {
  it.each(['slack', 'discord'] as const)(
    'preserves %s attribution while explicitly selecting the task',
    (provider) => {
      const taskUrl = `https://roomote.example/task/task-1?utm_source=${provider}&utm_medium=link&utm_campaign=fast-delegation`;

      expect(
        buildSelectedTaskSessionUrl({
          taskUrl,
          sessionId: 'session-1',
          taskId: 'task-1',
        }),
      ).toBe(
        `https://roomote.example/sessions/session-1?utm_source=${provider}&utm_medium=link&utm_campaign=fast-delegation&task=task-1`,
      );
    },
  );
});

describe('buildFastSessionReplyFooterText', () => {
  it.each(['slack', 'discord', 'teams', 'telegram'] as const)(
    'builds a provider-attributed Fast session link for %s',
    (provider) => {
      const footer = buildFastSessionReplyFooterText({
        provider,
        sessionId: '11111111-1111-4111-8111-111111111111',
      });

      expect(footer).toContain('Open in Roomote');
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
      expectedWebLink: '|Open in Roomote>',
    },
    {
      provider: 'discord' as const,
      expectedPrLink: '[PR #123](https://github.com/roomote/roomote/pull/123)',
      expectedWebLink: '[Open in Roomote](',
    },
    {
      provider: 'teams' as const,
      expectedPrLink: '[PR #123](https://github.com/roomote/roomote/pull/123)',
      expectedWebLink: '[Open in Roomote](',
    },
    {
      provider: 'telegram' as const,
      expectedPrLink: '[PR #123](https://github.com/roomote/roomote/pull/123)',
      expectedWebLink: '[Open in Roomote](',
    },
    ...(['github', 'gitlab', 'bitbucket', 'ado', 'gitea'] as const).map(
      (provider) => ({
        provider,
        expectedPrLink:
          '[PR #123](https://github.com/roomote/roomote/pull/123)',
        expectedWebLink: '[Open in Roomote](',
      }),
    ),
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

      expect(footer).toContain(expectedPrLink);
      expect(footer).toContain(expectedWebLink);
      expect(footer).toContain('Reply anytime · ');
      expect(footer).not.toContain('Live preview');
      expect(footer).not.toMatch(/^_/);
    },
  );

  it('groups multiple pull requests and omits the preview chunk', () => {
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
      'Reply anytime · [PR #123](https://github.com/roomote/roomote/pull/123), [PR #456](https://github.com/roomote/roomote/pull/456) · [Open in Roomote]',
    );
    expect(footer).not.toContain('Live preview');
  });

  it('renders the GitHub footer as small subtext without changing its content', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';

    expect(
      buildFastSessionReplyFooterText({
        provider: 'github',
        sessionId,
        pullRequest: {
          number: 123,
          url: 'https://github.com/roomote/roomote/pull/123',
        },
        livePreviewUrl: 'https://preview.roomote.dev',
      }),
    ).toBe(
      `<sub>Reply anytime · [PR #123](https://github.com/roomote/roomote/pull/123) · [Open in Roomote](${buildFastSessionUrl('github', sessionId)})</sub>`,
    );
  });

  it('applies email-only footer styling while preserving its link', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const markdown = buildFastSessionReplyFooterText({
      provider: 'agentmail',
      sessionId,
    });
    const body = buildAgentMailEmailBody(`Body text\n\n${markdown}`);

    expect(body.html).toContain(
      `<p style="font-size:0.875em">Reply anytime · <a href="${escapeAgentMailHtml(buildFastSessionUrl('agentmail', sessionId))}">Open in Roomote</a></p>`,
    );
    expect(body.html).not.toContain('<hr');
    expect(body.html).not.toContain('--');
    expect(body.text).toContain(
      `\n\n--\nReply anytime · Open in Roomote (${buildFastSessionUrl('agentmail', sessionId)})`,
    );
  });

  it('keeps the trusted email footer when an oversized reply has action sections', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const markdown = buildFastSessionReplyFooterText({
      provider: 'agentmail',
      sessionId,
    });
    const body = buildAgentMailEmailBody(
      `${'a'.repeat(AGENTMAIL_MAX_TEXT_LENGTH)}\n\n${markdown}`,
    );
    const actions = buildAgentMailButtonSections([
      [{ text: '<Review>', url: 'https://roomote.example/action?a=1&b=2' }],
    ]);

    expect(`${body.html}${actions.html}`).toContain(
      `>Open in Roomote</a></p></div><div><a href="https://roomote.example/action?a=1&amp;b=2"`,
    );
    expect(`${body.text}\n\n${actions.text}`).toContain(
      `\n--\nReply anytime · Open in Roomote (${buildFastSessionUrl('agentmail', sessionId)})\n\n<Review>: https://roomote.example/action?a=1&b=2`,
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
    expect(footer).toContain('Open in Roomote');
  });

  it.each([
    'slack',
    'discord',
    'teams',
    'telegram',
    'github',
    'gitlab',
    'bitbucket',
    'ado',
    'gitea',
  ] as const)(
    'keeps task selection out of the %s transcript link',
    (provider) => {
      const taskUrl = 'https://roomote.example/sessions/owner?task=task-1';
      for (const [count, taskChunk] of [
        [0, ''],
        [1, ' · 1 task running'],
        [3, ' · 3 tasks running'],
      ] as const) {
        const footer = buildFastSessionReplyFooterText({
          provider,
          sessionId: 'conversation',
          runningTasks: { count, url: taskUrl },
        });
        expect(footer).toContain(`Reply anytime${taskChunk} · `);
        expect(
          new URL(
            buildFastSessionUrl(provider, 'conversation'),
          ).searchParams.has('task'),
        ).toBe(false);
        expect(footer).toContain(
          provider === 'slack' ? '|Open in Roomote>' : '[Open in Roomote](',
        );
        expect(footer).not.toMatch(/^_/);
      }
    },
  );
});
