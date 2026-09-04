import {
  gracefullyShutdownBullMq,
  installBullMqGracefulShutdown,
  resolveBullMqShutdownDrainMs,
} from './graceful-shutdown';

describe('resolveBullMqShutdownDrainMs', () => {
  it('prefers its own window and falls back to the API window, then the default', () => {
    expect(resolveBullMqShutdownDrainMs({})).toBe(20_000);
    expect(
      resolveBullMqShutdownDrainMs({ R_API_SHUTDOWN_DRAIN_MS: '15000' }),
    ).toBe(15_000);
    expect(
      resolveBullMqShutdownDrainMs({
        R_API_SHUTDOWN_DRAIN_MS: '15000',
        R_BULLMQ_SHUTDOWN_DRAIN_MS: '45000',
      }),
    ).toBe(45_000);
    expect(
      resolveBullMqShutdownDrainMs({ R_BULLMQ_SHUTDOWN_DRAIN_MS: '0' }),
    ).toBe(0);
  });
});

describe('gracefullyShutdownBullMq', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops the Fast worker as the drain starts and closes the rest only after the abort', async () => {
    const order: string[] = [];
    let finishWorkerClose: (() => void) | undefined;
    const fastAgentWorker = {
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            order.push('worker.close');
            finishWorkerClose = resolve;
          }),
      ),
    };
    const closeRemaining = vi.fn(async () => {
      order.push('closeRemaining');
    });
    let finishDrain: ((remaining: number) => void) | undefined;
    const waitForTurns = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          order.push('wait');
          finishDrain = resolve;
        }),
    );
    const abortTurns = vi.fn(async () => {
      order.push('abort');
      // The aborted turns reject their jobs, which lets the worker close.
      finishWorkerClose?.();
      return 1;
    });
    const exitProcess = vi.fn() as unknown as (code?: number) => never;
    const logWarn = vi.fn();

    const shutdown = gracefullyShutdownBullMq('SIGTERM', {
      fastAgentWorker,
      closeRemaining,
      beginDrain: vi.fn(() => order.push('begin')),
      waitForTurns,
      abortTurns,
      drainMs: 4_321,
      exitProcess,
      logWarn,
      logInfo: vi.fn(),
    });

    await vi.waitFor(() => expect(waitForTurns).toHaveBeenCalledWith(4_321));
    expect(fastAgentWorker.close).toHaveBeenCalledOnce();
    expect(abortTurns).not.toHaveBeenCalled();
    expect(closeRemaining).not.toHaveBeenCalled();

    finishDrain?.(1);
    await shutdown;

    expect(order).toEqual([
      'begin',
      'worker.close',
      'wait',
      'abort',
      'closeRemaining',
    ]);
    expect(abortTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'FastAgentProcessShutdownError',
        signal: 'SIGTERM',
      }),
    );
    expect(logWarn).toHaveBeenCalledWith(
      '[bullmq] Aborting 1 Fast turn(s) still active after the 4321ms shutdown drain.',
    );
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('does not let a worker that ignores its abort hold shutdown open', async () => {
    const fastAgentWorker = {
      close: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const closeRemaining = vi.fn().mockResolvedValue(undefined);
    const exitProcess = vi.fn() as unknown as (code?: number) => never;
    const logWarn = vi.fn();

    await gracefullyShutdownBullMq('SIGTERM', {
      fastAgentWorker,
      closeRemaining,
      beginDrain: vi.fn(),
      waitForTurns: vi.fn().mockResolvedValue(0),
      abortTurns: vi.fn().mockResolvedValue(0),
      drainMs: 0,
      workerCloseTimeoutMs: 10,
      exitProcess,
      logWarn,
      logInfo: vi.fn(),
    });

    expect(logWarn).toHaveBeenCalledWith(
      '[bullmq] Fast parent event worker did not close within 10ms of the abort; continuing shutdown.',
    );
    expect(closeRemaining).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('still exits when closing the remaining queues fails', async () => {
    const error = new Error('redis gone');
    const exitProcess = vi.fn() as unknown as (code?: number) => never;
    const logError = vi.fn();

    await gracefullyShutdownBullMq('SIGINT', {
      fastAgentWorker: { close: vi.fn().mockResolvedValue(undefined) },
      closeRemaining: vi.fn().mockRejectedValue(error),
      beginDrain: vi.fn(),
      waitForTurns: vi.fn().mockResolvedValue(0),
      abortTurns: vi.fn().mockResolvedValue(0),
      drainMs: 0,
      exitProcess,
      logError,
      logInfo: vi.fn(),
    });

    expect(logError).toHaveBeenCalledWith(
      '[Shutdown] Error during shutdown:',
      error,
    );
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'forces exit when %s arrives again during shutdown',
    (signal) => {
      const exitProcess = vi.fn() as unknown as (code?: number) => never;
      const signalHandlers = new Map<NodeJS.Signals, () => void>();
      const on = vi.spyOn(process, 'on').mockImplementation(((
        registeredSignal: NodeJS.Signals,
        handler: () => void,
      ) => {
        signalHandlers.set(registeredSignal, handler);
        return process;
      }) as typeof process.on);

      try {
        const cleanup = installBullMqGracefulShutdown({
          fastAgentWorker: { close: vi.fn().mockResolvedValue(undefined) },
          closeRemaining: vi.fn().mockResolvedValue(undefined),
          beginDrain: vi.fn(),
          waitForTurns: vi.fn(() => new Promise<number>(() => undefined)),
          abortTurns: vi.fn(() => new Promise<number>(() => undefined)),
          exitProcess,
          logInfo: vi.fn(),
        });

        signalHandlers.get(signal)?.();
        expect(exitProcess).not.toHaveBeenCalled();
        signalHandlers.get(signal)?.();
        expect(exitProcess).toHaveBeenCalledWith(1);
        cleanup();
      } finally {
        on.mockRestore();
      }
    },
  );
});
