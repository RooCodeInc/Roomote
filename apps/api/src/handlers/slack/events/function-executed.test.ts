const {
  completeFunctionErrorMock,
  completeFunctionSuccessMock,
  getSlackAutomationLaunchIdentityMock,
  redisGetMock,
  redisSetMock,
  showManualPickerForAutoRouteFallbackMock,
  startAutoRoutedSlackTaskMock,
} = vi.hoisted(() => ({
  completeFunctionErrorMock: vi.fn(),
  completeFunctionSuccessMock: vi.fn(),
  getSlackAutomationLaunchIdentityMock: vi.fn(),
  redisGetMock: vi.fn(),
  redisSetMock: vi.fn(),
  showManualPickerForAutoRouteFallbackMock: vi.fn(),
  startAutoRoutedSlackTaskMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: redisGetMock,
    set: redisSetMock,
  }),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(function SlackNotifier() {
    return {
      completeFunctionError: completeFunctionErrorMock,
      completeFunctionSuccess: completeFunctionSuccessMock,
    };
  }),
  startAutoRoutedSlackTask: startAutoRoutedSlackTaskMock,
}));

vi.mock('../helpers/launch-identity.js', () => ({
  getSlackAutomationLaunchIdentity: getSlackAutomationLaunchIdentityMock,
}));

vi.mock('./auto-route-fallback.js', () => ({
  showManualPickerForAutoRouteFallback:
    showManualPickerForAutoRouteFallbackMock,
}));

describe('function-executed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisGetMock.mockResolvedValue(null);
    redisSetMock.mockResolvedValue('OK');
    completeFunctionErrorMock.mockResolvedValue(true);
    getSlackAutomationLaunchIdentityMock.mockResolvedValue({
      launchUserId: 'user_123',
      slackUserId: 'U123',
    });
    showManualPickerForAutoRouteFallbackMock.mockResolvedValue(false);
    startAutoRoutedSlackTaskMock.mockResolvedValue({
      status: 'not_started',
      code: 'routing_fallback',
      threadId: '111.000',
      message: 'Slack auto-routing needs manual environment selection.',
    });
  });

  it('shows the manual picker for workflow routing fallback when a thread is available', async () => {
    showManualPickerForAutoRouteFallbackMock.mockResolvedValueOnce(true);

    const { processSlackWorkflowFunctionExecuted } =
      await import('./function-executed.js');

    await processSlackWorkflowFunctionExecuted({
      functionEvent: {
        type: 'function_executed',
        function_execution_id: 'Fn123',
        bot_access_token: 'xoxb-workflow',
        function: { callback_id: 'start_roomote_task' },
        inputs: {
          prompt: 'Investigate router behavior',
          channel_id: 'C123',
          message_ts: '111.000',
          prompt_author_id: 'U123',
        },
      },
      context: {
        slackInstallation: {
          botUserId: 'B123',
          teamId: 'T123',
          teamDomain: 'acme-team',
        },
        slack: {} as never,
        teamId: 'T123',
      } as never,
    });

    expect(showManualPickerForAutoRouteFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ code: 'routing_fallback' }),
        event: expect.objectContaining({
          channel: 'C123',
          user: 'U123',
          text: 'Investigate router behavior',
          ts: '111.000',
          thread_ts: '111.000',
        }),
        userMapping: { userId: 'user_123' },
      }),
    );
    expect(completeFunctionErrorMock).toHaveBeenCalledWith({
      functionExecutionId: 'Fn123',
      error: 'Choose an environment in the Slack thread to continue.',
    });
  });

  it('does not surface routing fallback text when workflow has no thread for the picker', async () => {
    const { processSlackWorkflowFunctionExecuted } =
      await import('./function-executed.js');

    await processSlackWorkflowFunctionExecuted({
      functionEvent: {
        type: 'function_executed',
        function_execution_id: 'Fn123',
        bot_access_token: 'xoxb-workflow',
        function: { callback_id: 'start_roomote_task' },
        inputs: {
          prompt: 'Investigate router behavior',
          channel_id: 'C123',
          prompt_author_id: 'U123',
        },
      },
      context: {
        slackInstallation: {
          botUserId: 'B123',
          teamId: 'T123',
          teamDomain: 'acme-team',
        },
        slack: {} as never,
        teamId: 'T123',
      } as never,
    });

    expect(showManualPickerForAutoRouteFallbackMock).not.toHaveBeenCalled();
    expect(completeFunctionErrorMock).toHaveBeenCalledWith({
      functionExecutionId: 'Fn123',
      error:
        'Slack workflow auto-routing needs a thread so Roomote can show the environment picker.',
    });
  });
});
