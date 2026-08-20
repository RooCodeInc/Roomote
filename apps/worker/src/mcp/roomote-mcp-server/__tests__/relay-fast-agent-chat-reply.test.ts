const mocks = vi.hoisted(() => ({ relay: vi.fn() }));

vi.mock('@roomote/sdk/client', () => ({
  sdk: { taskRuns: { relayFastAgentChildChatReply: mocks.relay } },
}));

import { handleRelayFastAgentChatReply } from '../relay-fast-agent-chat-reply';

describe('handleRelayFastAgentChatReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.relay.mockResolvedValue({ relayed: true });
  });

  it('relays lifecycle text without posting to a communication provider', async () => {
    const result = await handleRelayFastAgentChatReply(
      {
        runId: 42,
        taskId: 'task-1',
        purpose: 'progress',
        message: 'The implementation is ready for validation.',
      },
      {
        token: 'token',
        platformApiUrl: 'https://api.roomote.example',
      },
    );

    expect(mocks.relay).toHaveBeenCalledWith({
      runId: 42,
      taskId: 'task-1',
      messageId: expect.any(String),
      purpose: 'progress',
      message: 'The implementation is ready for validation.',
    });
    expect(result.content[0]?.text).toContain('"relayed":true');
    expect(result.content[0]?.text).toContain('"relayId":');
  });

  it('does not mark an update successful when the Fast parent is unavailable', async () => {
    mocks.relay.mockResolvedValueOnce({ relayed: false });

    const result = await handleRelayFastAgentChatReply(
      {
        runId: 42,
        taskId: 'task-1',
        purpose: 'progress',
        message: 'Still working.',
      },
      {
        token: 'token',
        platformApiUrl: 'https://api.roomote.example',
      },
    );

    expect(result.content[0]?.text).toContain('"success":false');
  });
});
