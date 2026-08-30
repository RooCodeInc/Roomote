import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/db/encryption', () => ({
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
}));

import { notionApiRequestJson } from './notion-api';

const config = {
  type: 'notion' as const,
  encryptedToken: 'enc:notion-secret',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notionApiRequestJson', () => {
  it('preserves Notion rate-limit metadata for bounded retries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'rate_limited',
            message: 'Slow down',
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': '3',
            },
          },
        ),
      ),
    );

    await expect(
      notionApiRequestJson({ config, path: 'search', method: 'POST' }),
    ).rejects.toMatchObject({
      name: 'NotionApiError',
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 3,
    });
  });

  it('does not invent a zero-second retry when Retry-After is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 'internal_server_error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(
      notionApiRequestJson({ config, path: 'search' }),
    ).rejects.toMatchObject({
      status: 500,
      retryAfterSeconds: null,
    });
  });
});
