const { OctokitMock } = vi.hoisted(() => ({
  OctokitMock: vi.fn().mockImplementation(function (options: unknown) {
    return { options };
  }),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: OctokitMock,
}));

import { getGitHubRateLimitRetryAfterMs, getOctokit } from '../api';

describe('getOctokit', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    OctokitMock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('routes Octokit requests through the runtime fetch with the API version header', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      getOctokit('ghs_test');

      expect(OctokitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: 'ghs_test',
          userAgent: 'Roomote',
          request: expect.objectContaining({
            headers: expect.objectContaining({
              'X-GitHub-Api-Version': '2022-11-28',
            }),
            fetch: expect.any(Function),
          }),
        }),
      );

      const requestFetch = OctokitMock.mock.calls[0]?.[0]?.request?.fetch;

      await requestFetch?.('https://api.github.com/repos/Roomote/example-app', {
        method: 'GET',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/Roomote/example-app',
        { method: 'GET' },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not retry rate limits unless the caller opts in', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('too many requests', { status: 429 }));
    globalThis.fetch = fetchMock;

    getOctokit('ghs_test');
    const requestFetch = OctokitMock.mock.calls[0]?.[0]?.request?.fetch;
    const response = await requestFetch?.(
      'https://api.github.com/repos/acme/app',
      { method: 'GET' },
    );

    expect(response).toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After for rate-limited closeout requests', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('secondary rate limit', {
          status: 403,
          headers: { 'Retry-After': '2' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock;

    getOctokit('ghs_test', { retryRateLimits: true });
    const requestFetch = OctokitMock.mock.calls[0]?.[0]?.request?.fetch;
    const request = requestFetch?.('https://api.github.com/repos/acme/app', {
      method: 'PATCH',
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(request).resolves.toMatchObject({ status: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits until x-ratelimit-reset and bounds the retry count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
    const reset = Math.floor(Date.now() / 1_000) + 1;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('rate limit exceeded', {
        status: 403,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(reset),
        },
      }),
    );
    globalThis.fetch = fetchMock;

    getOctokit('ghs_test', { retryRateLimits: true });
    const requestFetch = OctokitMock.mock.calls[0]?.[0]?.request?.fetch;
    const request = requestFetch?.('https://api.github.com/graphql', {
      method: 'POST',
    });

    await vi.advanceTimersByTimeAsync(32_000);

    await expect(request).resolves.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry ordinary permission failures', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('forbidden', { status: 403 }));
    globalThis.fetch = fetchMock;

    getOctokit('ghs_test', { retryRateLimits: true });
    const requestFetch = OctokitMock.mock.calls[0]?.[0]?.request?.fetch;
    const response = await requestFetch?.(
      'https://api.github.com/repos/acme/app',
      { method: 'PATCH' },
    );

    expect(response).toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses a conservative fallback for headerless secondary limits', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'You have exceeded a secondary rate limit.',
          }),
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock;

    getOctokit('ghs_test', { retryRateLimits: true });
    const requestFetch = OctokitMock.mock.calls[0]?.[0]?.request?.fetch;
    const request = requestFetch?.('https://api.github.com/graphql', {
      method: 'POST',
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(request).resolves.toMatchObject({ status: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries 429 responses with bounded exponential backoff', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('too many requests', { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock;

    getOctokit('ghs_test', { retryRateLimits: true });
    const requestFetch = OctokitMock.mock.calls[0]?.[0]?.request?.fetch;
    const request = requestFetch?.('https://api.github.com/repos/acme/app', {
      method: 'PATCH',
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(request).resolves.toMatchObject({ status: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('getGitHubRateLimitRetryAfterMs', () => {
  it('uses the installation reset header for primary limits', () => {
    const now = Date.parse('2026-08-22T12:00:00.000Z');
    const error = Object.assign(new Error('API rate limit exceeded'), {
      status: 403,
      response: {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(now / 1_000 + 120),
        },
      },
    });

    expect(getGitHubRateLimitRetryAfterMs(error, now)).toBe(121_000);
  });

  it('uses a durable fallback when GitHub omits rate-limit headers', () => {
    const error = Object.assign(
      new Error('API rate limit exceeded for installation ID'),
      { status: 403, response: { headers: {} } },
    );

    expect(getGitHubRateLimitRetryAfterMs(error)).toBe(15 * 60 * 1_000);
  });

  it('rejects ordinary permission failures', () => {
    const error = Object.assign(new Error('Resource not accessible'), {
      status: 403,
      response: { headers: {} },
    });

    expect(getGitHubRateLimitRetryAfterMs(error)).toBeNull();
  });
});
