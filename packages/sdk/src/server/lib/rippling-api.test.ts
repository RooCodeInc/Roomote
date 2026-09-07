import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/db/encryption', () => ({
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
}));

import { resolveRipplingPageUrl, ripplingApiRequestJson } from './rippling-api';

const config = {
  type: 'rippling' as const,
  encryptedApiToken: 'enc:rippling-secret',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ripplingApiRequestJson', () => {
  it('authenticates with the encrypted bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [], next_link: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await ripplingApiRequestJson({
      config,
      pathOrUrl: 'workers/',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://rest.ripplingapis.com/workers/'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer rippling-secret',
        }),
      }),
    );
  });

  it('retries rate limits using Retry-After', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'Slow down' }), {
          status: 429,
          headers: { 'retry-after': '2' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [], next_link: null }), {
          status: 200,
        }),
      );
    const wait = vi.fn().mockResolvedValue(undefined);

    await ripplingApiRequestJson({
      config,
      pathOrUrl: 'workers/',
      fetchImpl,
      wait,
    });

    expect(wait).toHaveBeenCalledWith(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries transient network failures with bounded backoff', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [], next_link: null }), {
          status: 200,
        }),
      );
    const wait = vi.fn().mockResolvedValue(undefined);

    await ripplingApiRequestJson({
      config,
      pathOrUrl: 'workers/',
      fetchImpl,
      wait,
    });

    expect(wait).toHaveBeenCalledWith(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects pagination URLs outside Rippling', () => {
    expect(() =>
      resolveRipplingPageUrl('https://example.com/workers/'),
    ).toThrow('unexpected API origin');
  });
});
