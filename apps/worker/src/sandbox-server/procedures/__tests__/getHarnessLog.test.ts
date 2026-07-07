import type { Mock } from 'vitest';

import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

const HARNESS_LOG_PATH = '/tmp/harness.log';

function createCaller() {
  const ctx = {
    workingDirectory: '/tmp',
    harness: {
      isConnected: true,
      sendCommand: vi.fn(() => true),
      getPendingUserInputRequests: vi.fn(() => []),
    },
  } as unknown as Context;

  return appRouter.createCaller(ctx);
}

describe('getHarnessLog procedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the requested tail of the harness log', async () => {
    mockReadFile.mockResolvedValueOnce(
      ['one', 'two', 'three', 'four'].join('\n'),
    );

    const result = await createCaller().commands.getHarnessLog({
      lineLimit: 2,
    });

    expect(mockReadFile).toHaveBeenCalledWith(HARNESS_LOG_PATH, 'utf8');
    expect(result).toEqual({
      path: HARNESS_LOG_PATH,
      exists: true,
      requestedLines: 2,
      returnedLines: 2,
      lines: ['three', 'four'],
    });
  });

  it('returns exists=false when the harness log has not been created yet', async () => {
    const notFoundError = Object.assign(new Error('missing'), {
      code: 'ENOENT',
    });
    (mockReadFile as Mock).mockRejectedValueOnce(notFoundError);

    const result = await createCaller().commands.getHarnessLog({
      lineLimit: 5,
    });

    expect(result).toEqual({
      path: HARNESS_LOG_PATH,
      exists: false,
      requestedLines: 5,
      returnedLines: 0,
      lines: [],
    });
  });
});
