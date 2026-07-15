import type { Mock } from 'vitest';

import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

const { mockReadEnvironmentSetupStatus } = vi.hoisted(() => ({
  mockReadEnvironmentSetupStatus: vi.fn(),
}));

vi.mock(
  '../../../commands/setup/workspace/setup-status',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../commands/setup/workspace/setup-status')
      >();

    return {
      ...actual,
      readEnvironmentSetupStatus: mockReadEnvironmentSetupStatus,
    };
  },
);

function createCaller(workingDirectory = '/workspace') {
  const ctx = {
    workingDirectory,
    harness: {
      isConnected: true,
      sendCommand: vi.fn(() => true),
      getPendingUserInputRequests: vi.fn(() => []),
    },
  } as unknown as Context;

  return appRouter.createCaller(ctx);
}

describe('getSetupStatus procedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns exists=false when setup status has not been created yet', async () => {
    (mockReadEnvironmentSetupStatus as Mock).mockReturnValueOnce(null);

    const result = await createCaller().commands.getSetupStatus();

    expect(mockReadEnvironmentSetupStatus).toHaveBeenCalledWith('/workspace');
    expect(result).toEqual({
      path: '.roomote/setup-status.json',
      exists: false,
      status: null,
    });
  });

  it('returns the parsed setup status when present', async () => {
    const status = {
      version: 1 as const,
      state: 'running' as const,
      startedAt: '2026-07-14T00:00:00.000Z',
      commands: [
        {
          repository: 'RooCodeInc/Roomote',
          name: 'Install toolchain and dependencies',
          state: 'succeeded' as const,
          logFile:
            '.roomote/setup-logs/RooCodeInc/Roomote/install-toolchain-and-dependencies.log',
        },
        {
          repository: 'RooCodeInc/Roomote',
          name: 'Install Mintlify CLI for docs',
          state: 'running' as const,
        },
      ],
      warnings: [] as string[],
    };

    (mockReadEnvironmentSetupStatus as Mock).mockReturnValueOnce(status);

    const result = await createCaller().commands.getSetupStatus();

    expect(result).toEqual({
      path: '.roomote/setup-status.json',
      exists: true,
      status,
    });
  });
});
