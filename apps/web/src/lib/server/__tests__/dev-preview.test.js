import { EventEmitter } from 'node:events';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), warm: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../../../scripts/warm-dev-preview.mjs', () => ({
  warmDevPreview: mocks.warm,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('preview dev server lifecycle', () => {
  it('starts warmup concurrently and forwards shutdown without changing the server exit code', async () => {
    const server = new EventEmitter();
    server.kill = vi.fn();
    mocks.spawn.mockReturnValue(server);
    mocks.warm.mockImplementation(() => new Promise(() => {}));
    const on = vi.spyOn(process, 'on');
    const previousCode = process.exitCode;
    try {
      await import('../../../../scripts/dev-preview.mjs');
      expect(mocks.spawn).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining(['dev', '--turbopack', '--port']),
        { stdio: 'inherit' },
      );
      const { signal } = mocks.warm.mock.lastCall[0];
      const stop = on.mock.calls.find(([name]) => name === 'SIGTERM')[1];
      stop('SIGTERM');
      expect(server.kill).toHaveBeenCalledWith('SIGTERM');
      expect(signal.aborted).toBe(true);
      server.emit('close', 7, null);
      expect(process.exitCode).toBe(7);
      expect(process.listeners('SIGTERM')).not.toContain(stop);
    } finally {
      server.emit('close', 0, null);
      process.exitCode = previousCode;
    }
  });

  it('keeps the dev server alive after warmup fails and preserves signal termination', async () => {
    const server = new EventEmitter();
    server.kill = vi.fn();
    mocks.spawn.mockReturnValue(server);
    mocks.warm.mockRejectedValue(new Error('warmup unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await import('../../../../scripts/dev-preview.mjs');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dev server is still running'),
    );
    expect(server.kill).not.toHaveBeenCalled();
    server.emit('close', null, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });
});
