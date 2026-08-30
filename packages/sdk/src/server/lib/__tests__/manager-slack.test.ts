import {
  buildAutomationRootSummaryMessage,
  buildAutomationRootSummaryText,
  buildAutomationSettingsContextText,
  buildAutomationSettingsMessage,
  buildCustomAutomationSlackMessage,
  degradeSlackMrkdwnToMarkdown,
  SENTRY_TRIAGE_SETTINGS_HASH,
  SUGGEST_IDEAS_SETTINGS_HASH,
  shouldPostHistoricalThreadFeedbackDebugSnippet,
} from '../manager-slack';

describe('manager slack helpers', () => {
  const originalApiUrl = process.env.R_APP_URL;

  beforeEach(() => {
    process.env.R_APP_URL = 'https://app.example.com';
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

  it('wraps automation text in a structured result container', () => {
    const message = buildAutomationSettingsMessage(
      '  Hello managers  ',
      'suggest-ideas',
    );

    expect(message.text).toBe('Hello managers');
    expect(message.blocks).toEqual([
      expect.objectContaining({
        type: 'container',
        width: 'full',
        title: {
          type: 'plain_text',
          text: 'Suggest Ideas',
          emoji: false,
        },
        icon: {
          type: 'image',
          image_url: 'https://app.example.com/automation-icons/lightbulb.png',
          alt_text: 'Suggest Ideas automation icon',
        },
        child_blocks: [
          expect.objectContaining({
            type: 'section',
            block_id: 'roomote_automation_result_settings',
            accessory: expect.objectContaining({
              action_id: 'late_bound_automation_configure',
              accessibility_label: 'Configure Suggest Ideas automation',
              url: 'https://app.example.com/automations#suggest-ideas',
            }),
          }),
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Hello managers' },
          },
        ],
      }),
    ]);
  });

  it('uses the standard automation chrome for custom automation reports', () => {
    const message = buildCustomAutomationSlackMessage({
      automationId: 'automation-1',
      automationName: 'Weekly scan',
      text: 'Found two regressions.',
      sessionId: 'session-1',
    });

    expect(message).toEqual({
      text: 'Found two regressions.',
      blocks: [
        {
          type: 'context',
          block_id: 'roomote_automation_result_header',
          elements: [
            {
              type: 'image',
              image_url: 'https://app.example.com/automation-icons/zap.png',
              alt_text: 'Weekly scan automation icon',
            },
            {
              type: 'plain_text',
              text: 'Weekly scan',
              emoji: false,
            },
          ],
        },
        expect.objectContaining({
          type: 'section',
          block_id: 'roomote_automation_result_settings',
          accessory: expect.objectContaining({
            action_id: 'late_bound_automation_configure',
            accessibility_label: 'Configure Weekly scan automation',
            url: 'https://app.example.com/automations#custom-automation-automation-1',
          }),
        }),
        { type: 'markdown', text: 'Found two regressions.' },
        {
          type: 'actions',
          block_id: 'roomote_automation_result_actions',
          elements: [
            expect.objectContaining({
              action_id: 'late_bound_automation_view_session',
              text: expect.objectContaining({ text: 'Follow' }),
              url: expect.stringMatching(
                /\/sessions\/session-1\?utm_source=slack&utm_medium=link&utm_campaign=slack\.fast_reply$/,
              ),
            }),
          ],
        },
      ],
    });
  });

  it('preserves custom automation Markdown without entity escaping', () => {
    const text = [
      '## Report',
      '- [Finding](<https://x.com/example/status/1>)',
      '',
      '| Item | Result |',
      '| --- | --- |',
      '| Link | **Found** |',
    ].join('\n');

    expect(
      buildCustomAutomationSlackMessage({
        automationId: 'automation-1',
        automationName: 'Weekly scan',
        text,
      }).blocks,
    ).toContainEqual({ type: 'markdown', text });
  });

  it('bounds custom automation settings labels for Slack', () => {
    const automationName = 'A'.repeat(100);

    expect(
      buildCustomAutomationSlackMessage({
        automationId: 'automation-1',
        automationName,
        text: 'Finished.',
      }).blocks,
    ).toContainEqual(
      expect.objectContaining({
        block_id: 'roomote_automation_result_settings',
        accessory: expect.objectContaining({
          action_id: 'late_bound_automation_configure',
          accessibility_label: `Configure ${'A'.repeat(65)}`,
          url: 'https://app.example.com/automations#custom-automation-automation-1',
        }),
      }),
    );
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
    const message = buildAutomationRootSummaryMessage({
      summaryText: '  - Do the important thing  ',
      actionFooterText: '  React on a thread item to start it.  ',
      automationSettingsHash: 'suggest-ideas',
    });
    expect(message.text).toBe(
      '- Do the important thing\n\nReact on a thread item to start it.',
    );
    expect(message.blocks[0]).toMatchObject({
      type: 'container',
      title: { text: 'Suggest Ideas' },
      child_blocks: [
        expect.objectContaining({
          block_id: 'roomote_automation_result_settings',
        }),
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '- Do the important thing\n\nReact on a thread item to start it.',
          },
        },
      ],
    });
  });

  it('always skips historical thread feedback debug snippets', async () => {
    const warn = vi.fn();

    await expect(
      shouldPostHistoricalThreadFeedbackDebugSnippet({
        userId: 'user-1',
        logPrefix: '[manager-slack]',
        warn,
      }),
    ).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('degradeSlackMrkdwnToMarkdown', () => {
  it('converts mrkdwn links and bold to standard markdown', () => {
    expect(
      degradeSlackMrkdwnToMarkdown(
        '*Shipped today*\n- Fix bug <https://github.com/acme/app/pull/1|#1>\nSee <https://app.example.com/automations|settings>.',
      ),
    ).toBe(
      '**Shipped today**\n- Fix bug [#1](https://github.com/acme/app/pull/1)\nSee [settings](https://app.example.com/automations).',
    );
  });

  it('leaves italic, double-asterisk bold, and plain text unchanged', () => {
    expect(degradeSlackMrkdwnToMarkdown('_quiet_ **loud** plain')).toBe(
      '_quiet_ **loud** plain',
    );
  });
});
