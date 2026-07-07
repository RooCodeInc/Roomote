import {
  createObservedFetch,
  isInternalRequestUrl,
} from '../request-observability';

describe('request observability helpers', () => {
  it('passes external requests through without injecting a signal', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const observedFetch = createObservedFetch({
      serviceName: 'test',
      slowRequestThresholdMs: 1_000,
      fetchImpl: fetchMock,
    });

    await observedFetch('https://slack.com/api/chat.postMessage');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      undefined,
    );
  });

  it('preserves explicit signals on external requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const observedFetch = createObservedFetch({
      serviceName: 'test',
      slowRequestThresholdMs: 1_000,
      fetchImpl: fetchMock,
    });
    const controller = new AbortController();
    const init = {
      method: 'POST',
      signal: controller.signal,
    } satisfies RequestInit;

    await observedFetch(
      'https://api.github.com/repos/Roomote/example-app',
      init,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/Roomote/example-app',
      init,
    );
  });

  it('preserves Request signals for external Request inputs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const observedFetch = createObservedFetch({
      serviceName: 'test',
      slowRequestThresholdMs: 1_000,
      fetchImpl: fetchMock,
    });
    const controller = new AbortController();
    const request = new Request(
      'https://api.github.com/repos/Roomote/example-app',
      { signal: controller.signal },
    );

    await observedFetch(request);

    expect(fetchMock).toHaveBeenCalledWith(request, undefined);
  });

  it('does not classify hostnames starting with fc/fd as private IPv6', () => {
    expect(
      isInternalRequestUrl(new URL('https://fcdomain.example.com/api'), {
        internalHosts: [],
        internalDomainSuffixes: [],
      }),
    ).toBe(false);
  });

  it('logs slow external requests with the redacted URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const warn = vi.fn();
    const observedFetch = createObservedFetch({
      serviceName: 'test',
      slowRequestThresholdMs: 1_000,
      fetchImpl: fetchMock,
      log: { warn },
    });
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(1_500);

    await observedFetch('https://slack.com/api/chat.postMessage?token=secret');

    expect(warn).toHaveBeenCalledWith('[Observed External Request]', {
      service: 'test',
      method: 'GET',
      url: 'https://slack.com/api/chat.postMessage',
      status: 200,
      durationMs: 1_400,
    });

    dateNowSpy.mockRestore();
  });

  it('rethrows external fetch errors unchanged', async () => {
    const error = new Error('upstream failure');
    const fetchMock = vi.fn().mockRejectedValue(error);
    const observedFetch = createObservedFetch({
      serviceName: 'test',
      slowRequestThresholdMs: 1_000,
      fetchImpl: fetchMock,
    });

    await expect(
      observedFetch('https://api.github.com/repos/Roomote/example-app'),
    ).rejects.toBe(error);
  });

  it('treats preview domains as internal suffixes', () => {
    expect(
      isInternalRequestUrl(
        new URL('https://task-id.preview.roomote.run/health'),
        {
          internalHosts: ['api.roomote.run'],
          internalDomainSuffixes: ['preview.roomote.run'],
        },
      ),
    ).toBe(true);
  });
});
