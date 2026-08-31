const mocks = vi.hoisted(() => ({
  abortActiveFastAgentTurns: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  abortActiveFastAgentTurns: mocks.abortActiveFastAgentTurns,
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
} from '../graceful-shutdown';

describe('gracefullyShutdownApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aborts Fast turns before waiting for active requests to close', async () => {
    let finishClose: ((error?: Error) => void) | undefined;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        finishClose = callback;
      }),
    } as unknown as ServerType;
    let finishAbort: (() => void) | undefined;
    const abortTurns = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finishAbort = () => resolve(1);
        }),
    );
    const exitProcess = vi.fn() as unknown as (code?: number) => never;
    const flushSentry = vi.fn().mockResolvedValue(undefined);

    const shutdown = gracefullyShutdownApi(server, 'SIGTERM', {
      abortTurns,
      exitProcess,
      flushSentry,
    });

    expect(abortTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'FastAgentProcessShutdownError',
        signal: 'SIGTERM',
      }),
    );
    expect(server.close).toHaveBeenCalledOnce();
    expect(exitProcess).not.toHaveBeenCalled();

    finishAbort?.();
    finishClose?.();
    await shutdown;

    expect(flushSentry).toHaveBeenCalledOnce();
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
