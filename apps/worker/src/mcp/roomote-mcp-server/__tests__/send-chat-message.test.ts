const { sendChatMessageMock, uploadSlackImagePathsMock } = vi.hoisted(() => ({
  sendChatMessageMock: vi.fn(),
  uploadSlackImagePathsMock: vi.fn(),
}));

vi.mock('../chat-api-client.js', () => ({
  sendChatMessage: sendChatMessageMock,
}));

vi.mock('../slack-post-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../slack-post-helpers.js')>()),
  uploadSlackImagePaths: uploadSlackImagePathsMock,
}));

import { handleSendChatMessage } from '../send-chat-message.js';

describe('handleSendChatMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadSlackImagePathsMock.mockResolvedValue({ uploadedArtifactIds: [] });
  });

  it('forwards the exact destination and message', async () => {
    sendChatMessageMock.mockResolvedValue({
      delivered: true,
      destination: 'telegram:me',
    });

    const result = await handleSendChatMessage(
      {
        taskId: 'task-1',
        destination: 'telegram:me',
        message: 'Exact message.',
      },
      {
        platformApiUrl: 'https://platform.example.com',
        token: 'token',
        workspacePath: '/workspace',
      },
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

  it('uploads image paths and forwards all artifact IDs', async () => {
    uploadSlackImagePathsMock.mockResolvedValue({
      uploadedArtifactIds: ['uploaded-1'],
    });
    sendChatMessageMock.mockResolvedValue({ channelId: 'C1' });

    await handleSendChatMessage(
      {
        taskId: 'task-1',
        destination: 'slack:T1:channel:C1',
        message: 'Proof attached.',
        imagePaths: ['/tmp/proof.png'],
        imageArtifactIds: ['existing-1'],
      },
      {
        platformApiUrl: 'https://platform.example.com',
        token: 'token',
        workspacePath: '/workspace',
      },
      { platformApiUrl: 'https://platform.example.com', token: 'token' },
    );

    expect(sendChatMessageMock).toHaveBeenCalledWith(expect.anything(), {
      destination: 'slack:T1:channel:C1',
      message: 'Proof attached.',
      imageArtifactIds: ['existing-1', 'uploaded-1'],
    });
  });
});
