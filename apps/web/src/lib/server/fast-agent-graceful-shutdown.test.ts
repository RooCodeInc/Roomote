import {
  gracefullyShutdownWebFastAgentTurns,
  installWebFastAgentGracefulShutdown,
  resolveWebShutdownDrainMs,
} from './fast-agent-graceful-shutdown';

describe('resolveWebShutdownDrainMs', () => {
  it('falls back from the web window to the API window to the default', () => {
    expect(resolveWebShutdownDrainMs({})).toBe(20_000);
    expect(resolveWebShutdownDrainMs({ R_API_SHUTDOWN_DRAIN_MS: '5000' })).toBe(
      5_000,
    );
    expect(
      resolveWebShutdownDrainMs({
        R_WEB_SHUTDOWN_DRAIN_MS: '1500',
        R_API_SHUTDOWN_DRAIN_MS: '5000',
      }),
    ).toBe(1_500);
    expect(resolveWebShutdownDrainMs({ R_WEB_SHUTDOWN_DRAIN_MS: '0' })).toBe(0);
    expect(
      resolveWebShutdownDrainMs({ R_WEB_SHUTDOWN_DRAIN_MS: 'not-a-number' }),
    ).toBe(20_000);
  });
});

describe('gracefullyShutdownWebFastAgentTurns', () => {
  it('closes admissions, drains, then aborts the stragglers', async () => {
    const beginDrain = vi.fn();
    let finishDrain: ((remaining: number) => void) | undefined;
    const waitForTurns = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finishDrain = resolve;
        }),
    );
    const abortTurns = vi.fn().mockResolvedValue(1);
    const logWarn = vi.fn();

    const shutdown = gracefullyShutdownWebFastAgentTurns('SIGTERM', {
      abortTurns,
      beginDrain,
      waitForTurns,
      drainMs: 12_345,
      logWarn,
    });

    expect(beginDrain).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'FastAgentProcessShutdownError',
        signal: 'SIGTERM',
      }),
    );
    expect(waitForTurns).toHaveBeenCalledWith(12_345);
    expect(abortTurns).not.toHaveBeenCalled();

    finishDrain?.(1);
    await expect(shutdown).resolves.toBe(1);
    expect(abortTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'FastAgentProcessShutdownError',
        signal: 'SIGTERM',
      }),
    );
    expect(logWarn).toHaveBeenCalledWith(
      '[web] Aborting 1 Fast turn(s) still active after the 12345ms shutdown drain.',
    );
  });
});

describe('installWebFastAgentGracefulShutdown', () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('hands off on the first signal only and leaves process exit to Next', async () => {
    const beginDrain = vi.fn();
    const waitForTurns = vi.fn().mockResolvedValue(0);
    const abortTurns = vi.fn().mockResolvedValue(0);
    const termListeners = process.listenerCount('SIGTERM');
    const intListeners = process.listenerCount('SIGINT');

    uninstall = installWebFastAgentGracefulShutdown({
      beginDrain,
      waitForTurns,
      abortTurns,
      drainMs: 0,
    });
    expect(process.listenerCount('SIGTERM')).toBe(termListeners + 1);
    expect(process.listenerCount('SIGINT')).toBe(intListeners + 1);

    // Repeated installs (dev module re-evaluation) reuse the first listener.
    expect(installWebFastAgentGracefulShutdown()).toBe(uninstall);
    expect(process.listenerCount('SIGTERM')).toBe(termListeners + 1);

    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => expect(abortTurns).toHaveBeenCalledOnce());
    expect(beginDrain).toHaveBeenCalledOnce();
    expect(beginDrain).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM' }),
    );

    uninstall();
    uninstall = undefined;
    expect(process.listenerCount('SIGTERM')).toBe(termListeners);
    expect(process.listenerCount('SIGINT')).toBe(intListeners);
  });
});
