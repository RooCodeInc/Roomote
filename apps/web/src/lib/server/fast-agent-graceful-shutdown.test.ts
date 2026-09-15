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
    expect(
      resolveWebShutdownDrainMs({
        R_WEB_SHUTDOWN_DRAIN_MS: '24000',
        ROOMOTE_WEB_SHUTDOWN_MAX_DRAIN_MS: '22000',
      }),
    ).toBe(22_000);
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

  it('acknowledges one coordinated shutdown only after the handoff finishes', async () => {
    const beginDrain = vi.fn();
    let finishDrain: ((remaining: number) => void) | undefined;
    const notifyReady = vi.fn();
    const key = Symbol.for('roomote.web-fast-agent-shutdown-handler');
    const scope = globalThis as typeof globalThis & {
      [key]?: (signal: NodeJS.Signals) => Promise<void>;
    };

    const cleanup = installWebFastAgentGracefulShutdown({
      beginDrain,
      waitForTurns: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            finishDrain = resolve;
          }),
      ),
      abortTurns: vi.fn().mockResolvedValue(1),
      notifyReady,
    });

    const shutdown = scope[key]?.('SIGTERM');
    void scope[key]?.('SIGINT');
    expect(beginDrain).toHaveBeenCalledOnce();
    expect(notifyReady).not.toHaveBeenCalled();
    finishDrain?.(1);
    await shutdown;
    expect(notifyReady).toHaveBeenCalledWith('SIGTERM');
    cleanup();
    expect(scope[key]).toBeUndefined();
  });
});
