import {
  classifyFastAgentStorageExhaustion,
  inspectFastAgentStorageFullError,
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

  it('reports the affected path, filesystem capacity, and syscall', () => {
    const error = Object.assign(new Error('ENOSPC: write failed'), {
      code: 'ENOSPC',
      path: '/tmp/roomote-fast-opencode/session/opencode.json',
      syscall: 'write',
    });

    expect(inspectFastAgentStorageFullError(error)).toMatchObject({
      affectedPath: '/tmp/roomote-fast-opencode/session/opencode.json',
      filesystemPath: '/tmp',
      syscall: 'write',
      availableBytes: expect.any(BigInt),
      availableInodes: expect.any(BigInt),
      totalInodes: expect.any(BigInt),
    });
  });
});
