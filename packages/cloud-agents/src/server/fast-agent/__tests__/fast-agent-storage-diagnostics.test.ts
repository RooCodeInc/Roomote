import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyFastAgentStorageExhaustion,
  inspectFastAgentStorageFullError,
  isFastAgentStorageFullError,
} from '../fast-agent-storage-diagnostics';

describe('Fast storage diagnostics', () => {
  it.each([
    [0n, 10n, 100n, 'bytes_exhausted'],
    [10n, 0n, 100n, 'inodes_exhausted'],
    [0n, 0n, 100n, 'bytes_and_inodes_exhausted'],
    [10n, 10n, 100n, 'quota_or_limit'],
    [10n, 0n, 0n, 'quota_or_limit'],
  ] as const)(
    'classifies %s available bytes and %s of %s available inodes as %s',
    (availableBytes, availableInodes, totalInodes, expected) => {
      expect(
        classifyFastAgentStorageExhaustion({
          availableBytes,
          availableInodes,
          totalInodes,
        }),
      ).toBe(expected);
    },
  );

  it('ignores undefined and other non-storage rejection values', () => {
    expect(isFastAgentStorageFullError(undefined)).toBe(false);
    expect(isFastAgentStorageFullError({ reason: 'provider failed' })).toBe(
      false,
    );
  });

  it('reports the affected path, filesystem capacity, and syscall', () => {
    const filesystemPath = mkdtempSync(
      join(tmpdir(), 'fast-storage-diagnostics-'),
    );
    const affectedPath = join(filesystemPath, 'session', 'opencode.json');
    const error = Object.assign(new Error('ENOSPC: write failed'), {
      code: 'ENOSPC',
      path: affectedPath,
      syscall: 'write',
    });

    try {
      expect(inspectFastAgentStorageFullError(error)).toMatchObject({
        affectedPath,
        filesystemPath,
        syscall: 'write',
        availableBytes: expect.any(BigInt),
        availableInodes: expect.any(BigInt),
        totalInodes: expect.any(BigInt),
      });
    } finally {
      rmSync(filesystemPath, { recursive: true, force: true });
    }
  });
});
