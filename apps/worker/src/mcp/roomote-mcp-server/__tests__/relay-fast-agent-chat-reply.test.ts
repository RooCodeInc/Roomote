const mocks = vi.hoisted(() => ({ createClient: vi.fn(), relay: vi.fn() }));

vi.mock('@roomote/sdk/client', () => ({
  createClient: mocks.createClient,
}));

import { handleRelayFastAgentChatReply } from '../relay-fast-agent-chat-reply';

describe('handleRelayFastAgentChatReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.relay.mockResolvedValue({ relayed: true });
    mocks.createClient.mockReturnValue({
      taskRuns: {
        relayFastAgentChildChatReply: { mutate: mocks.relay },
      },
    });
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
        authBypassHeaderName: 'x-roomote-bypass',
        authBypassHeaderValue: 'bypass-token',
      },
    );

    expect(mocks.createClient).toHaveBeenCalledWith({
      url: 'https://api.roomote.example',
      headers: expect.any(Function),
    });
    const clientOptions = mocks.createClient.mock.calls[0]?.[0] as {
      headers: () => Record<string, string>;
    };
    expect(clientOptions.headers()).toEqual({
      Authorization: 'Bearer token',
      'x-roomote-bypass': 'bypass-token',
    });
    expect(mocks.relay).toHaveBeenCalledWith({
      runId: 42,
      taskId: 'task-1',
      deliverySignature: expect.stringMatching(/^[a-f0-9]{64}$/),
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

  it('reuses the pending delivery key after a lost relay response', async () => {
    mocks.relay
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ relayed: true });
    const input = {
      runId: 42,
      taskId: 'task-1',
      purpose: 'progress' as const,
      message: 'The targeted tests are running.',
    };

    await handleRelayFastAgentChatReply(input, {
      token: 'token',
      platformApiUrl: 'https://api.roomote.example',
    });
    await handleRelayFastAgentChatReply(input, {
      token: 'token',
      platformApiUrl: 'https://api.roomote.example',
    });

    expect(mocks.relay).toHaveBeenCalledTimes(2);
    expect(mocks.relay.mock.calls[0]?.[0]?.deliverySignature).toBe(
      mocks.relay.mock.calls[1]?.[0]?.deliverySignature,
    );
  });
});
