import {
  engageCredentialWriteBarrier,
  resetCredentialWriteBarrierForTesting,
} from '../../lib/credential-write-barrier';

import { createGitHubTokenRefreshInterval } from './github-token-refresh';

const {
  mockRefreshGitHubTokenWithMetadata,
  mockApplyMetadata,
  mockEnsureFiles,
} = vi.hoisted(() => ({
  mockRefreshGitHubTokenWithMetadata: vi.fn(),
  mockApplyMetadata: vi.fn(),
  mockEnsureFiles: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      refreshGitHubTokenWithMetadata: mockRefreshGitHubTokenWithMetadata,
    },
  },
}));

vi.mock('../../lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib')>();

  return {
    ...actual,
    applySourceControlTokenMetadata: mockApplyMetadata,
    ensureSourceControlTokenEnvFiles: mockEnsureFiles,
  };
});

function createLogger() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never;
}

async function flushAsync() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('createGitHubTokenRefreshInterval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCredentialWriteBarrierForTesting();
    mockRefreshGitHubTokenWithMetadata.mockResolvedValue({
      provider: 'github',
      source: 'app',
      expiresAt: null,
      nextRefreshAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    });
  });

  it('refreshes and writes token files while the barrier is disengaged', async () => {
    const interval = createGitHubTokenRefreshInterval({
      runId: 7,
      logger: createLogger(),
    });

    await flushAsync();
    clearInterval(interval);

    expect(mockRefreshGitHubTokenWithMetadata).toHaveBeenCalledWith({
      runId: 7,
    });
    expect(mockEnsureFiles).toHaveBeenCalled();
    expect(mockApplyMetadata).toHaveBeenCalled();
  });

  it('skips refreshes once the credential write barrier is engaged', async () => {
    await engageCredentialWriteBarrier();

    const interval = createGitHubTokenRefreshInterval({
      runId: 7,
      logger: createLogger(),
    });

    await flushAsync();
    clearInterval(interval);

    expect(mockRefreshGitHubTokenWithMetadata).not.toHaveBeenCalled();
    expect(mockEnsureFiles).not.toHaveBeenCalled();
    expect(mockApplyMetadata).not.toHaveBeenCalled();
  });
});
