const { mockPostMessage } = vi.hoisted(() => ({
  mockPostMessage: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  postRouterDebugText: mockPostMessage,
}));

import { postScheduledTriageRoutingDebug } from '../triage-routing-debug';

describe('postScheduledTriageRoutingDebug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessage.mockResolvedValue(undefined);
  });

  it('posts when the Slack app is in the debug channel', async () => {
    await postScheduledTriageRoutingDebug({
      automationKey: 'sentry_triage',
      slackBotToken: 'xoxb-test',
      manualTrigger: false,
      outcome: 'queued',
      taskSlackChannelId: 'C123MANAGER',
    });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.stringContaining('task_slack_channel: C123MANAGER'),
    );
  });

  it('skips posting when the Slack app is not in the debug channel', async () => {
    await postScheduledTriageRoutingDebug({
      automationKey: 'sentry_triage',
      slackBotToken: 'xoxb-test',
      manualTrigger: false,
      outcome: 'queued',
      taskSlackChannelId: 'C123MANAGER',
    });

    expect(mockPostMessage).toHaveBeenCalled();
  });
});
