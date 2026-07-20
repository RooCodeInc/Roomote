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

import { handleGiteaIssue } from '../handleIssue';

describe('handleGiteaIssue', () => {
  beforeEach(() => {
    mockLaunchIssueFixerTriage.mockReset();
    mockFindMany.mockReset();
    mockLaunchIssueFixerTriage.mockResolvedValue({
      status: 'ok',
      message: 'launched',
    });
  });

  it('launches triage for open issues on active Gitea repos', async () => {
    mockFindMany.mockResolvedValue([
      {
        fullName: 'acme/backend',
        host: 'git.example.com',
      },
    ]);

    await expect(
      handleGiteaIssue({
        action: 'opened',
        repository: {
          id: 123,
          full_name: 'acme/backend',
          html_url: 'https://git.example.com/acme/backend',
        },
        sender: { id: 7, login: 'alice' },
        issue: {
          number: 77,
          title: 'Broken feature',
          body: 'Something broke',
          html_url: 'https://git.example.com/acme/backend/issues/77',
          state: 'open',
          labels: [{ name: 'bug' }],
          user: { login: 'alice' },
        },
      }),
    ).resolves.toEqual({ status: 'ok', message: 'launched' });

    expect(mockLaunchIssueFixerTriage).toHaveBeenCalledWith({
      sourceControlProvider: 'gitea',
      repositoryFullName: 'acme/backend',
      continueMention: '@roomote',
      issue: {
        number: 77,
        title: 'Broken feature',
        url: 'https://git.example.com/acme/backend/issues/77',
        body: 'Something broke',
        labels: ['bug'],
        authorLogin: 'alice',
      },
    });
  });

  it('ignores pull-request shaped issue events', async () => {
    await expect(
      handleGiteaIssue({
        action: 'opened',
        is_pull: true,
        repository: {
          id: 123,
          full_name: 'acme/backend',
        },
        issue: {
          number: 12,
          title: 'PR as issue',
        },
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      message: 'Ignoring Gitea pull-request issue event',
    });
    expect(mockLaunchIssueFixerTriage).not.toHaveBeenCalled();
  });
});
