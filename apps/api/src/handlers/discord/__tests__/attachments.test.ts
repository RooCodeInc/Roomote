import { processDiscordAttachments } from '../attachments.js';

describe('processDiscordAttachments', () => {
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
});
