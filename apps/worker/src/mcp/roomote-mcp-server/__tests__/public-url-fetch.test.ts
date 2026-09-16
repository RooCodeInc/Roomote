import { afterEach, describe, expect, it, vi } from 'vitest';

import { handlePublicUrlFetch } from '../public-url-fetch';

const config = {
  token: 'run-token',
  platformApiUrl: 'https://roomote.example',
};

describe('handlePublicUrlFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proxies the narrow input through the authenticated Roomote API', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        url: 'https://example.com/',
        status: 200,
        contentType: 'text/plain',
        text: 'hello',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await handlePublicUrlFetch(
      { url: 'https://example.com/' },
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
        body: JSON.stringify({ url: 'https://example.com/' }),
      }),
    );
    expect(result.structuredContent).toMatchObject({ text: 'hello' });
  });

  it('rejects extra caller-controlled request fields before the API call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handlePublicUrlFetch(
      { url: 'https://example.com/', headers: { authorization: 'secret' } },
      config,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain('Unrecognized key');
  });
});
