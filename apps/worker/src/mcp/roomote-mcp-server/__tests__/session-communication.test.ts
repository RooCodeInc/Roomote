const mocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('../tasks-api-client.js', () => ({
  getFastSessionMessages: mocks.getMessages,
  sendMessageToFastSession: mocks.sendMessage,
}));

import {
  handleGetFastSessionMessages,
  handleSendFastSessionMessage,
} from '../session-communication.js';

const config = {
  platformApiUrl: 'https://roomote.example.com',
  token: 'token',
};

describe('Fast session MCP communication', () => {
  beforeEach(() => vi.clearAllMocks());

  it('formats visible session messages', async () => {
    mocks.getMessages.mockResolvedValue({
      returned: 1,
      messages: [
        {
          id: 'message-1',
          sessionId: 'session-1',
          ts: 1,
          eventType: 'roomote_runtime.assistant_message',
          role: 'assistant',
          text: 'Session response',
          images: [],
          metadata: null,
        },
      ],
    });

    const result = await handleGetFastSessionMessages(
      { sessionId: 'session-1', limit: 10 },
      config,
    );
    expect(result.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('Session response'),
      }),
    ]);
    expect(mocks.getMessages).toHaveBeenCalledWith(config, 'session-1', {
      limit: 10,
    });
  });

  it('sends a Fast session follow-up', async () => {
    mocks.sendMessage.mockResolvedValue({ success: true });
    const result = await handleSendFastSessionMessage(
      { sessionId: 'session-1', message: 'Follow up' },
      config,
    );
    expect(result.isError).not.toBe(true);
    expect(mocks.sendMessage).toHaveBeenCalledWith(config, 'session-1', {
      message: 'Follow up',
    });
  });
});
