import { GitHubConditionalRequestCache } from '../github-conditional-request-cache';

describe('GitHubConditionalRequestCache', () => {
  it('reuses a cached response when GitHub returns 304', async () => {
    const cache = new GitHubConditionalRequestCache();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 1 }],
        headers: { etag: '"comments-v1"' },
        status: 200,
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Not modified'), {
          status: 304,
          response: { headers: {} },
        }),
      );

    await expect(cache.request('comments', request)).resolves.toMatchObject({
      data: [{ id: 1 }],
    });
    await expect(cache.request('comments', request)).resolves.toMatchObject({
      data: [{ id: 1 }],
    });

    expect(request).toHaveBeenNthCalledWith(1, {});
    expect(request).toHaveBeenNthCalledWith(2, {
      'if-none-match': '"comments-v1"',
    });
  });

  it('drops expired and least-recently-used entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const cache = new GitHubConditionalRequestCache(1, 100);
    const response = (etag: string) => ({
      data: etag,
      headers: { etag },
      status: 200,
    });

    await cache.request('first', async () => response('"first-v1"'));
    await cache.request('second', async () => response('"second-v1"'));

    const evictedRequest = vi.fn(async () => response('"first-v2"'));
    await cache.request('first', evictedRequest);
    expect(evictedRequest).toHaveBeenCalledWith({});

    vi.advanceTimersByTime(101);
    const expiredRequest = vi.fn(async () => response('"first-v3"'));
    await cache.request('first', expiredRequest);
    expect(expiredRequest).toHaveBeenCalledWith({});

    vi.useRealTimers();
  });
});
