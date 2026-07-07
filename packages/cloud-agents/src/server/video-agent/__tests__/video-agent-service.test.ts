import {
  describeVideoAttachment,
  VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES,
} from '../..';

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

  it('skips supported videos while no separate video provider is configured', async () => {
    const description = await describeVideoAttachment({
      videoBytes: Buffer.from('video-bytes'),
      mimeType: 'video/mp4',
      userTextContext: 'User says the save button does not work.',
    });

    expect(description).toBeNull();
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping video description'),
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
  });
});
