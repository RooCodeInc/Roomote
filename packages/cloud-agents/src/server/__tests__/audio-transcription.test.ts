const { generateTrackedNonTaskTextMock } = vi.hoisted(() => ({
  generateTrackedNonTaskTextMock: vi.fn(),
}));

vi.mock('../non-task-provider-usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../non-task-provider-usage')>()),
  generateTrackedNonTaskText: generateTrackedNonTaskTextMock,
}));

import {
  AUDIO_TRANSCRIPTION_MAX_SIZE_BYTES,
  isAudioTranscriptionSupportedMimeType,
  transcribeAudioAttachment,
} from '../audio-transcription';
import { NonTaskInputModalityUnsupportedError } from '../non-task-provider-usage';

describe('audio transcription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('transcribes supported audio through a native OpenCode file part', async () => {
    generateTrackedNonTaskTextMock.mockResolvedValue('Deploy the fix.');

    const result = await transcribeAudioAttachment({
      audioBytes: Buffer.from('audio'),
      mimeType: 'audio/mp4',
      filename: 'clip.m4a',
      userTextContext: 'Please handle this request.',
    });

    expect(result).toEqual({
      status: 'transcribed',
      transcript: 'Deploy the fix.',
    });
    expect(generateTrackedNonTaskTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredInputModality: 'audio',
        files: [
          {
            mime: 'audio/mp4',
            filename: 'clip.m4a',
            url: 'data:audio/mp4;base64,YXVkaW8=',
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
});
