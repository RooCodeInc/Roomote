import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockTaskRunsFindFirst,
  mockUpdate,
  mockCreateSourceControlTokenForTaskRun,
} = vi.hoisted(() => ({
  mockTaskRunsFindFirst: vi.fn(),
  mockUpdate: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => undefined),
    })),
  })),
  mockCreateSourceControlTokenForTaskRun: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: (...args: unknown[]) => mockTaskRunsFindFirst(...args),
      },
    },
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  taskRuns: { id: 'taskRuns.id' },
  eq: vi.fn(),
}));

vi.mock('../dequeue-helpers', () => ({
  createSourceControlTokenForTaskRun: (...args: unknown[]) =>
    mockCreateSourceControlTokenForTaskRun(...args),
}));

import { refreshGitHubTokenWithMetadata } from '../refresh-github-token';

describe('refreshGitHubTokenWithMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    mockTaskRunsFindFirst.mockResolvedValue({
      id: 123,
      artifacts: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules app-backed Gitea credentials before their OAuth expiry', async () => {
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue({
      provider: 'gitea',
      token: '',
      envVar: 'GITEA_TOKEN',
      envVars: {},
      gitProxyCredentials: [],
      source: 'app',
      expiresAt: new Date('2026-08-10T12:10:00.000Z'),
    });

    const result = await refreshGitHubTokenWithMetadata({} as never, 123);

    expect(result.expiresAt).toBe('2026-08-10T12:10:00.000Z');
    expect(result.nextRefreshAt).toBe('2026-08-10T12:05:00.000Z');
  });

  it('schedules app-backed GitLab credentials before their OAuth expiry', async () => {
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue({
      provider: 'gitlab',
      token: '',
      envVar: 'GITLAB_TOKEN',
      envVars: {},
      gitProxyCredentials: [],
      source: 'app',
      expiresAt: new Date('2026-08-10T12:30:00.000Z'),
    });

    const result = await refreshGitHubTokenWithMetadata({} as never, 123);

    expect(result.expiresAt).toBe('2026-08-10T12:30:00.000Z');
    expect(result.nextRefreshAt).toBe('2026-08-10T12:25:00.000Z');
  });

  it('never schedules past the default cadence for a long-lived expiry', async () => {
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue({
      provider: 'github',
      token: 'ghs_app_token',
      envVar: 'GH_TOKEN',
      envVars: { GH_TOKEN: 'ghs_app_token' },
      source: 'app',
      expiresAt: new Date('2026-08-10T14:00:00.000Z'),
    });

    const result = await refreshGitHubTokenWithMetadata({} as never, 123);

    expect(result.nextRefreshAt).toBe('2026-08-10T12:45:00.000Z');
  });

  it('scales the refresh buffer to a token that lives less than the buffer', async () => {
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue({
      provider: 'gitlab',
      token: 'oauth_access_token',
      envVar: 'GITLAB_TOKEN',
      envVars: {},
      source: 'app',
      expiresAt: new Date('2026-08-10T12:05:00.000Z'),
    });

    const result = await refreshGitHubTokenWithMetadata({} as never, 123);

    expect(result.nextRefreshAt).toBe('2026-08-10T12:03:45.000Z');
  });

  it('keeps the default interval for credentials without an expiry', async () => {
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue({
      provider: 'github',
      token: 'github-token',
      envVar: 'GH_TOKEN',
      envVars: { GH_TOKEN: 'github-token' },
      source: 'app',
      expiresAt: null,
    });

    const result = await refreshGitHubTokenWithMetadata({} as never, 123);

    expect(result.nextRefreshAt).toBe('2026-08-10T12:45:00.000Z');
  });
});
