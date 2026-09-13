import {
  gracefullyShutdownWeb,
  installWebFastAgentGracefulShutdown,
  resolveWebShutdownDrainMs,
} from './fast-agent-graceful-shutdown';

describe('Fast web graceful shutdown', () => {
  it('uses the web drain override before the shared API fallback', () => {
    expect(resolveWebShutdownDrainMs({})).toBe(20_000);
    expect(
      resolveWebShutdownDrainMs({
        R_WEB_SHUTDOWN_DRAIN_MS: '5000',
        R_API_SHUTDOWN_DRAIN_MS: '9000',
      }),
    ).toBe(5_000);
    expect(
      resolveWebShutdownDrainMs({
        R_API_SHUTDOWN_DRAIN_MS: '9000',
      }),
    ).toBe(9_000);
  });

  it('hands active Fast turns back during the Next shutdown drain', async () => {
    const beginDrain = vi.fn();
    const waitForTurns = vi.fn().mockResolvedValue(1);
    const abortTurns = vi.fn().mockResolvedValue(1);

    await gracefullyShutdownWeb('SIGTERM', {
      beginDrain,
      waitForTurns,
      abortTurns,
      drainMs: 12_345,
    });

    expect(beginDrain).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'FastAgentProcessShutdownError',
        signal: 'SIGTERM',
      }),
    );
    expect(waitForTurns).toHaveBeenCalledWith(12_345);
    expect(abortTurns).toHaveBeenCalledOnce();
  });

  it('starts only one drain while Next handles repeated signals', () => {
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const on = vi.spyOn(process, 'on').mockImplementation(((
      signal,
      handler,
    ) => {
      signalHandlers.set(signal as NodeJS.Signals, handler as () => void);
      return process;
    }) as typeof process.on);
    const off = vi.spyOn(process, 'off').mockReturnValue(process);
    const beginDrain = vi.fn();

    try {
      const cleanup = installWebFastAgentGracefulShutdown({
        beginDrain,
        waitForTurns: vi.fn(() => new Promise<number>(() => undefined)),
        abortTurns: vi.fn(() => new Promise<number>(() => undefined)),
      });

      signalHandlers.get('SIGTERM')?.();
      signalHandlers.get('SIGINT')?.();
      expect(beginDrain).toHaveBeenCalledOnce();
      cleanup();
      expect(off).toHaveBeenCalledTimes(2);
    } finally {
      on.mockRestore();
      off.mockRestore();
    }
  });
});
