import { afterEach, describe, expect, it, vi } from 'vitest';

import { handlePublicUrlFetch } from '../public-url-fetch';

const config = {
  token: 'run-token',
  platformApiUrl: 'https://roomote.example',
};

describe('handlePublicUrlFetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('proxies the narrow input through the authenticated Roomote API', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async () =>
      Response.json({
        kind: 'text',
        url: 'https://example.com/',
        status: 200,
        contentType: 'text/plain',
        format: 'text',
        text: 'hello',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await handlePublicUrlFetch(
      {
        url: 'https://example.com/',
        format: 'text',
        timeout: 45,
        headers: { Authorization: 'Bearer caller' },
      },
      config,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://roomote.example/api/mcp/public-url-fetch',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer run-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          url: 'https://example.com/',
          format: 'text',
          timeout: 45,
          headers: { Authorization: 'Bearer caller' },
        }),
      }),
    );
    expect(result.structuredContent).toEqual({
      kind: 'text',
      url: 'https://example.com/',
      status: 200,
      contentType: 'text/plain',
      format: 'text',
    });
    expect(timeout).toHaveBeenCalledWith(50_000);
  });

  it('returns API images as MCP image content', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        kind: 'image',
        url: 'https://example.com/image.png',
        status: 200,
        contentType: 'image/png',
        mimeType: 'image/png',
        data: 'aW1hZ2U=',
        size: 5,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await handlePublicUrlFetch(
      { url: 'https://example.com/image.png' },
      config,
    );

    expect(result.content).toEqual([
      { type: 'text', text: 'Image fetched successfully' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ]);
  });
});
