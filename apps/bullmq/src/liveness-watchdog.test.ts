import { describe, expect, it, vi } from 'vitest';

import {
  BULLMQ_WATCHDOG_STALE_MS,
  startBullMqLivenessWatchdog,
} from './liveness-watchdog';

type Listener = (...args: unknown[]) => void;

function createWorker() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

describe('startBullMqLivenessWatchdog', () => {
  it('exits when the worker finishes no job for longer than the stale window', () => {
    vi.useFakeTimers();
    try {
      const worker = createWorker();
      const exitProcess = vi.fn();
      const onStale = vi.fn();
      startBullMqLivenessWatchdog({
        worker: worker as never,
        redisStatus: () => 'ready',
        exitProcess,
        onStale,
        logError: () => {},
      });

      vi.advanceTimersByTime(BULLMQ_WATCHDOG_STALE_MS);
      expect(exitProcess).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expect(exitProcess).toHaveBeenCalledWith(1);
      expect(onStale).toHaveBeenCalledWith(
        expect.objectContaining({ staleMs: BULLMQ_WATCHDOG_STALE_MS }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays quiet while jobs keep completing', () => {
    vi.useFakeTimers();
    try {
      const worker = createWorker();
      const exitProcess = vi.fn();
      startBullMqLivenessWatchdog({
        worker: worker as never,
        redisStatus: () => 'ready',
        exitProcess,
        logError: () => {},
      });

      for (let minute = 0; minute < 30; minute++) {
        vi.advanceTimersByTime(60_000);
        worker.emit(minute % 2 === 0 ? 'completed' : 'failed');
      }

      expect(exitProcess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not blame the worker while Redis is not ready', () => {
    vi.useFakeTimers();
    try {
      const worker = createWorker();
      const exitProcess = vi.fn();
      let status = 'reconnecting';
      startBullMqLivenessWatchdog({
        worker: worker as never,
        redisStatus: () => status,
        exitProcess,
        logError: () => {},
      });

      vi.advanceTimersByTime(BULLMQ_WATCHDOG_STALE_MS + 10 * 60_000);
      expect(exitProcess).not.toHaveBeenCalled();

      // Once Redis is back and the worker still does nothing, it exits.
      status = 'ready';
      vi.advanceTimersByTime(60_000);
      expect(exitProcess).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops cleanly and detaches its listeners', () => {
    vi.useFakeTimers();
    try {
      const worker = createWorker();
      const exitProcess = vi.fn();
      const watchdog = startBullMqLivenessWatchdog({
        worker: worker as never,
        redisStatus: () => 'ready',
        exitProcess,
        logError: () => {},
      });

      watchdog.stop();
      expect(worker.listenerCount('completed')).toBe(0);
      expect(worker.listenerCount('failed')).toBe(0);

      vi.advanceTimersByTime(BULLMQ_WATCHDOG_STALE_MS + 5 * 60_000);
      expect(exitProcess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
