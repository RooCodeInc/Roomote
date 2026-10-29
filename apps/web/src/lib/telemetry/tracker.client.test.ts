import { Blob as NodeBlob } from 'node:buffer';

describe('anonymous pageview transport privacy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('Blob', NodeBlob);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends bounded setup-step properties through the actual timer-flushed batch', async () => {
    const { trackPageview } = await import('./tracker');
    trackPageview(
      '/setup',
      '?step=inference&token=synthetic-marker&email=fixture%40example.invalid',
    );
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/telemetry');
    expect(init).toMatchObject({ method: 'POST', keepalive: true });
    const payload = JSON.parse(String(init?.body));
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].properties).toEqual({
      path: '/setup',
      search: 'step=inference',
    });
    expect(String(init?.body)).not.toContain('synthetic-marker');
    expect(String(init?.body)).not.toContain('example.invalid');
  });

  it('uses the same sanitized batch for pagehide beacon delivery', async () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    const { trackPageview } = await import('./tracker');
    trackPageview('/setup', 'step=synthetic-marker');
    trackPageview('/setup-extra', 'step=welcome&token=synthetic-marker');
    trackPageview('/settings/models', 'token=synthetic-marker');
    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0]?.[0]).toBe('/api/telemetry');
    const payload = JSON.parse(
      await (sendBeacon.mock.calls[0]?.[1] as NodeBlob).text(),
    );
    expect(
      payload.events.map((event: { properties: unknown }) => event.properties),
    ).toEqual([
      { path: '/setup' },
      { path: '/setup-extra' },
      { path: '/settings/models' },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
