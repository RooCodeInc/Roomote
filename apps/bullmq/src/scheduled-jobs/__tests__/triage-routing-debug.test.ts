const {
  getConfiguredRouterDebugSlackChannelIdMock,
  mockIsAppInChannel,
  mockPostMessage,
} = vi.hoisted(() => ({
  getConfiguredRouterDebugSlackChannelIdMock: vi.fn(),
  mockIsAppInChannel: vi.fn(),
  mockPostMessage: vi.fn(),
}));

vi.mock('@roomote/db/server', () => {
  return {
    getConfiguredRouterDebugSlackChannelId:
      getConfiguredRouterDebugSlackChannelIdMock,
  };
});

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(function MockSlackNotifier() {
    return {
      isAppInChannel: mockIsAppInChannel,
      postMessage: mockPostMessage,
    };
  }),
}));

import { postScheduledTriageRoutingDebug } from '../triage-routing-debug';

describe('postScheduledTriageRoutingDebug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfiguredRouterDebugSlackChannelIdMock.mockResolvedValue('CDEBUG');
    mockIsAppInChannel.mockResolvedValue(true);
    mockPostMessage.mockResolvedValue('123.456');
  });

  it('posts when the Slack app is in the debug channel', async () => {
    await postScheduledTriageRoutingDebug({
      automationKey: 'sentry_triage',
      slackBotToken: 'xoxb-test',
      manualTrigger: false,
      outcome: 'queued',
      taskSlackChannelId: 'C123MANAGER',
    });

    expect(mockIsAppInChannel).toHaveBeenCalledWith('CDEBUG');
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'CDEBUG',
        text: expect.stringContaining('task_slack_channel: C123MANAGER'),
      }),
    );
  });

  it('skips posting when the Slack app is not in the debug channel', async () => {
    mockIsAppInChannel.mockResolvedValue(false);

    await postScheduledTriageRoutingDebug({
      automationKey: 'sentry_triage',
      slackBotToken: 'xoxb-test',
      manualTrigger: false,
      outcome: 'queued',
      taskSlackChannelId: 'C123MANAGER',
    });

    expect(mockIsAppInChannel).toHaveBeenCalledWith('CDEBUG');
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});
