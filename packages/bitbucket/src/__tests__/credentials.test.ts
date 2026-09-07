import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskRun } from '@roomote/db/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';

const { mockWritableRepositories, mockRepositoriesFindMany } = vi.hoisted(
  () => ({
    mockWritableRepositories: vi.fn(),
    mockRepositoriesFindMany: vi.fn(),
  }),
);

vi.mock('@roomote/db/server', () => ({
  db: { query: { repositories: { findMany: mockRepositoriesFindMany } } },
  resolveTaskRunWritableRepositories: mockWritableRepositories,
  repositories: {
    sourceControlProvider: 'sourceControlProvider',
    isActive: 'isActive',
    fullName: 'fullName',
  },
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (left: unknown, right: unknown) => ({ left, right }),
  inArray: (left: unknown, right: unknown) => ({ left, right }),
}));

vi.mock('../oauth', () => ({
  getBitbucketOAuthConnection: vi.fn().mockResolvedValue(null),
}));

import { createTaskRunBitbucketCredentials } from '../api';

describe('createTaskRunBitbucketCredentials repository scope', () => {
  const options = {
    username: 'bot',
    token: 'token',
    baseUrl: 'https://bitbucket.org',
  };
  const taskRun = {
    id: 123,
    status: RunStatus.Dequeued,
    kind: 'fresh',
    payloadKind: TaskPayloadKind.StandardTask,
    taskId: 'task-123',
    actingUserId: 'user-123',
    result: null,
    artifacts: null,
    payload: {
      environmentId: 'env-1',
      repo: 'acme/inactive',
      selectedRepositories: ['acme/inactive'],
      repositoryProviders: { 'acme/cross-env': 'gitlab' },
      description: 'Cross-environment work',
    } as TaskRun['payload'],
  } as TaskRun;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWritableRepositories.mockResolvedValue(null);
    mockRepositoriesFindMany.mockResolvedValue([{ fullName: 'acme/inactive' }]);
  });

  it('uses cross-environment writable rows without restoring excluded inactive repositories', async () => {
    mockWritableRepositories.mockResolvedValue([
      { fullName: 'acme/cross-env', sourceControlProvider: 'bitbucket' },
      { fullName: 'acme/other-provider', sourceControlProvider: 'gitlab' },
    ]);
    const result = await createTaskRunBitbucketCredentials(taskRun, options);
    expect(
      result.credentials.map(({ repositoryFullName }) => repositoryFullName),
    ).toEqual(['acme/cross-env']);
    expect(mockWritableRepositories).toHaveBeenCalledWith(
      expect.anything(),
      taskRun,
    );
    expect(mockRepositoriesFindMany).not.toHaveBeenCalled();
  });

  it('does not fall back when the writable boundary returns no repositories', async () => {
    mockWritableRepositories.mockResolvedValue([]);
    const result = await createTaskRunBitbucketCredentials(taskRun, options);
    expect(result.credentials).toEqual([]);
    expect(mockRepositoriesFindMany).not.toHaveBeenCalled();
  });

  it('retains selected-repository filtering when the boundary returns null', async () => {
    const nonEnvironmentRun = {
      ...taskRun,
      payload: {
        repo: 'acme/backend',
        selectedRepositories: ['acme/backend', 'acme/gitlab'],
        repositoryProviders: {
          'acme/backend': 'bitbucket',
          'acme/gitlab': 'gitlab',
        },
        description: 'Selected work',
      },
    } as TaskRun;
    mockRepositoriesFindMany.mockResolvedValue([{ fullName: 'acme/backend' }]);
    const result = await createTaskRunBitbucketCredentials(
      nonEnvironmentRun,
      options,
    );
    expect(
      result.credentials.map(({ repositoryFullName }) => repositoryFullName),
    ).toEqual(['acme/backend']);
    expect(mockRepositoriesFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conditions: [
            { left: 'sourceControlProvider', right: 'bitbucket' },
            { left: 'isActive', right: true },
            { left: 'fullName', right: ['acme/backend'] },
          ],
        },
      }),
    );
  });

  it('retains all-active repository selection for unscoped non-environment runs', async () => {
    const result = await createTaskRunBitbucketCredentials(
      {
        ...taskRun,
        payload: {
          repo: '__all_repositories__',
          description: 'All repositories',
        },
      } as TaskRun,
      options,
    );
    expect(result.credentials).toHaveLength(1);
    expect(mockRepositoriesFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conditions: [
            { left: 'sourceControlProvider', right: 'bitbucket' },
            { left: 'isActive', right: true },
          ],
        },
      }),
    );
  });
});
