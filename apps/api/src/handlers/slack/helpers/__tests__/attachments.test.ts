const { transcribeAudioAttachmentMock } = vi.hoisted(() => ({
  transcribeAudioAttachmentMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents', () => ({
  appendAttachmentTextsToPromptText: vi.fn(({ text }) => text),
  isRoomoteTextExtractableAttachment: vi.fn(() => false),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES: 20 * 1024 * 1024,
  VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES: 20 * 1024 * 1024,
  describeVideoAttachment: vi.fn(),
  extractPromptTextAttachments: vi.fn(() => ({
    attachmentTexts: [],
    warnings: [],
  })),
  isAudioTranscriptionSupportedMimeType: vi.fn(
    (mimeType: string) => mimeType === 'audio/mp4',
  ),
  isVideoAgentSupportedMimeType: vi.fn(() => false),
  transcribeAudioAttachment: transcribeAudioAttachmentMock,
}));

vi.mock('@roomote/slack', () => ({
  appendSlackVideoDescriptionsToText: vi.fn(({ text }) => text),
  collectAndExtractThreadAttachmentTexts: vi.fn(() => []),
}));

import { processSlackAttachments } from '../attachments';

describe('processSlackAttachments audio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('downloads and transcribes a Slack audio clip', async () => {
    const downloadSlackFile = vi.fn().mockResolvedValue(Buffer.from('audio'));
    const slack = {
      downloadSlackFile,
      processSlackFiles: vi.fn().mockResolvedValue([]),
    };
    transcribeAudioAttachmentMock.mockResolvedValue({
      status: 'transcribed',
      transcript: 'Please deploy the fix.',
    });

    const result = await processSlackAttachments({
      slack: slack as never,
      files: [
        {
          id: 'F-audio',
          name: 'Audio Clip.m4a',
          mimetype: 'audio/mp4',
          filetype: 'm4a',
          url_private: 'https://files.slack.test/audio',
          url_private_download: 'https://files.slack.test/audio/download',
          size: 76_457,
        },
      ],
      userTextContext: '',
      userId: 'user-1',
    });

    expect(downloadSlackFile).toHaveBeenCalledTimes(1);
    expect(transcribeAudioAttachmentMock).toHaveBeenCalledWith({
      audioBytes: Buffer.from('audio'),
      mimeType: 'audio/mp4',
      filename: 'Audio Clip.m4a',
      userId: 'user-1',
      userTextContext: '',
    });
    expect(result.attachmentTexts).toEqual([
      'Audio attachment transcript ("Audio Clip.m4a"):\nPlease deploy the fix.',
    ]);
  });

  it('keeps an audio-only task actionable when no model supports audio', async () => {
    const slack = {
      downloadSlackFile: vi.fn().mockResolvedValue(Buffer.from('audio')),
      processSlackFiles: vi.fn().mockResolvedValue([]),
    };
    transcribeAudioAttachmentMock.mockResolvedValue({
      status: 'unsupported_model',
    });

    const result = await processSlackAttachments({
      slack: slack as never,
      files: [
        {
          id: 'F-audio',
          name: 'Audio Clip.m4a',
          mimetype: 'audio/mp4',
          filetype: 'm4a',
          url_private: 'https://files.slack.test/audio',
          url_private_download: 'https://files.slack.test/audio/download',
          size: 76_457,
        },
      ],
    });

    expect(result.attachmentTexts).toEqual([
      '[Audio attachment "Audio Clip.m4a" could not be transcribed because no configured model supports audio input.]',
    ]);
  });

  it('warns without downloading oversized audio', async () => {
    const downloadSlackFile = vi.fn();
    const slack = {
      downloadSlackFile,
      processSlackFiles: vi.fn().mockResolvedValue([]),
    };

    const result = await processSlackAttachments({
      slack: slack as never,
      files: [
        {
          id: 'F-audio',
          name: 'Long recording.m4a',
          mimetype: 'audio/mp4',
          filetype: 'm4a',
          url_private: 'https://files.slack.test/audio',
          url_private_download: 'https://files.slack.test/audio/download',
          size: 20 * 1024 * 1024 + 1,
        },
      ],
    });

    expect(downloadSlackFile).not.toHaveBeenCalled();
    expect(transcribeAudioAttachmentMock).not.toHaveBeenCalled();
    expect(result.attachmentTexts).toEqual([
      '[Audio attachment "Long recording.m4a" could not be transcribed because it exceeds the 20 MiB limit.]',
    ]);
  });

  it('warns when an audio MIME type is unsupported', async () => {
    const downloadSlackFile = vi.fn();
    const slack = {
      downloadSlackFile,
      processSlackFiles: vi.fn().mockResolvedValue([]),
    };

    const result = await processSlackAttachments({
      slack: slack as never,
      files: [
        {
          id: 'F-audio',
          name: 'Recording.wma',
          mimetype: 'audio/x-ms-wma',
          filetype: 'wma',
          url_private: 'https://files.slack.test/audio',
          url_private_download: 'https://files.slack.test/audio/download',
          size: 76_457,
        },
      ],
    });

    expect(downloadSlackFile).not.toHaveBeenCalled();
    expect(result.attachmentTexts).toEqual([
      '[Audio attachment "Recording.wma" could not be transcribed because audio/x-ms-wma is not supported.]',
    ]);
  });

  it('warns when downloaded audio exceeds its reported size', async () => {
    const slack = {
      downloadSlackFile: vi.fn().mockResolvedValue(Buffer.from('audio')),
      processSlackFiles: vi.fn().mockResolvedValue([]),
    };
    transcribeAudioAttachmentMock.mockResolvedValue({ status: 'oversized' });

    const result = await processSlackAttachments({
      slack: slack as never,
      files: [
        {
          id: 'F-audio',
          name: 'Recording.m4a',
          mimetype: 'audio/mp4',
          filetype: 'm4a',
          url_private: 'https://files.slack.test/audio',
          url_private_download: 'https://files.slack.test/audio/download',
          size: 76_457,
        },
      ],
    });

    expect(result.attachmentTexts).toEqual([
      '[Audio attachment "Recording.m4a" could not be transcribed because it exceeds the 20 MiB limit.]',
    ]);
  });
});
