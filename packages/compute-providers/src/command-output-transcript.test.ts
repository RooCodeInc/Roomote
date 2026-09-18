import { createCommandOutputTranscriptRecorder } from './command-output-transcript';

describe('createCommandOutputTranscriptRecorder', () => {
  it('formats timestamped command output and sanitizes NUL bytes', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const recorder = createCommandOutputTranscriptRecorder({
      write,
      clock: () => new Date('2026-09-02T12:00:00.000Z'),
    });

    void recorder.append('stdout', 'ready\0 now\n');
    await recorder.append('command', 'worker exited with code 0');

    expect(write).toHaveBeenCalledWith(
      '[2026-09-02T12:00:00.000Z] [stdout] ready now\n' +
        '[2026-09-02T12:00:00.000Z] [command] worker exited with code 0\n',
      256 * 1024,
    );
  });

  it('bounds buffered output while retaining the newest text', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const recorder = createCommandOutputTranscriptRecorder({
      write,
      maxChars: 100,
      flushSize: 1_000,
      clock: () => new Date('2026-09-02T12:00:00.000Z'),
    });

    void recorder.append('stdout', `${'x'.repeat(200)}LATEST\n`);
    await recorder.flush();

    const [entries, maxChars] = write.mock.calls[0]!;
    expect(entries.length).toBeLessThanOrEqual(100);
    expect(entries).toContain('LATEST\n');
    expect(maxChars).toBe(100);
  });

  it('keeps accepting output after a storage failure', async () => {
    const onWriteError = vi.fn();
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(undefined);
    const recorder = createCommandOutputTranscriptRecorder({
      write,
      onWriteError,
      clock: () => new Date('2026-09-02T12:00:00.000Z'),
    });

    await recorder.append('command', 'first');
    await recorder.append('command', 'second');

    expect(onWriteError).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
