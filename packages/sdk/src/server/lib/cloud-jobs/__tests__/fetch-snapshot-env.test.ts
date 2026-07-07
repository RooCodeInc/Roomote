import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

// Use vi.hoisted so the mock fns are available when vi.mock factories execute
// (vi.mock calls are hoisted above all other code by vitest).
const {
  mockFindFirst,
  mockTransaction,
  mockFetchEnvVars,
  mockCreateSourceControlTokenForJob,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
  mockFetchEnvVars: vi.fn(),
  mockCreateSourceControlTokenForJob: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      cloudJobs: {
        findFirst: mockFindFirst,
      },
    },
    transaction: mockTransaction,
  },
  cloudJobs: {
    id: 'cloudJobs.id',
    userId: 'cloudJobs.userId',
  },
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (col: unknown, val: unknown) => ({ _eq: [col, val] }),
}));

vi.mock('../dequeue-helpers', () => ({
  fetchEnvVars: mockFetchEnvVars,
  createSourceControlTokenForJob: mockCreateSourceControlTokenForJob,
}));

import { fetchSnapshotEnv } from '../fetch-snapshot-env';

// A minimal CloudJob-like object for test fixtures.
function makeCloudJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    taskId: 'task_123',
    userId: 'user_456',
    type: 'Task',
    status: 'Processing',
    payload: {},
    ...overrides,
  };
}

function makeGitHubToken(token: string) {
  return {
    provider: 'github',
    token,
    envVar: 'GH_TOKEN',
    envVars: { GH_TOKEN: token },
    source: 'app',
    expiresAt: null,
  };
}

describe('fetchSnapshotEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // By default, db.transaction calls the callback with a fake tx.
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ fake: 'tx' }),
    );
  });

  // ── Happy path: deployment-scoped env vars ───────────────────────────

  it('returns envVars and source control token metadata for authenticated snapshot env requests', async () => {
    const auth: AuthTokenContext = {
      userId: 'user_456',
      tokenType: 'auth',
      version: 1,
    };

    const cloudJob = makeCloudJob();
    mockFindFirst.mockResolvedValue(cloudJob);
    mockFetchEnvVars.mockResolvedValue({ MY_SECRET: 'value123' });
    const token = makeGitHubToken('ghs_token_abc');
    mockCreateSourceControlTokenForJob.mockResolvedValue(token);

    const result = await fetchSnapshotEnv(auth, { cloudJobId: 42 });

    expect(result).toEqual({
      envVars: { MY_SECRET: 'value123' },
      gitHubToken: 'ghs_token_abc',
      sourceControlToken: token,
      taskId: 'task_123',
    });

    // Verify db.query was called.
    expect(mockFindFirst).toHaveBeenCalledOnce();

    // Verify fetchEnvVars was called inside a transaction.
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(mockFetchEnvVars).toHaveBeenCalledWith(
      { fake: 'tx' },
      { sourceControlProvider: 'github' },
    );

    // Verify createSourceControlTokenForJob was called with the cloud job.
    expect(mockCreateSourceControlTokenForJob).toHaveBeenCalledWith(
      cloudJob,
      '[fetchSnapshotEnv]',
    );
  });

  // ── Happy path: job-scoped auth (JobTokenContext) ────────────────────

  it('returns envVars and source control token metadata for a JobTokenContext', async () => {
    const auth: JobTokenContext = {
      cloudJobId: 42,
      userId: 'user_789',
      tokenType: 'cj',
      version: 1,
    };

    const cloudJob = makeCloudJob();
    mockFindFirst.mockResolvedValue(cloudJob);
    mockFetchEnvVars.mockResolvedValue({});
    const token = makeGitHubToken('ghs_job_token');
    mockCreateSourceControlTokenForJob.mockResolvedValue(token);

    const result = await fetchSnapshotEnv(auth, { cloudJobId: 42 });

    expect(result).toEqual({
      envVars: {},
      gitHubToken: 'ghs_job_token',
      sourceControlToken: token,
      taskId: 'task_123',
    });

    expect(mockFetchEnvVars).toHaveBeenCalledWith(
      { fake: 'tx' },
      { sourceControlProvider: 'github' },
    );
  });

  // ── Cloud job not found ──────────────────────────────────────────────

  it('throws when the cloud job is not found', async () => {
    const auth: AuthTokenContext = {
      userId: 'user_456',
      tokenType: 'auth',
      version: 1,
    };

    mockFindFirst.mockResolvedValue(undefined);

    await expect(fetchSnapshotEnv(auth, { cloudJobId: 999 })).rejects.toThrow(
      '[fetchSnapshotEnv] Cloud job not found: 999',
    );

    // Should not have called downstream helpers.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockCreateSourceControlTokenForJob).not.toHaveBeenCalled();
  });

  // ── No env vars configured ──────────────────────────────────────────

  it('returns empty envVars when no environment variables are configured', async () => {
    const auth: AuthTokenContext = {
      userId: 'user_456',
      tokenType: 'auth',
      version: 1,
    };

    mockFindFirst.mockResolvedValue(makeCloudJob());
    mockFetchEnvVars.mockResolvedValue({});
    mockCreateSourceControlTokenForJob.mockResolvedValue(
      makeGitHubToken('ghs_token_xyz'),
    );

    const result = await fetchSnapshotEnv(auth, { cloudJobId: 42 });

    expect(result.envVars).toEqual({});
    expect(result.gitHubToken).toBe('ghs_token_xyz');
    expect(result.taskId).toBe('task_123');
  });

  // ── Source-control token creation fails ─────────────────────────────

  it('throws when createSourceControlTokenForJob returns null', async () => {
    const auth: AuthTokenContext = {
      userId: 'user_456',
      tokenType: 'auth',
      version: 1,
    };

    mockFindFirst.mockResolvedValue(makeCloudJob());
    mockFetchEnvVars.mockResolvedValue({ KEY: 'val' });
    mockCreateSourceControlTokenForJob.mockResolvedValue(null);

    await expect(fetchSnapshotEnv(auth, { cloudJobId: 42 })).rejects.toThrow(
      '[fetchSnapshotEnv] Failed to create source control token for cloud job 42',
    );
  });
});
