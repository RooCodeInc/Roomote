const { postRouterDebugTextMock } = vi.hoisted(() => ({
  postRouterDebugTextMock: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  postRouterDebugText: postRouterDebugTextMock,
}));

import { postChannelAutoStartRoutingDebug } from './channel-auto-start-routing-debug.js';

describe('postChannelAutoStartRoutingDebug', () => {
  beforeEach(() => {
    postRouterDebugTextMock.mockResolvedValue(undefined);
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

    expect(postRouterDebugTextMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'llm_reason: Provider outage matches the criteria.',
      ),
    );
    expect(postRouterDebugTextMock).toHaveBeenCalledWith(
      expect.stringContaining('task_outcome: started'),
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

    expect(postRouterDebugTextMock).toHaveBeenCalled();
  });
});
