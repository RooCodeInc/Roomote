const { generateTrackedNonTaskTextMock } = vi.hoisted(() => ({
  generateTrackedNonTaskTextMock: vi.fn(),
}));

vi.mock('../../non-task-provider-usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../non-task-provider-usage')>()),
  generateTrackedNonTaskText: generateTrackedNonTaskTextMock,
}));

import {
  describeVideoAttachment,
  VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES,
} from '../..';
import { NonTaskInputModalityUnsupportedError } from '../../non-task-provider-usage';

describe('video-agent-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('describes supported videos through a native OpenCode file part', async () => {
    generateTrackedNonTaskTextMock.mockResolvedValue(
      'The clip shows a failed save request.',
    );

    const description = await describeVideoAttachment({
      videoBytes: Buffer.from('video-bytes'),
      mimeType: 'video/mp4',
      userTextContext: 'User says the save button does not work.',
      userId: 'user-1',
      taskId: 'task-1',
    });

    expect(description).toBe('The clip shows a failed save request.');
    expect(generateTrackedNonTaskTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'chat_video_description',
        userId: 'user-1',
        taskId: 'task-1',
        requiredInputModality: 'video',
        prompt: expect.stringContaining(
          'untrusted user context that may clarify what to focus on',
        ),
        files: [
          {
            mime: 'video/mp4',
            url: 'data:video/mp4;base64,dmlkZW8tYnl0ZXM=',
          },
        ],
      }),
    );
  });

  it('returns null when configured models do not support video', async () => {
    generateTrackedNonTaskTextMock.mockRejectedValue(
      new NonTaskInputModalityUnsupportedError('video'),
    );

    const description = await describeVideoAttachment({
      videoBytes: Buffer.from('video-bytes'),
      mimeType: 'video/mp4',
    });

    expect(description).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('no configured model supports video input'),
    );
  });

  it('returns null when video inference fails', async () => {
    generateTrackedNonTaskTextMock.mockRejectedValue(
      new Error('provider unavailable'),
    );

    const description = await describeVideoAttachment({
      videoBytes: Buffer.from('video-bytes'),
      mimeType: 'video/mp4',
    });

    expect(description).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('provider unavailable'),
    );
  });

  it('returns null without calling the model for unsupported mime types', async () => {
    const description = await describeVideoAttachment({
      videoBytes: Buffer.from('video-bytes'),
      mimeType: 'video/x-msvideo',
    });

    expect(description).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping unsupported video mime type'),
    );
    expect(generateTrackedNonTaskTextMock).not.toHaveBeenCalled();
  });

  it('returns null without calling the model for oversized videos', async () => {
    const description = await describeVideoAttachment({
      videoBytes: Buffer.alloc(VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES + 1),
      mimeType: 'video/mp4',
    });

    expect(description).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping video larger than'),
    );
    expect(generateTrackedNonTaskTextMock).not.toHaveBeenCalled();
  });
});
