const { showTaskConfigurationMock } = vi.hoisted(() => ({
  showTaskConfigurationMock: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  showTaskConfiguration: showTaskConfigurationMock,
  SLACK_ROUTING_UNAVAILABLE_NOTICE: '⚠️ routing unavailable notice',
}));

describe('auto-route-fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showTaskConfigurationMock.mockResolvedValue({
      routingUsed: false,
      threadId: '111.000',
    });
  });

  it('shows the manual picker without re-running routing when auto-routing cannot resolve a launch target', async () => {
    const { showManualPickerForAutoRouteFallback } =
      await import('./auto-route-fallback.js');

    const shown = await showManualPickerForAutoRouteFallback({
      result: {
        status: 'not_started',
        code: 'routing_fallback',
        threadId: '111.000',
        message: 'Slack auto-routing needs manual environment selection.',
      },
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.000',
      },
      slackInstallation: { teamId: 'T123' } as never,
      userMapping: { userId: 'user_123' } as never,
      slack: {} as never,
      processedImages: ['data:image/png;base64,abc'],
      processedAttachmentTexts: ['attached context'],
      processedVideoDescriptions: ['save button fails'],
      processingReactionName: 'eyes',
    });

    expect(shown).toBe(true);
    expect(showTaskConfigurationMock).toHaveBeenCalledWith({
      event: expect.objectContaining({
        processedImages: ['data:image/png;base64,abc'],
        processedAttachmentTexts: ['attached context'],
        processedVideoDescriptions: ['save button fails'],
      }),
      slackInstallation: { teamId: 'T123' },
      userMapping: { userId: 'user_123' },
      slack: {},
      skipRouting: true,
      skipMcpSetupSuggestion: true,
      processingReactionName: 'eyes',
    });
  });

  it('passes the routing-unavailable warning through when routing failed with an exception', async () => {
    const { showManualPickerForAutoRouteFallback } =
      await import('./auto-route-fallback.js');

    const shown = await showManualPickerForAutoRouteFallback({
      result: {
        status: 'not_started',
        code: 'routing_fallback',
        threadId: '111.000',
        message: 'Slack auto-routing needs manual environment selection.',
        routingFallback: {
          cause: 'exception',
          reason:
            'OpenCode structured prompt failed: APIError: Key limit exceeded',
        },
      },
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.000',
      },
      slackInstallation: { teamId: 'T123' } as never,
      userMapping: { userId: 'user_123' } as never,
      slack: {} as never,
    });

    expect(shown).toBe(true);
    expect(showTaskConfigurationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        skipRouting: true,
        routingFailureNoticeText: '⚠️ routing unavailable notice',
      }),
    );
  });

  it('does not pass a warning for model-decided routing fallbacks', async () => {
    const { showManualPickerForAutoRouteFallback } =
      await import('./auto-route-fallback.js');

    const shown = await showManualPickerForAutoRouteFallback({
      result: {
        status: 'not_started',
        code: 'routing_fallback',
        threadId: '111.000',
        message: 'Slack auto-routing needs manual environment selection.',
        routingFallback: {
          cause: 'model_decision',
          reason: 'Could not map routed environment.',
        },
      },
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.000',
      },
      slackInstallation: { teamId: 'T123' } as never,
      userMapping: { userId: 'user_123' } as never,
      slack: {} as never,
    });

    expect(shown).toBe(true);
    expect(showTaskConfigurationMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        routingFailureNoticeText: expect.anything(),
      }),
    );
  });

  it('does not show the picker for non-routing failures or missing user mappings', async () => {
    const { showManualPickerForAutoRouteFallback } =
      await import('./auto-route-fallback.js');
    const event = {
      type: 'app_mention',
      channel: 'C123',
      user: 'U123',
      text: '<@BOT> investigate this',
      ts: '111.000',
    };

    await expect(
      showManualPickerForAutoRouteFallback({
        result: {
          status: 'not_started',
          code: 'source_message_inaccessible',
          threadId: '111.000',
          message: 'Roomote could not access the target Slack thread.',
        },
        event,
        slackInstallation: { teamId: 'T123' } as never,
        userMapping: { userId: 'user_123' } as never,
        slack: {} as never,
      }),
    ).resolves.toBe(false);

    await expect(
      showManualPickerForAutoRouteFallback({
        result: {
          status: 'not_started',
          code: 'routing_fallback',
          threadId: '111.000',
          message: 'Slack auto-routing needs manual environment selection.',
        },
        event,
        slackInstallation: { teamId: 'T123' } as never,
        userMapping: null,
        slack: {} as never,
      }),
    ).resolves.toBe(false);

    expect(showTaskConfigurationMock).not.toHaveBeenCalled();
  });
});
