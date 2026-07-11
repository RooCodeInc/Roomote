const { mockDbSelect, mockEq } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockEq: vi.fn((left: unknown, right: unknown) => [left, right]),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: mockDbSelect,
  },
  eq: mockEq,
  users: {
    id: 'users.id',
    metadata: 'users.metadata',
  },
}));

import {
  buildAutomationRootSummaryMessage,
  buildAutomationRootSummaryText,
  buildAutomationSettingsContextText,
  buildAutomationSettingsMessage,
  SENTRY_TRIAGE_SETTINGS_HASH,
  SUGGEST_IDEAS_SETTINGS_HASH,
  shouldPostHistoricalThreadFeedbackDebugSnippet,
} from '../manager-slack';

describe('manager slack helpers', () => {
  const originalApiUrl = process.env.R_APP_URL;

  function mockMetadataLookup(
    result:
      | Array<{ metadata?: Record<string, unknown> | null }>
      | PromiseLike<Array<{ metadata?: Record<string, unknown> | null }>>,
  ) {
    mockDbSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => result,
        }),
      }),
    });
  }

  beforeEach(() => {
    process.env.R_APP_URL = 'https://app.example.com';
    mockDbSelect.mockReset();
    mockEq.mockClear();
  });

  afterEach(() => {
    if (originalApiUrl === undefined) {
      delete process.env.R_APP_URL;
    } else {
      process.env.R_APP_URL = originalApiUrl;
    }
  });

  it('builds an automation settings context link', () => {
    expect(
      buildAutomationSettingsContextText(SUGGEST_IDEAS_SETTINGS_HASH),
    ).toBe(
      'Configure the Suggest Ideas automation in <https://app.example.com/automations#suggest-ideas|automation settings>.',
    );
    expect(
      buildAutomationSettingsContextText(SENTRY_TRIAGE_SETTINGS_HASH),
    ).toBe(
      'Configure the Triage Sentry Issues automation in <https://app.example.com/automations#sentry-triage|automation settings>.',
    );
  });

  it('wraps automation text in a section and context footer', () => {
    expect(
      buildAutomationSettingsMessage('  Hello managers  ', 'suggest-ideas'),
    ).toEqual({
      text: 'Hello managers',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Hello managers',
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'Configure the Suggest Ideas automation in <https://app.example.com/automations#suggest-ideas|automation settings>.',
            },
          ],
        },
      ],
    });
  });

  it('joins a generated summary with an optional action footer', () => {
    expect(
      buildAutomationRootSummaryText({
        summaryText: '  - Do the important thing  ',
        actionFooterText: '  React on a thread item to start it.  ',
      }),
    ).toBe('- Do the important thing\n\nReact on a thread item to start it.');
  });

  it('wraps a generated root summary in the standard automation message chrome', () => {
    expect(
      buildAutomationRootSummaryMessage({
        summaryText: '  - Do the important thing  ',
        actionFooterText: '  React on a thread item to start it.  ',
        automationSettingsHash: 'suggest-ideas',
      }),
    ).toEqual({
      text: '- Do the important thing\n\nReact on a thread item to start it.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '- Do the important thing\n\nReact on a thread item to start it.',
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'Configure the Suggest Ideas automation in <https://app.example.com/automations#suggest-ideas|automation settings>.',
            },
          ],
        },
      ],
    });
  });

  it('posts historical thread feedback debug snippets only when show debug UI is enabled', async () => {
    mockMetadataLookup([
      {
        metadata: {
          show_debug_ui_setting: true,
          show_debug_ui: true,
        },
      },
    ]);

    await expect(
      shouldPostHistoricalThreadFeedbackDebugSnippet({
        userId: 'user-1',
        logPrefix: '[manager-slack]',
        warn: vi.fn(),
      }),
    ).resolves.toBe(true);
  });

  it('skips historical thread feedback debug snippets when show debug UI is disabled', async () => {
    mockMetadataLookup([
      {
        metadata: {
          show_debug_ui_setting: true,
          show_debug_ui: false,
        },
      },
    ]);

    await expect(
      shouldPostHistoricalThreadFeedbackDebugSnippet({
        userId: 'user-1',
        logPrefix: '[manager-slack]',
        warn: vi.fn(),
      }),
    ).resolves.toBe(false);
  });

  it('skips historical thread feedback debug snippets when user metadata is missing', async () => {
    mockMetadataLookup([]);

    await expect(
      shouldPostHistoricalThreadFeedbackDebugSnippet({
        userId: 'user-1',
        logPrefix: '[manager-slack]',
        warn: vi.fn(),
      }),
    ).resolves.toBe(false);
  });

  it('fails open when show debug UI metadata lookup fails', async () => {
    const warn = vi.fn();

    mockDbSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.reject(new Error('metadata unavailable')),
        }),
      }),
    });

    await expect(
      shouldPostHistoricalThreadFeedbackDebugSnippet({
        userId: 'user-1',
        logPrefix: '[manager-slack]',
        warn,
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[manager-slack] Failed to load show-debug-ui preference for user user-1; skipping historical thread debug snippet: metadata unavailable',
    );
  });
});
