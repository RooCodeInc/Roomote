const { transcribeAudioAttachmentMock } = vi.hoisted(() => ({
  transcribeAudioAttachmentMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  transcribeAudioAttachment: transcribeAudioAttachmentMock,
}));

import { processDiscordAttachments } from '../attachments.js';

describe('processDiscordAttachments', () => {
  beforeEach(() => {
    transcribeAudioAttachmentMock.mockReset();
  });
  it('materializes a trusted Discord image URL as a data URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': '3',
        },
      }),
    );

    const result = await processDiscordAttachments(
      [
        {
          id: 'image-1',
          filename: 'screen.png',
          content_type: 'image/png',
          size: 3,
          url: 'https://cdn.discordapp.com/attachments/1/2/screen.png?ex=1&is=2&hm=3',
        },
      ],
      { fetch: fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'cdn.discordapp.com' }),
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(result).toEqual({
      images: ['data:image/png;base64,AQID'],
      attachmentTexts: [],
      warnings: [],
    });
  });

  it('refuses an untrusted attachment host without fetching it', async () => {
    const fetchImpl = vi.fn();

    const result = await processDiscordAttachments(
      [
        {
          id: 'image-1',
          filename: 'screen.png',
          content_type: 'image/png',
          size: 3,
          url: 'https://attacker.example/screen.png',
        },
      ],
      { fetch: fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.images).toEqual([]);
    expect(result.warnings[0]).toContain('outside the trusted CDN');
    expect(result.warnings[0]).not.toContain('attacker.example');
  });

  it('rejects an oversized image before downloading it', async () => {
    const fetchImpl = vi.fn();

    const result = await processDiscordAttachments(
      [
        {
          id: 'image-1',
          filename: 'huge.png',
          content_type: 'image/png',
          size: 10 * 1024 * 1024 + 1,
          url: 'https://cdn.discordapp.com/attachments/1/2/huge.png',
        },
      ],
      { fetch: fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.images).toEqual([]);
    expect(result.warnings[0]).toContain('exceeds');
  });

  it('transcribes a bounded audio attachment without exposing its URL', async () => {
    transcribeAudioAttachmentMock.mockResolvedValue({
      status: 'transcribed',
      transcript: 'Please fix the login test.',
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '3' },
      }),
    );

    const result = await processDiscordAttachments(
      [
        {
          id: 'audio-1',
          filename: 'request.mp3',
          content_type: 'audio/mpeg',
          size: 3,
          url: 'https://cdn.discordapp.com/attachments/1/2/request.mp3?secret=1',
        },
      ],
      { fetch: fetchImpl, userId: 'user-1' },
    );

    expect(result.attachmentTexts).toEqual([
      'Audio attachment transcript ("request.mp3"):\nPlease fix the login test.',
    ]);
    expect(JSON.stringify(result)).not.toContain('secret=1');
  });

  it('returns actionable model and size warnings for audio', async () => {
    transcribeAudioAttachmentMock.mockResolvedValue({
      status: 'unsupported_model',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(Uint8Array.from([1]), { status: 200 }));
    const attachment = {
      id: 'audio-1',
      filename: 'request.mp3',
      content_type: 'audio/mpeg',
      size: 1,
      url: 'https://cdn.discordapp.com/attachments/1/2/request.mp3',
    };

    const unsupported = await processDiscordAttachments([attachment], {
      fetch: fetchImpl,
    });
    const oversized = await processDiscordAttachments(
      [{ ...attachment, size: 20 * 1024 * 1024 + 1 }],
      { fetch: fetchImpl },
    );

    expect(unsupported.attachmentTexts[0]).toContain(
      'no configured model supports audio input',
    );
    expect(oversized.attachmentTexts[0]).toContain('20 MiB limit');
  });
});
