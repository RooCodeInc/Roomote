const { getConfiguredRouterDebugSlackChannelIdMock } = vi.hoisted(() => ({
  getConfiguredRouterDebugSlackChannelIdMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => {
  return {
    getConfiguredRouterDebugSlackChannelId:
      getConfiguredRouterDebugSlackChannelIdMock,
  };
});

import { postChannelAutoStartRoutingDebug } from './channel-auto-start-routing-debug.js';

describe('postChannelAutoStartRoutingDebug', () => {
  beforeEach(() => {
    getConfiguredRouterDebugSlackChannelIdMock.mockResolvedValue('CDEBUG');
  });

  it('posts the launch decision reason to the routing debug channel', async () => {
    const isAppInChannel = vi.fn().mockResolvedValue(true);
    const postMessage = vi.fn().mockResolvedValue('123.456');

    await postChannelAutoStartRoutingDebug({
      slack: { isAppInChannel, postMessage },
      sourceChannelId: 'CALERTS',
      sourceChannelName: 'alerts',
      threadId: '111.000',
      messageText: 'Elevated 431 Errors. Status: Identified.',
      launchMode: 'always_start',
      llmDecision: 'launch',
      llmReason: 'Provider outage matches the criteria.',
      taskOutcome: 'started',
    });

    expect(isAppInChannel).toHaveBeenCalledWith('CDEBUG');
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'CDEBUG',
        text: expect.stringContaining(
          'llm_reason: Provider outage matches the criteria.',
        ),
      }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('task_outcome: started'),
      }),
    );
  });

  it('skips posting when the current org app is not in the debug channel', async () => {
    const isAppInChannel = vi.fn().mockResolvedValue(false);
    const postMessage = vi.fn();

    await postChannelAutoStartRoutingDebug({
      slack: { isAppInChannel, postMessage },
      sourceChannelId: 'CALERTS',
      threadId: '111.000',
      messageText: 'Recovered automatically after one minute.',
      launchMode: 'always_start',
      llmDecision: 'skip',
      llmReason: 'Resolved updates never launch.',
      taskOutcome: 'skipped_before_start',
      taskOutcomeDetails: 'Launch gate stopped before task startup.',
    });

    expect(isAppInChannel).toHaveBeenCalledWith('CDEBUG');
    expect(postMessage).not.toHaveBeenCalled();
  });
});
