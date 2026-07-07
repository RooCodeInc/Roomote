const { showTaskConfigurationMock } = vi.hoisted(() => ({
  showTaskConfigurationMock: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  showTaskConfiguration: showTaskConfigurationMock,
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
      skipMcpSetupInterrupt: true,
      processingReactionName: 'eyes',
    });
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
