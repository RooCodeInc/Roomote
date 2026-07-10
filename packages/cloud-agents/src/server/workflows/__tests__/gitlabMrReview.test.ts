const { mockFetchPr } = vi.hoisted(() => ({
  mockFetchPr: vi.fn(),
}));

vi.mock('@roomote/github', () => ({
  createIssueComment: vi.fn(),
  updateIssueComment: vi.fn(),
  getEffectiveGitHubAppSlug: vi.fn(() => 'roomote'),
  resolveConfiguredGitHubAppSlug: vi.fn(async () => 'roomote'),
  Cli: {
    fetchPr: mockFetchPr,
  },
  Schemas: {
    isRoomoteGitHubLogin: vi.fn(),
  },
}));

import type {
  GithubPullRequestReviewOpenTask,
  GithubPullRequestReviewSyncTask,
} from '@roomote/types';
import { TaskPayloadKind } from '@roomote/types';

import { githubPrReview } from '../githubPrReview';
import { githubPrReviewSync } from '../githubPrReviewSync';

const basePayload = {
  repo: 'acme/backend',
  sourceControlProvider: 'gitlab' as const,
  prNumber: 42,
  prTitle: 'Update backend',
  prUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
  headSha: 'abc123',
  branchName: 'feature/test',
  targetBranch: 'main',
};

const giteaPayload = {
  ...basePayload,
  sourceControlProvider: 'gitea' as const,
  prUrl: 'https://git.example.com/acme/backend/pulls/42',
};

const adoPayload = {
  ...basePayload,
  repo: 'acme/Platform/backend',
  sourceControlProvider: 'ado' as const,
  prUrl: 'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
};

describe('GitLab MR review workflows', () => {
  beforeEach(() => {
    mockFetchPr.mockReset();
    mockFetchPr.mockRejectedValue(new Error('GitHub fetch should not run'));
  });

  it('builds initial GitLab MR review prompts without fetching GitHub PR details', async () => {
    const result = await githubPrReview({
      taskSpec: {
        type: TaskPayloadKind.GithubPrReview,
        payload: basePayload,
      } as GithubPullRequestReviewOpenTask,
      gitHubToken: 'unused',
      taskRunUrl: 'https://roomote.example/task/1',
    });

    expect(mockFetchPr).not.toHaveBeenCalled();
    expect(result.harnessInstructions).toContain(
      'GitLab merge request surface',
    );
    expect(result.prompt).toContain('source_control_provider');
    expect(result.prompt).toContain('gitlab');
    expect(result.prompt).toContain('Do not use GitHub-only CLI commands');
  });

  it('builds GitLab MR sync review prompts without fetching GitHub PR details', async () => {
    const result = await githubPrReviewSync({
      taskSpec: {
        type: TaskPayloadKind.GithubPrReviewSync,
        payload: basePayload,
      } as GithubPullRequestReviewSyncTask,
      gitHubToken: 'unused',
      taskRunUrl: 'https://roomote.example/task/1',
    });

    expect(mockFetchPr).not.toHaveBeenCalled();
    expect(result.prompt).toContain(
      'Review the new GitLab merge request changes',
    );
    expect(result.prompt).toContain('Do not use GitHub-only CLI commands');
  });

  it('builds initial Gitea PR review prompts without fetching GitHub PR details', async () => {
    const result = await githubPrReview({
      taskSpec: {
        type: TaskPayloadKind.GithubPrReview,
        payload: giteaPayload,
      } as GithubPullRequestReviewOpenTask,
      gitHubToken: 'unused',
      taskRunUrl: 'https://roomote.example/task/1',
    });

    expect(mockFetchPr).not.toHaveBeenCalled();
    expect(result.harnessInstructions).toContain('Gitea pull request surface');
    expect(result.prompt).toContain('source_control_provider');
    expect(result.prompt).toContain('gitea');
    expect(result.prompt).toContain('Do not use GitHub-only CLI commands');
  });

  it('builds Gitea PR sync review prompts without fetching GitHub PR details', async () => {
    const result = await githubPrReviewSync({
      taskSpec: {
        type: TaskPayloadKind.GithubPrReviewSync,
        payload: giteaPayload,
      } as GithubPullRequestReviewSyncTask,
      gitHubToken: 'unused',
      taskRunUrl: 'https://roomote.example/task/1',
    });

    expect(mockFetchPr).not.toHaveBeenCalled();
    expect(result.prompt).toContain(
      'Review the new Gitea pull request changes',
    );
    expect(result.prompt).toContain('Do not use GitHub-only CLI commands');
  });

  it('builds initial Azure DevOps PR review prompts without fetching GitHub PR details', async () => {
    const result = await githubPrReview({
      taskSpec: {
        type: TaskPayloadKind.GithubPrReview,
        payload: adoPayload,
      } as GithubPullRequestReviewOpenTask,
      gitHubToken: 'unused',
      taskRunUrl: 'https://roomote.example/task/1',
    });

    expect(mockFetchPr).not.toHaveBeenCalled();
    expect(result.harnessInstructions).toContain(
      'Azure DevOps pull request surface',
    );
    expect(result.prompt).toContain('source_control_provider');
    expect(result.prompt).toContain('ado');
    expect(result.prompt).toContain('Do not use GitHub-only CLI commands');
  });

  it('builds Azure DevOps PR sync review prompts without fetching GitHub PR details', async () => {
    const result = await githubPrReviewSync({
      taskSpec: {
        type: TaskPayloadKind.GithubPrReviewSync,
        payload: adoPayload,
      } as GithubPullRequestReviewSyncTask,
      gitHubToken: 'unused',
      taskRunUrl: 'https://roomote.example/task/1',
    });

    expect(mockFetchPr).not.toHaveBeenCalled();
    expect(result.prompt).toContain(
      'Review the new Azure DevOps pull request changes',
    );
    expect(result.prompt).toContain('Do not use GitHub-only CLI commands');
  });
});
