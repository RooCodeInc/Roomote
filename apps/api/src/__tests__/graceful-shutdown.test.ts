const mocks = vi.hoisted(() => ({
  abortActiveFastAgentTurns: vi.fn(),
  beginFastAgentTurnDrain: vi.fn(),
  markActiveFastAgentTurnsShutdown: vi.fn(async () => 0),
  waitForActiveFastAgentTurnsToSettle: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  abortActiveFastAgentTurns: mocks.abortActiveFastAgentTurns,
  beginFastAgentTurnDrain: mocks.beginFastAgentTurnDrain,
  markActiveFastAgentTurnsShutdown: mocks.markActiveFastAgentTurnsShutdown,
  waitForActiveFastAgentTurnsToSettle:
    mocks.waitForActiveFastAgentTurnsToSettle,
  FastAgentProcessShutdownError: class extends Error {
    constructor(public readonly signal: NodeJS.Signals) {
      super(`Fast turn interrupted by API shutdown (${signal}).`);
      this.name = 'FastAgentProcessShutdownError';
    }
  },
}));

import type { ServerType } from '@hono/node-server';

import {
  gracefullyShutdownApi,
  installApiGracefulShutdown,
  resolveApiShutdownDrainMs,
} from '../graceful-shutdown';

describe('resolveApiShutdownDrainMs', () => {
  it('defaults to a bounded drain window', () => {
    expect(resolveApiShutdownDrainMs({})).toBe(20_000);
    expect(resolveApiShutdownDrainMs({ R_API_SHUTDOWN_DRAIN_MS: '' })).toBe(
      20_000,
    );
    expect(
      resolveApiShutdownDrainMs({ R_API_SHUTDOWN_DRAIN_MS: 'not-a-number' }),
    ).toBe(20_000);
    expect(resolveApiShutdownDrainMs({ R_API_SHUTDOWN_DRAIN_MS: '-5' })).toBe(
      20_000,
    );
  });

  it('honors an explicit window, including the abort-immediately kill switch', () => {
    expect(resolveApiShutdownDrainMs({ R_API_SHUTDOWN_DRAIN_MS: '5000' })).toBe(
      5_000,
    );
    expect(resolveApiShutdownDrainMs({ R_API_SHUTDOWN_DRAIN_MS: '0' })).toBe(0);
  });
});

describe('gracefullyShutdownApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stamps active durable turns with the stop signal before draining', async () => {
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback()),
    } as unknown as ServerType;
    const order: string[] = [];
    const markTurnsShutdown = vi.fn(async () => {
      order.push('mark');
      return 1;
    });
    const waitForTurns = vi.fn(async () => {
      order.push('wait');
      return 0;
    });
    const abortTurns = vi.fn(async () => {
      order.push('abort');
      return 0;
    });

    await gracefullyShutdownApi(server, 'SIGTERM', {
      abortTurns,
      beginDrain: vi.fn(),
      markTurnsShutdown,
      waitForTurns,
      drainMs: 10,
      exitProcess: vi.fn() as unknown as (code?: number) => never,
      flushSentry: vi.fn().mockResolvedValue(undefined),
    });

    // The evidence lands before the drain can be cut short by a kill.
    expect(order).toEqual(['mark', 'wait', 'abort']);
  });

  it('does not let a stalled stamp hold up the abort or the exit', async () => {
    vi.useFakeTimers();
    try {
      const server = {
        close: vi.fn((callback: (error?: Error) => void) => callback()),
      } as unknown as ServerType;
      const abortTurns = vi.fn().mockResolvedValue(0);
      const exitProcess = vi.fn() as unknown as (code?: number) => never;

      const shutdown = gracefullyShutdownApi(server, 'SIGTERM', {
        abortTurns,
        beginDrain: vi.fn(),
        // A blocked database: the stamp never settles.
        markTurnsShutdown: vi.fn(() => new Promise<number>(() => {})),
        waitForTurns: vi.fn().mockResolvedValue(0),
        drainMs: 0,
        exitProcess,
        flushSentry: vi.fn().mockResolvedValue(undefined),
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(abortTurns).toHaveBeenCalledOnce();
      expect(exitProcess).not.toHaveBeenCalled();
      // The stamp's own grace passes and shutdown finishes regardless.
      await vi.advanceTimersByTimeAsync(2_000);
      await shutdown;
      expect(exitProcess).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains active Fast turns before aborting the stragglers', async () => {
    let finishClose: ((error?: Error) => void) | undefined;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        finishClose = callback;
      }),
    } as unknown as ServerType;
    const beginDrain = vi.fn();
    let finishDrain: ((remaining: number) => void) | undefined;
    const waitForTurns = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finishDrain = resolve;
        }),
    );
    const abortTurns = vi.fn().mockResolvedValue(1);
    const exitProcess = vi.fn() as unknown as (code?: number) => never;
    const flushSentry = vi.fn().mockResolvedValue(undefined);
    const logWarn = vi.fn();

    const shutdown = gracefullyShutdownApi(server, 'SIGTERM', {
      abortTurns,
      beginDrain,
      waitForTurns,
      drainMs: 12_345,
      exitProcess,
      flushSentry,
      logWarn,
    });

    // Admissions close and the drain starts immediately; nothing is aborted
    // while in-flight turns still have time to finish on their own.
    expect(beginDrain).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'FastAgentProcessShutdownError',
        signal: 'SIGTERM',
      }),
    );
    expect(server.close).toHaveBeenCalledOnce();
    expect(waitForTurns).toHaveBeenCalledWith(12_345);
    expect(abortTurns).not.toHaveBeenCalled();

    finishDrain?.(1);
    await vi.waitFor(() => expect(abortTurns).toHaveBeenCalledOnce());
    expect(abortTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'FastAgentProcessShutdownError',
        signal: 'SIGTERM',
      }),
    );
    expect(logWarn).toHaveBeenCalledWith(
      '[api] Aborting 1 Fast turn(s) still active after the 12345ms shutdown drain.',
    );

    finishClose?.();
    await shutdown;

    expect(flushSentry).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('stays quiet when every turn settles inside the drain window', async () => {
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback()),
    } as unknown as ServerType;
    const abortTurns = vi.fn().mockResolvedValue(0);
    const exitProcess = vi.fn() as unknown as (code?: number) => never;
    const logWarn = vi.fn();

    await gracefullyShutdownApi(server, 'SIGTERM', {
      abortTurns,
      beginDrain: vi.fn(),
      waitForTurns: vi.fn().mockResolvedValue(0),
      drainMs: 20_000,
      exitProcess,
      logWarn,
    });

    expect(logWarn).not.toHaveBeenCalled();
    expect(abortTurns).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('exits unsuccessfully when the HTTP server cannot close', async () => {
    const closeError = new Error('close failed');
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback(closeError)),
    } as unknown as ServerType;
    const abortTurns = vi.fn().mockResolvedValue(0);
    const exitProcess = vi.fn() as unknown as (code?: number) => never;
    const flushSentry = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();

    await gracefullyShutdownApi(server, 'SIGINT', {
      abortTurns,
      beginDrain: vi.fn(),
      waitForTurns: vi.fn().mockResolvedValue(0),
      drainMs: 0,
      exitProcess,
      flushSentry,
      logError,
    });

    expect(logError).toHaveBeenCalledWith(
      '[api] Graceful shutdown failed',
      closeError,
    );
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'forces exit when %s arrives again during shutdown',
    (signal) => {
      const server = { close: vi.fn() } as unknown as ServerType;
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
        const cleanup = installApiGracefulShutdown(server, {
          abortTurns: vi.fn(() => new Promise<number>(() => undefined)),
          beginDrain: vi.fn(),
          waitForTurns: vi.fn(() => new Promise<number>(() => undefined)),
          exitProcess,
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
