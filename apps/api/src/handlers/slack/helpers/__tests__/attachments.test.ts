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
  formatAudioAttachmentWarning: vi.fn(
    (filename: string, reason: string) =>
      `[Audio attachment "${filename}" ${reason}.]`,
  ),
  formatAudioTranscriptionResult: vi.fn(
    (
      filename: string,
      result:
        | { status: 'transcribed'; transcript: string }
        | { status: 'audio_video_disabled' }
        | { status: 'unsupported_model' }
        | { status: 'oversized' }
        | { status: 'failed' },
    ) =>
      result.status === 'transcribed'
        ? `Audio attachment transcript ("${filename}"):\n${result.transcript}`
        : result.status === 'unsupported_model'
          ? `[Audio attachment "${filename}" could not be transcribed because the Vision model does not support audio input. Choose an audio-capable model under Settings > Models > Vision model.]`
          : result.status === 'audio_video_disabled'
            ? `[Audio attachment "${filename}" could not be transcribed. Audio and video support is off. To enable it, turn on "Also use for audio and video" under "Vision model" in Settings > Models and pick a model that supports audio and video input (for example Gemini).]`
            : result.status === 'oversized'
              ? `[Audio attachment "${filename}" could not be transcribed because it exceeds the 20 MiB limit.]`
              : `[Audio attachment "${filename}" could not be transcribed.]`,
  ),
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

  it('keeps an audio-only task actionable when the Vision model lacks audio support', async () => {
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
      '[Audio attachment "Audio Clip.m4a" could not be transcribed because the Vision model does not support audio input. Choose an audio-capable model under Settings > Models > Vision model.]',
    ]);
  });

  it('passes the opt-in guidance into the Slack chat message when audio is off', async () => {
    transcribeAudioAttachmentMock.mockResolvedValue({
      status: 'audio_video_disabled',
    });
    const result = await processSlackAttachments({
      slack: {
        downloadSlackFile: vi.fn().mockResolvedValue(Buffer.from('audio')),
        processSlackFiles: vi.fn().mockResolvedValue([]),
      } as never,
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

    expect(result.attachmentTexts[0]).toContain(
      'Audio and video support is off.',
    );
    expect(result.attachmentTexts[0]).toContain('Also use for audio and video');
    expect(result.attachmentTexts[0]).toContain('Settings > Models');
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
