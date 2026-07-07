import {
  getLongLivedProxyStreamHealthSnapshot,
  registerLongLivedProxyStream,
  resetLongLivedProxyStreamRegistryForTests,
} from '../long-lived-proxy-stream-registry';

describe('long-lived proxy stream registry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T05:00:00.000Z'));
    resetLongLivedProxyStreamRegistryForTests();
  });

  afterEach(() => {
    resetLongLivedProxyStreamRegistryForTests();
    vi.useRealTimers();
  });

  it('tracks active streams by route and age bucket', () => {
    const releaseDocs = registerLongLivedProxyStream({
      route: 'mcp:Docs',
      method: 'POST',
      path: '/mcp',
      requestId: 'req-1',
    });

    vi.advanceTimersByTime(5 * 60_000);

    const releaseMcp = registerLongLivedProxyStream({
      route: 'mcp:GitHub',
      method: 'GET',
      path: '/mcp',
      requestId: 'req-2',
    });

    vi.advanceTimersByTime(30_000);

    expect(getLongLivedProxyStreamHealthSnapshot()).toEqual({
      activeCount: 2,
      oldestAgeMs: 330_000,
      countsByAge: {
        atLeast1m: 1,
        atLeast5m: 1,
        atLeast15m: 0,
      },
      byRoute: {
        'mcp:Docs': 1,
        'mcp:GitHub': 1,
      },
      warningActive: false,
      warningThresholds: {
        activeCount: 20,
        oldestAgeMs: 600_000,
      },
    });

    releaseDocs();
    releaseMcp();

    expect(getLongLivedProxyStreamHealthSnapshot()).toEqual({
      activeCount: 0,
      oldestAgeMs: null,
      countsByAge: {
        atLeast1m: 0,
        atLeast5m: 0,
        atLeast15m: 0,
      },
      byRoute: {},
      warningActive: false,
      warningThresholds: {
        activeCount: 20,
        oldestAgeMs: 600_000,
      },
    });
  });

  it('logs a throttled warning when streams stay open too long', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registerLongLivedProxyStream({
      route: 'mcp:Docs',
      method: 'POST',
      path: '/mcp',
      requestId: 'req-1',
    });

    vi.advanceTimersByTime(10 * 60_000);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      '[API Long-Lived Proxy Streams]',
    );
    expect(warnSpy.mock.calls[0]?.[0]).toContain('active=1');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('oldestAgeMs=600000');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('"mcp:Docs":1');
  });
});
