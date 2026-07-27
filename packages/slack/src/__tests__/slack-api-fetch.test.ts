import {
  fetchSlackGetJson,
  slackFetch,
  SLACK_REQUEST_TIMEOUT_MS,
} from '../slack-api-fetch';

describe('slackFetch', () => {
  const originalBaseUrl = process.env.SLACK_API_BASE_URL;

  beforeEach(() => {
    process.env.SLACK_API_BASE_URL = 'https://slack.com/api/';
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalBaseUrl === undefined) {
      delete process.env.SLACK_API_BASE_URL;
      return;
    }

    process.env.SLACK_API_BASE_URL = originalBaseUrl;
  });

  it('applies the Slack request timeout to every call', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });

    await slackFetch(
      'https://slack.com/api/auth.test',
      { method: 'POST' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(timeoutSpy).toHaveBeenCalledWith(SLACK_REQUEST_TIMEOUT_MS);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('honours an explicit timeout override', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });

    await slackFetch(
      'https://files.slack.com/download',
      {},
      { fetchImpl: fetchMock as unknown as typeof fetch, timeoutMs: 30_000 },
    );

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it('keeps a caller-provided signal', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });

    await slackFetch(
      'https://slack.com/api/auth.test',
      { signal: controller.signal },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('propagates a timed-out request to the caller', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new DOMException('The operation was aborted.', 'TimeoutError'),
      );

    await expect(
      slackFetch(
        'https://slack.com/api/auth.test',
        {},
        { fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow('The operation was aborted.');
  });

  describe('fetchSlackGetJson', () => {
    it('sends the timeout signal with the Slack GET request', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      await fetchSlackGetJson({
        token: 'xoxb-test-token',
        endpoint: 'conversations.list',
        context: 'listPublicChannels',
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('caps each rate-limit wait at the configured ceiling', async () => {
      const waits: number[] = [];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: {
            get: (name: string) => (name === 'Retry-After' ? '60' : null),
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        });

      const result = await fetchSlackGetJson<{ ok: boolean }>({
        token: 'xoxb-test-token',
        endpoint: 'conversations.list',
        context: 'resolveChannelId',
        fetchImpl: fetchMock as unknown as typeof fetch,
        maxRateLimitRetries: 2,
        maxRateLimitWaitMs: 5_000,
        sleepImpl: async (ms) => {
          waits.push(ms);
        },
      });

      expect(waits).toEqual([5_000]);
      expect(result).toEqual({ ok: true });
    });
  });
});
