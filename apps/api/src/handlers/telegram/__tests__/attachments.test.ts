const {
  describeVideoAttachmentMock,
  downloadFileMock,
  transcribeAudioAttachmentMock,
} = vi.hoisted(() => ({
  describeVideoAttachmentMock: vi.fn(),
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
  describeVideoAttachment: describeVideoAttachmentMock,
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

describe('attachTelegramMediaToQueuedMessage video', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    downloadFileMock.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      filePath: 'video.mp4',
      contentType: 'video/mp4',
    });
    describeVideoAttachmentMock.mockResolvedValue(
      'The recording shows an error.',
    );
  });

  it.each([
    {
      field: 'video',
      media: {
        file_id: 'video-file',
        file_unique_id: 'video-unique',
        width: 1280,
        height: 720,
        duration: 3,
        file_name: 'repro.mp4',
        mime_type: 'video/mp4',
      },
      filename: 'repro.mp4',
    },
    {
      field: 'video_note',
      media: {
        file_id: 'video-note-file',
        file_unique_id: 'video-note-unique',
        length: 384,
        duration: 3,
      },
      filename: 'video-note.mp4',
    },
  ])(
    'downloads and describes a native Telegram $field',
    async ({ field, media, filename }) => {
      const result = await attachTelegramMediaToQueuedMessage({
        message: {
          message_id: 2,
          chat: { id: 3, type: 'private' },
          [field]: media,
        },
        queuedMessage: { ...queuedMessage, text: 'Review this recording' },
        botToken: 'secret-token',
      });

      expect(downloadFileMock).toHaveBeenCalledWith(
        media.file_id,
        20 * 1024 * 1024,
      );
      expect(describeVideoAttachmentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          mimeType: 'video/mp4',
          userId: 'user-1',
          userTextContext: 'Review this recording',
        }),
      );
      expect(result.attachmentTexts).toEqual([
        `Video attachment description: ${filename}\nThe recording shows an error.`,
      ]);
    },
  );

  it('keeps a native video actionable when it cannot be downloaded', async () => {
    const result = await attachTelegramMediaToQueuedMessage({
      message: {
        message_id: 2,
        chat: { id: 3, type: 'private' },
        video_note: {
          file_id: 'video-note-file',
          file_unique_id: 'video-note-unique',
          length: 384,
          duration: 3,
        },
      },
      queuedMessage,
    });

    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(result.text).toContain('video-note.mp4 could not be downloaded');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });
});
