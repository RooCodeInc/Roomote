import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import type { StreamChunk } from '../../types';

import { CommandExecutor, type StreamHandle } from '../../lib/command-executor';

/**
 * Integration tests for the multiplexed tail pattern used by tailMulti.
 * Tests the core behavior (tagging, concurrent streams, cleanup) by
 * exercising CommandExecutor.tailStream the same way the procedure does.
 */
describe('tailMulti multiplexing pattern', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tailMulti-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should tag chunks from multiple files with their originating filePath', async () => {
    // Create two files with distinct content.
    const file1 = 'file1.log';
    const file2 = 'file2.log';
    writeFileSync(join(tempDir, file1), 'alpha\nbravo\n');
    writeFileSync(join(tempDir, file2), 'charlie\ndelta\n');

    const tagged: Array<StreamChunk & { filePath: string }> = [];
    const controller = new AbortController();
    const handles: StreamHandle[] = [];

    // Mimic what tailMulti does: spawn one tailStream per file, tag each chunk.
    for (const filePath of [file1, file2]) {
      const handle = CommandExecutor.tailStream(filePath, {
        cwd: tempDir,
        timeout: 0,
        signal: controller.signal,
        onChunk: (chunk) => {
          tagged.push({ ...chunk, filePath });
        },
      });

      handles.push(handle);
    }

    // Wait for initial output from both files.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Kill all handles.
    controller.abort();

    for (const handle of handles) {
      handle.kill();
    }

    await Promise.all(handles.map((h) => h.promise));

    // Verify we got stdout chunks from BOTH files.
    const file1Chunks = tagged.filter(
      (c) => c.filePath === file1 && c.type === 'stdout',
    );
    const file2Chunks = tagged.filter(
      (c) => c.filePath === file2 && c.type === 'stdout',
    );

    expect(file1Chunks.length).toBeGreaterThan(0);
    expect(file2Chunks.length).toBeGreaterThan(0);

    // Verify the data is correctly associated with each file.
    const file1Data = file1Chunks.map((c) => c.data).join('');
    const file2Data = file2Chunks.map((c) => c.data).join('');

    expect(file1Data).toContain('alpha');
    expect(file1Data).toContain('bravo');
    expect(file2Data).toContain('charlie');
    expect(file2Data).toContain('delta');

    // Verify we got exit chunks for both files.
    const exitChunks = tagged.filter((c) => c.type === 'exit');
    expect(exitChunks.length).toBe(2);
  });

  it('should clean up earlier handles when a later tailStream call throws', () => {
    writeFileSync(join(tempDir, 'good.log'), 'content\n');

    const mockKill = vi.fn();
    const mockPromise = Promise.resolve();

    // First call succeeds, second call throws.
    const spy = vi
      .spyOn(CommandExecutor, 'tailStream')
      .mockReturnValueOnce({ kill: mockKill, promise: mockPromise })
      .mockImplementationOnce(() => {
        throw new Error('spawn failed');
      });

    const controller = new AbortController();
    const handles: StreamHandle[] = [];

    // Replicate the try-catch pattern from tailMulti.
    expect(() => {
      try {
        for (const filePath of ['good.log', 'bad.log']) {
          const handle = CommandExecutor.tailStream(filePath, {
            cwd: tempDir,
            timeout: 0,
            signal: controller.signal,
            onChunk: () => {},
          });

          handles.push(handle);
        }
      } catch (err) {
        controller.abort();

        for (const handle of handles) {
          handle.kill();
        }

        throw err;
      }
    }).toThrow('spawn failed');

    // The first handle's kill() should have been called during cleanup.
    expect(mockKill).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it('should NOT clean up handles without try-catch when a later call throws', () => {
    // This test verifies that WITHOUT the try-catch, the bug exists.
    // It demonstrates why the fix matters.
    const mockKill = vi.fn();
    const mockPromise = Promise.resolve();

    const spy = vi
      .spyOn(CommandExecutor, 'tailStream')
      .mockReturnValueOnce({ kill: mockKill, promise: mockPromise })
      .mockImplementationOnce(() => {
        throw new Error('spawn failed');
      });

    const handles: StreamHandle[] = [];

    // Without try-catch (the bug this PR fixes):
    expect(() => {
      for (const filePath of ['good.log', 'bad.log']) {
        const handle = CommandExecutor.tailStream(filePath, {
          cwd: tempDir,
          timeout: 0,
          signal: new AbortController().signal,
          onChunk: () => {},
        });

        handles.push(handle);
      }
    }).toThrow('spawn failed');

    // Without try-catch, kill is never called -- handles leak.
    expect(mockKill).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});
