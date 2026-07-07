import { fetchWithLongLivedStreamDispatcher } from '../long-lived-fetch';

describe('fetchWithLongLivedStreamDispatcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the current global fetch when it is not the observed wrapper', async () => {
    const globalFetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', globalFetch as typeof fetch);

    await fetchWithLongLivedStreamDispatcher('https://example.com/stream', {
      method: 'GET',
    });

    expect(globalFetch).toHaveBeenCalledTimes(1);

    const [, init] = globalFetch.mock.calls[0]!;
    expect((init as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });

  it('keeps using the observed global fetch wrapper', async () => {
    const observedFetch = Object.assign(
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      { [Symbol.for('roomote.observedFetch')]: true },
    );
    vi.stubGlobal('fetch', observedFetch as unknown as typeof fetch);

    await fetchWithLongLivedStreamDispatcher('https://example.com/stream', {
      method: 'GET',
    });

    expect(observedFetch).toHaveBeenCalledTimes(1);
    const [, init] = observedFetch.mock.calls[0]!;
    expect((init as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });
});
