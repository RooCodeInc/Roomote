import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindFirst,
  mockUpdate,
  mockCreateSourceControlTokenForTaskRun,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn() as ReturnType<typeof vi.fn>,
  mockUpdate: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => undefined),
    })),
  })) as ReturnType<typeof vi.fn>,
  mockCreateSourceControlTokenForTaskRun: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: mockFindFirst,
      },
    },
    update: mockUpdate,
  },
  taskRuns: { id: 'task_runs.id' },
  eq: (left: unknown, right: unknown) => ({ left, right }),
}));

vi.mock('../dequeue-helpers', () => ({
  createSourceControlTokenForTaskRun: mockCreateSourceControlTokenForTaskRun,
}));

import { refreshGitHubTokenWithMetadata } from '../refresh-github-token';

describe('refreshGitHubTokenWithMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue({
      id: 42,
      artifacts: {},
    });
  });

  it('schedules the next refresh from token expiry for app-sourced OAuth tokens', async () => {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue({
      provider: 'gitlab',
      token: 'oauth_access_token',
      envVar: 'GITLAB_TOKEN',
      envVars: {},
      gitProxyCredentials: [
        {
          provider: 'gitlab',
          host: 'gitlab.com',
          repositoryFullName: 'group/project',
          username: 'oauth2',
          token: 'oauth_access_token',
        },
      ],
      source: 'app',
      expiresAt,
      artifactsPatch: { gitlabScopedProjectTokens: [] },
    });

    const result = await refreshGitHubTokenWithMetadata(
      { type: 'run', runId: 42 } as never,
      42,
    );

    const nextRefreshAtMs = Date.parse(result.nextRefreshAt);
    expect(nextRefreshAtMs).toBeGreaterThan(Date.now());
    expect(nextRefreshAtMs).toBeLessThanOrEqual(
      expiresAt.getTime() - 4 * 60 * 1000,
    );
    expect(nextRefreshAtMs).toBeGreaterThanOrEqual(
      expiresAt.getTime() - 6 * 60 * 1000,
    );
    expect(result.provider).toBe('gitlab');
    expect(result.expiresAt).toBe(expiresAt.toISOString());
  });

  it('keeps the default cadence when expiry is unknown', async () => {
    const before = Date.now();
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue({
      provider: 'github',
      token: 'ghs_app_token',
      envVar: 'GH_TOKEN',
      envVars: { GH_TOKEN: 'ghs_app_token' },
      source: 'app',
      expiresAt: null,
    });

    const result = await refreshGitHubTokenWithMetadata(
      { type: 'run', runId: 42 } as never,
      42,
    );

    const nextRefreshAtMs = Date.parse(result.nextRefreshAt);
    expect(nextRefreshAtMs).toBeGreaterThanOrEqual(before + 44 * 60 * 1000);
    expect(nextRefreshAtMs).toBeLessThanOrEqual(before + 46 * 60 * 1000);
  });
});
