import type { RunTokenContext } from '@roomote/types';

import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

const { mockScrubSandboxSecretsBeforeSnapshot } = vi.hoisted(() => ({
  mockScrubSandboxSecretsBeforeSnapshot: vi.fn(),
}));

vi.mock('../../../commands/utils/scrub-sandbox-secrets', () => ({
  scrubSandboxSecretsBeforeSnapshot: mockScrubSandboxSecretsBeforeSnapshot,
}));

function createCaller(
  options: { harnessLogger?: Context['harnessLogger'] } = {},
) {
  const ctx = {
    workingDirectory: '/tmp',
    harness: { isConnected: true },
    harnessLogger: options.harnessLogger,
    auth: {
      runId: 1,
      userId: null,
      principal: 'deployment',
      tokenType: 'run',
      version: 1,
    } satisfies RunTokenContext,
    runId: 1,
  } as unknown as Context;

  return appRouter.createCaller(ctx);
}

describe('scrubSnapshotSecrets procedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the pre-snapshot scrub with the harness logger', async () => {
    const harnessLogger = {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as NonNullable<Context['harnessLogger']>;
    const caller = createCaller({ harnessLogger });

    const result = await caller.commands.scrubSnapshotSecrets();

    expect(result).toEqual({ success: true });
    expect(mockScrubSandboxSecretsBeforeSnapshot).toHaveBeenCalledTimes(1);
    expect(mockScrubSandboxSecretsBeforeSnapshot).toHaveBeenCalledWith(
      harnessLogger,
    );
  });

  it('falls back to console when no harness logger is available', async () => {
    const caller = createCaller();

    const result = await caller.commands.scrubSnapshotSecrets();

    expect(result).toEqual({ success: true });
    expect(mockScrubSandboxSecretsBeforeSnapshot).toHaveBeenCalledWith(console);
  });

  it('propagates scrub failures to the caller', async () => {
    mockScrubSandboxSecretsBeforeSnapshot.mockImplementation(() => {
      throw new Error('scrub exploded');
    });
    const caller = createCaller();

    await expect(caller.commands.scrubSnapshotSecrets()).rejects.toThrow(
      'scrub exploded',
    );
  });
});
