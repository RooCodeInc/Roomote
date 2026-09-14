import {
  gracefullyShutdownWeb,
  installWebFastAgentGracefulShutdown,
  resolveWebShutdownDrainMs,
  WEB_FAST_AGENT_SHUTDOWN_REQUEST,
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

  it('acknowledges one coordinated shutdown only after the handoff finishes', async () => {
    let messageHandler: ((message: unknown) => void) | undefined;
    const on = vi.spyOn(process, 'on').mockImplementation(((event, handler) => {
      if (event === 'message')
        messageHandler = handler as (message: unknown) => void;
      return process;
    }) as typeof process.on);
    const off = vi.spyOn(process, 'off').mockReturnValue(process);
    const beginDrain = vi.fn();
    let finishDrain: ((remaining: number) => void) | undefined;
    const notifyReady = vi.fn();

    try {
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

      messageHandler?.({
        type: WEB_FAST_AGENT_SHUTDOWN_REQUEST,
        signal: 'SIGTERM',
      });
      messageHandler?.({
        type: WEB_FAST_AGENT_SHUTDOWN_REQUEST,
        signal: 'SIGINT',
      });
      expect(beginDrain).toHaveBeenCalledOnce();
      expect(notifyReady).not.toHaveBeenCalled();
      finishDrain?.(1);
      await vi.waitFor(() =>
        expect(notifyReady).toHaveBeenCalledWith('SIGTERM'),
      );
      cleanup();
      expect(off).toHaveBeenCalledOnce();
    } finally {
      on.mockRestore();
      off.mockRestore();
    }
  });
});
