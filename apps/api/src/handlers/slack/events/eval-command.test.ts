const {
  postSlackThreadMarkdownMessageMock,
  showManualPickerForAutoRouteFallbackMock,
  startAutoRoutedSlackTaskMock,
} = vi.hoisted(() => ({
  postSlackThreadMarkdownMessageMock: vi.fn(),
  showManualPickerForAutoRouteFallbackMock: vi.fn(),
  startAutoRoutedSlackTaskMock: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  startAutoRoutedSlackTask: startAutoRoutedSlackTaskMock,
}));

vi.mock('../helpers/attachments.js', () => ({
  processSlackAttachments: vi.fn().mockResolvedValue({
    images: [],
    attachmentTexts: [],
    videoDescriptions: [],
  }),
}));

vi.mock('../helpers/thread-posting.js', () => ({
  postSlackThreadMarkdownMessage: postSlackThreadMarkdownMessageMock,
}));

vi.mock('./auto-route-fallback.js', () => ({
  showManualPickerForAutoRouteFallback:
    showManualPickerForAutoRouteFallbackMock,
}));

describe('eval-command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startAutoRoutedSlackTaskMock.mockResolvedValue({
      status: 'started',
      threadId: '111.000',
      cloudJobId: 1,
      taskId: 'task_123',
    });
    showManualPickerForAutoRouteFallbackMock.mockResolvedValue(false);
    postSlackThreadMarkdownMessageMock.mockResolvedValue(true);
  });

  it('recognizes app-mention and bare !eval invocations', async () => {
    const { isBareEvalCommandInvocation, isEvalCommandInvocation } =
      await import('./eval-command.js');

    expect(
      isEvalCommandInvocation(
        '<@BOT> !eval --branch feat/test Investigate bug',
      ),
    ).toBe(true);
    expect(
      isBareEvalCommandInvocation('!eval --branch feat/test Investigate bug'),
    ).toBe(true);
    expect(
      isEvalCommandInvocation('<@BOT> please run !eval Investigate bug'),
    ).toBe(false);
  }, 15000);

  it('posts usage guidance when !eval is missing a task prompt', async () => {
    const { processEvalCommandMessage } = await import('./eval-command.js');
    const slack = {
      addReaction: vi.fn(),
    };

    await processEvalCommandMessage({
      event: {
        type: 'app_mention',
        channel: 'C123',
        text: '<@BOT> !eval --branch feat/test',
        ts: '111.000',
        user: 'U123',
      },
      slackInstallation: {
        botUserId: 'B123',
        teamId: 'T123',
        teamDomain: 'acme-team',
      },
      slack: slack as never,
      userId: 'user_123',
      teamId: 'T123',
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    });

    expect(postSlackThreadMarkdownMessageMock).toHaveBeenCalledTimes(1);
    expect(
      postSlackThreadMarkdownMessageMock.mock.calls[0]?.[0]?.text,
    ).toContain('Use `!eval [--branch <branch> | --sha <sha>]');
    expect(slack.addReaction).not.toHaveBeenCalled();
    expect(startAutoRoutedSlackTaskMock).not.toHaveBeenCalled();
  });

  it('launches a regular Slack task with task parameter overrides', async () => {
    const { processEvalCommandMessage } = await import('./eval-command.js');
    const slack = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    await processEvalCommandMessage({
      event: {
        type: 'app_mention',
        channel: 'C123',
        text: '<@BOT> !eval --branch feat/evals --model provider-id/model-id Investigate the router behavior',
        ts: '111.000',
        user: 'U123',
      },
      slackInstallation: {
        botUserId: 'B123',
        teamId: 'T123',
        teamDomain: 'acme-team',
      },
      slack: slack as never,
      userId: 'user_123',
      teamId: 'T123',
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    });

    expect(slack.addReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '111.000',
      name: 'eyes',
    });
    expect(startAutoRoutedSlackTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Investigate the router behavior',
        branch: 'feat/evals',
        model: 'provider-id/model-id',
      }),
    );
    expect(postSlackThreadMarkdownMessageMock).not.toHaveBeenCalled();
  });

  it('forwards an explicit --harness to the routed task launch', async () => {
    const { processEvalCommandMessage } = await import('./eval-command.js');
    const slack = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    await processEvalCommandMessage({
      event: {
        type: 'app_mention',
        channel: 'C123',
        text: '<@BOT> !eval --harness opencode-server --model provider-id/model-id Investigate the router behavior',
        ts: '111.000',
        user: 'U123',
      },
      slackInstallation: {
        botUserId: 'B123',
        teamId: 'T123',
        teamDomain: 'acme-team',
      },
      slack: slack as never,
      userId: 'user_123',
      teamId: 'T123',
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    });

    expect(startAutoRoutedSlackTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Investigate the router behavior',
        harness: 'opencode-server',
        model: 'provider-id/model-id',
      }),
    );
    expect(postSlackThreadMarkdownMessageMock).not.toHaveBeenCalled();
  });

  it('shows the manual picker instead of posting a routing fallback message', async () => {
    startAutoRoutedSlackTaskMock.mockResolvedValueOnce({
      status: 'not_started',
      code: 'routing_fallback',
      threadId: '111.000',
      message: 'Slack auto-routing needs manual environment selection.',
    });
    showManualPickerForAutoRouteFallbackMock.mockResolvedValueOnce(true);

    const { processEvalCommandMessage } = await import('./eval-command.js');
    const slack = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    const event = {
      type: 'app_mention',
      channel: 'C123',
      text: '<@BOT> !eval Investigate the router behavior',
      ts: '111.000',
      user: 'U123',
    };

    await processEvalCommandMessage({
      event,
      slackInstallation: {
        botUserId: 'B123',
        teamId: 'T123',
        teamDomain: 'acme-team',
      },
      slack: slack as never,
      userId: 'user_123',
      teamId: 'T123',
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    });

    expect(showManualPickerForAutoRouteFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ code: 'routing_fallback' }),
        event,
        userMapping: { userId: 'user_123' },
        processingReactionName: 'eyes',
      }),
    );
    expect(postSlackThreadMarkdownMessageMock).not.toHaveBeenCalled();
  });

  it('rejects an inconsistent --harness/--model pairing with a usage error', async () => {
    const { processEvalCommandMessage } = await import('./eval-command.js');
    const slack = {
      addReaction: vi.fn().mockResolvedValue(undefined),
    };

    await processEvalCommandMessage({
      event: {
        type: 'app_mention',
        channel: 'C123',
        text: '<@BOT> !eval --harness opencode-server --model gpt-5.5 Investigate the router behavior',
        ts: '111.000',
        user: 'U123',
      },
      slackInstallation: {
        botUserId: 'B123',
        teamId: 'T123',
        teamDomain: 'acme-team',
      },
      slack: slack as never,
      userId: 'user_123',
      teamId: 'T123',
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    });

    expect(startAutoRoutedSlackTaskMock).not.toHaveBeenCalled();
    expect(slack.addReaction).not.toHaveBeenCalled();
    expect(
      postSlackThreadMarkdownMessageMock.mock.calls[0]?.[0]?.text,
    ).toContain('provider/model format');
  });

  it('rejects an unknown --harness value with a usage error', async () => {
    const { processEvalCommandMessage } = await import('./eval-command.js');
    const slack = {
      addReaction: vi.fn().mockResolvedValue(undefined),
    };

    await processEvalCommandMessage({
      event: {
        type: 'app_mention',
        channel: 'C123',
        text: '<@BOT> !eval --harness custom-harness Investigate the router behavior',
        ts: '111.000',
        user: 'U123',
      },
      slackInstallation: {
        botUserId: 'B123',
        teamId: 'T123',
        teamDomain: 'acme-team',
      },
      slack: slack as never,
      userId: 'user_123',
      teamId: 'T123',
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    });

    expect(startAutoRoutedSlackTaskMock).not.toHaveBeenCalled();
    expect(
      postSlackThreadMarkdownMessageMock.mock.calls[0]?.[0]?.text,
    ).toContain('Unknown harness');
  });
});
