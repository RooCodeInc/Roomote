import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

// Use vi.hoisted so the mock fns are available when vi.mock factories execute
// (vi.mock calls are hoisted above all other code by vitest).
const {
  mockFindFirst,
  mockFetchResolvedRuntimeEnvVars,
  mockCreateSourceControlTokenForTaskRun,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFetchResolvedRuntimeEnvVars: vi.fn(),
  mockCreateSourceControlTokenForTaskRun: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: mockFindFirst,
      },
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
  taskRuns: {
    id: 'taskRuns.id',
  },
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (col: unknown, val: unknown) => ({ _eq: [col, val] }),
}));

vi.mock('../dequeue-helpers', () => ({
  fetchResolvedRuntimeEnvVars: mockFetchResolvedRuntimeEnvVars,
  createSourceControlTokenForTaskRun: mockCreateSourceControlTokenForTaskRun,
}));

import { fetchSnapshotEnv } from '../fetch-snapshot-env';

// A minimal Run-like object for test fixtures.
function makeTaskRun(overrides: Record<string, unknown> = {}) {
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
  });

  // ── Happy path: deployment-scoped env vars ───────────────────────────

  it('returns envVars and source control token metadata for authenticated snapshot env requests', async () => {
    const auth: AuthTokenContext = {
      userId: 'user_456',
      tokenType: 'auth',
      version: 1,
    };

    const taskRun = makeTaskRun();
    mockFindFirst.mockResolvedValue(taskRun);
    mockFetchResolvedRuntimeEnvVars.mockResolvedValue({
      MY_SECRET: 'value123',
    });
    const token = makeGitHubToken('ghs_token_abc');
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue(token);

    const result = await fetchSnapshotEnv(auth, { runId: 42 });

    expect(result).toEqual({
      envVars: { MY_SECRET: 'value123' },
      gitHubToken: 'ghs_token_abc',
      sourceControlToken: token,
      taskId: 'task_123',
    });

    // Verify db.query was called.
    expect(mockFindFirst).toHaveBeenCalledOnce();

    // Verify the gateway-aware resolution was used (so snapshot env withholds
    // gateway-served provider keys, like the task dequeue path).
    expect(mockFetchResolvedRuntimeEnvVars).toHaveBeenCalledWith(undefined, {
      sourceControlProvider: 'github',
    });

    // Verify createSourceControlTokenForTaskRun was called with the task run.
    expect(mockCreateSourceControlTokenForTaskRun).toHaveBeenCalledWith(
      taskRun,
      '[fetchSnapshotEnv]',
    );
  });

  // ── Happy path: run-scoped auth (RunTokenContext) ────────────────────

  it('returns envVars and source control token metadata for a RunTokenContext', async () => {
    const auth: RunTokenContext = {
      runId: 42,
      userId: 'user_789',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    };

    const taskRun = makeTaskRun();
    mockFindFirst.mockResolvedValue(taskRun);
    mockFetchResolvedRuntimeEnvVars.mockResolvedValue({});
    const token = makeGitHubToken('ghs_job_token');
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue(token);

    const result = await fetchSnapshotEnv(auth, { runId: 42 });

    expect(result).toEqual({
      envVars: {},
      gitHubToken: 'ghs_job_token',
      sourceControlToken: token,
      taskId: 'task_123',
    });

    expect(mockFetchResolvedRuntimeEnvVars).toHaveBeenCalledWith(undefined, {
      sourceControlProvider: 'github',
    });
  });

  // ── Task run not found ──────────────────────────────────────────────

  it('throws when the task run is not found', async () => {
    const auth: AuthTokenContext = {
      userId: 'user_456',
      tokenType: 'auth',
      version: 1,
    };

    mockFindFirst.mockResolvedValue(undefined);

    await expect(fetchSnapshotEnv(auth, { runId: 999 })).rejects.toThrow(
      '[fetchSnapshotEnv] Task run not found: 999',
    );

    // Should not have called downstream helpers.
    expect(mockFetchResolvedRuntimeEnvVars).not.toHaveBeenCalled();
    expect(mockCreateSourceControlTokenForTaskRun).not.toHaveBeenCalled();
  });

  // ── No env vars configured ──────────────────────────────────────────

  it('returns empty envVars when no environment variables are configured', async () => {
    const auth: AuthTokenContext = {
      userId: 'user_456',
      tokenType: 'auth',
      version: 1,
    };

    mockFindFirst.mockResolvedValue(makeTaskRun());
    mockFetchResolvedRuntimeEnvVars.mockResolvedValue({});
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue(
      makeGitHubToken('ghs_token_xyz'),
    );

    const result = await fetchSnapshotEnv(auth, { runId: 42 });

    expect(result.envVars).toEqual({});
    expect(result.gitHubToken).toBe('ghs_token_xyz');
    expect(result.taskId).toBe('task_123');
  });

  // ── Source-control token creation fails ─────────────────────────────

  it('throws when createSourceControlTokenForTaskRun returns null', async () => {
    const auth: AuthTokenContext = {
      userId: 'user_456',
      tokenType: 'auth',
      version: 1,
    };

    mockFindFirst.mockResolvedValue(makeTaskRun());
    mockFetchResolvedRuntimeEnvVars.mockResolvedValue({ KEY: 'val' });
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue(null);

    await expect(fetchSnapshotEnv(auth, { runId: 42 })).rejects.toThrow(
      '[fetchSnapshotEnv] Failed to create source control token for task run 42',
    );
  });
});
