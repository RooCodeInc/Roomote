const { generateTrackedNonTaskTextMock } = vi.hoisted(() => ({
  generateTrackedNonTaskTextMock: vi.fn(),
}));

vi.mock('../non-task-provider-usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../non-task-provider-usage')>()),
  generateTrackedNonTaskText: generateTrackedNonTaskTextMock,
}));

import {
  AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES,
  formatAudioTranscriptionResult,
  isAudioTranscriptionSupportedMimeType,
  resolveAudioTranscriptionMimeType,
  transcribeAudioAttachment,
} from '../audio-transcription';
import {
  NonTaskAudioVideoSupportDisabledError,
  NonTaskInputModalityUnsupportedError,
  VISION_MODEL_AUDIO_VIDEO_DISABLED_MESSAGE,
} from '../non-task-provider-usage';

describe('audio transcription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('transcribes Telegram OGG audio without spending the response on reasoning', async () => {
    generateTrackedNonTaskTextMock.mockResolvedValue('Deploy the fix.');

    const result = await transcribeAudioAttachment({
      audioBytes: Buffer.from('audio'),
      mimeType: 'audio/ogg',
      filename: 'voice-message.ogg',
      userTextContext: 'Please handle this request.',
    });

    expect(result).toEqual({
      status: 'transcribed',
      transcript: 'Deploy the fix.',
    });
    expect(generateTrackedNonTaskTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredInputModality: 'audio',
        reasoningEffort: 'low',
        files: [
          {
            mime: 'audio/ogg',
            filename: 'voice-message.ogg',
            url: 'data:audio/ogg;base64,YXVkaW8=',
          },
        ],
      }),
    );
  });

  it('reports when configured models do not support audio', async () => {
    generateTrackedNonTaskTextMock.mockRejectedValue(
      new NonTaskInputModalityUnsupportedError('audio'),
    );

    await expect(
      transcribeAudioAttachment({
        audioBytes: Buffer.from('audio'),
        mimeType: 'audio/mp4',
      }),
    ).resolves.toEqual({ status: 'unsupported_model' });
  });

  it('points runtime audio capability errors back to the Vision model setting', async () => {
    generateTrackedNonTaskTextMock.mockRejectedValue(
      new Error('This model does not support audio input.'),
    );

    const result = await transcribeAudioAttachment({
      audioBytes: Buffer.from('audio'),
      mimeType: 'audio/ogg',
      filename: 'voice-message.ogg',
    });

    expect(result).toEqual({ status: 'unsupported_model' });
    expect(
      formatAudioTranscriptionResult('voice-message.ogg', result),
    ).toContain('Settings > Models > Vision model');
  });

  it('rejects audio without calling a model when audio and video are disabled', async () => {
    generateTrackedNonTaskTextMock.mockRejectedValue(
      new NonTaskAudioVideoSupportDisabledError('audio'),
    );

    const result = await transcribeAudioAttachment({
      audioBytes: Buffer.from('audio'),
      mimeType: 'audio/ogg',
      filename: 'voice-message.ogg',
    });

    expect(result).toEqual({ status: 'audio_video_disabled' });
    expect(
      formatAudioTranscriptionResult('voice-message.ogg', result),
    ).toContain(VISION_MODEL_AUDIO_VIDEO_DISABLED_MESSAGE);
  });

  it('rejects unsupported and oversized audio without inference', async () => {
    expect(isAudioTranscriptionSupportedMimeType('audio/mp4')).toBe(true);
    expect(isAudioTranscriptionSupportedMimeType('audio/x-ms-wma')).toBe(false);

    await expect(
      transcribeAudioAttachment({
        audioBytes: Buffer.alloc(AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES + 1),
        mimeType: 'audio/mp4',
      }),
    ).resolves.toEqual({ status: 'oversized' });
    expect(generateTrackedNonTaskTextMock).not.toHaveBeenCalled();
  });

  it('normalizes provider MIME metadata and formats actionable warnings', () => {
    expect(
      resolveAudioTranscriptionMimeType({
        mimeType: 'audio/mpeg; charset=binary',
      }),
    ).toBe('audio/mpeg');
    expect(resolveAudioTranscriptionMimeType({ filename: 'voice.m4a' })).toBe(
      'audio/mp4',
    );
    expect(resolveAudioTranscriptionMimeType({ filename: 'voice.wma' })).toBe(
      null,
    );
    expect(
      resolveAudioTranscriptionMimeType({
        mimeType: 'video/mp4',
        filename: 'clip.mp4',
      }),
    ).toBe(null);
    expect(
      formatAudioTranscriptionResult('voice.ogg', {
        status: 'unsupported_model',
      }),
    ).toContain('Settings > Models > Vision model');
  });
});
