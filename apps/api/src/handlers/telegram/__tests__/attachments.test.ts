const { downloadFileMock, transcribeAudioAttachmentMock } = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
  transcribeAudioAttachmentMock: vi.fn(),
}));

vi.mock('@roomote/communication/telegram-provider', () => ({
  TelegramCommunicationProvider: class {
    downloadFile = downloadFileMock;
  },
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  transcribeAudioAttachment: transcribeAudioAttachmentMock,
}));

import { attachTelegramMediaToQueuedMessage } from '../attachments.js';

const queuedMessage = {
  provider: 'telegram' as const,
  text: 'Audio attachment: voice message',
  user: 'Ada',
  userId: 'user-1',
  ts: '2',
  channel: '3',
};

describe('attachTelegramMediaToQueuedMessage audio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('downloads and transcribes a native voice note', async () => {
    downloadFileMock.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      filePath: 'voice.oga',
      contentType: 'audio/ogg',
    });
    transcribeAudioAttachmentMock.mockResolvedValue({
      status: 'transcribed',
      transcript: 'Run the tests.',
    });

    const result = await attachTelegramMediaToQueuedMessage({
      message: {
        message_id: 2,
        chat: { id: 3, type: 'private' },
        voice: {
          file_id: 'voice-file',
          file_unique_id: 'voice-unique',
          duration: 3,
          mime_type: 'audio/ogg',
        },
      },
      queuedMessage,
      botToken: 'secret-token',
    });

    expect(result.text).toContain('Run the tests.');
    expect(transcribeAudioAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', mimeType: 'audio/ogg' }),
    );
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('does not download oversized voice notes', async () => {
    const result = await attachTelegramMediaToQueuedMessage({
      message: {
        message_id: 2,
        chat: { id: 3, type: 'private' },
        voice: {
          file_id: 'voice-file',
          file_unique_id: 'voice-unique',
          duration: 3,
          mime_type: 'audio/ogg',
          file_size: 20 * 1024 * 1024 + 1,
        },
      },
      queuedMessage,
      botToken: 'secret-token',
    });

    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(result.text).toContain('20 MiB limit');
  });

  it('keeps audio-only input actionable for unsupported models', async () => {
    downloadFileMock.mockResolvedValue({
      bytes: Uint8Array.from([1]),
      filePath: 'voice.oga',
      contentType: 'audio/ogg',
    });
    transcribeAudioAttachmentMock.mockResolvedValue({
      status: 'unsupported_model',
    });

    const result = await attachTelegramMediaToQueuedMessage({
      message: {
        message_id: 2,
        chat: { id: 3, type: 'private' },
        voice: {
          file_id: 'voice-file',
          file_unique_id: 'voice-unique',
          duration: 3,
          mime_type: 'audio/ogg',
        },
      },
      queuedMessage,
      botToken: 'secret-token',
    });

    expect(result.text).toContain('no configured model supports audio input');
  });
});
