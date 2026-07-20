import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLaunchIssueFixerTriage, mockFindMany } = vi.hoisted(() => ({
  mockLaunchIssueFixerTriage: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock('../../shared/issue-fixer-launch', () => ({
  launchIssueFixerTriage: mockLaunchIssueFixerTriage,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      repositories: {
        findMany: mockFindMany,
      },
    },
  },
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  or: (...args: unknown[]) => args,
  repositories: {
    sourceControlProvider: 'sourceControlProvider',
    isActive: 'isActive',
    externalRepoId: 'externalRepoId',
    fullName: 'fullName',
  },
}));

import { handleGitLabIssue } from '../handleIssue';

describe('handleGitLabIssue', () => {
  beforeEach(() => {
    mockLaunchIssueFixerTriage.mockReset();
    mockFindMany.mockReset();
    mockLaunchIssueFixerTriage.mockResolvedValue({
      status: 'ok',
      message: 'launched',
    });
  });

  it('launches triage for open issues on active GitLab repos', async () => {
    mockFindMany.mockResolvedValue([
      {
        fullName: 'acme/backend',
        host: 'gitlab.com',
      },
    ]);

    await expect(
      handleGitLabIssue({
        object_kind: 'issue',
        user: { id: 7, username: 'alice' },
        project: {
          id: 123,
          path_with_namespace: 'acme/backend',
          web_url: 'https://gitlab.com/acme/backend',
        },
        object_attributes: {
          action: 'open',
          iid: 9,
          title: 'Broken feature',
          description: 'Something broke',
          url: 'https://gitlab.com/acme/backend/-/issues/9',
          state: 'opened',
        },
        labels: [{ title: 'bug' }],
      }),
    ).resolves.toEqual({ status: 'ok', message: 'launched' });

    expect(mockLaunchIssueFixerTriage).toHaveBeenCalledWith({
      sourceControlProvider: 'gitlab',
      repositoryFullName: 'acme/backend',
      continueMention: '@roomote',
      issue: {
        number: 9,
        title: 'Broken feature',
        url: 'https://gitlab.com/acme/backend/-/issues/9',
        body: 'Something broke',
        labels: ['bug'],
        authorLogin: 'alice',
      },
    });
  });

  it('ignores non-open actions', async () => {
    await expect(
      handleGitLabIssue({
        object_kind: 'issue',
        project: {
          id: 123,
          path_with_namespace: 'acme/backend',
        },
        object_attributes: {
          action: 'close',
          iid: 9,
          title: 'Closed',
          url: 'https://gitlab.com/acme/backend/-/issues/9',
        },
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      message: expect.stringContaining('Ignoring GitLab issue action'),
    });
    expect(mockLaunchIssueFixerTriage).not.toHaveBeenCalled();
  });
});
