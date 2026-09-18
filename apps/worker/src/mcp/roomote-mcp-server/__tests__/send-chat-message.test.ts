const { sendChatMessageMock } = vi.hoisted(() => ({
  sendChatMessageMock: vi.fn(),
}));

vi.mock('../chat-api-client.js', () => ({
  sendChatMessage: sendChatMessageMock,
}));

import { handleSendChatMessage } from '../send-chat-message.js';

describe('handleSendChatMessage', () => {
  it('forwards the exact destination and message', async () => {
    sendChatMessageMock.mockResolvedValue({
      delivered: true,
      destination: 'telegram:me',
    });

    const result = await handleSendChatMessage(
      { destination: 'telegram:me', message: 'Exact message.' },
      { platformApiUrl: 'https://platform.example.com', token: 'token' },
    );

    expect(sendChatMessageMock).toHaveBeenCalledWith(
      { platformApiUrl: 'https://platform.example.com', token: 'token' },
      { destination: 'telegram:me', message: 'Exact message.' },
    );
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: JSON.stringify({
        success: true,
        delivered: true,
        destination: 'telegram:me',
      }),
    });
  });
});
