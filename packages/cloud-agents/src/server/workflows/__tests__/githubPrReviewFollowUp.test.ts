const { mockGetPrReviewCommentId } = vi.hoisted(() => ({
  mockGetPrReviewCommentId: vi.fn(),
}));

vi.mock('@roomote/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/github')>();

  return {
    ...actual,
    Cli: {
      ...actual.Cli,
      fetchPr: vi.fn(async () => ({
        id: 'PR_kwDOExample',
        number: 42,
        title: 'Improve review prompts',
        body: 'Updates review prompt generation.',
        url: 'https://github.com/acme/backend/pull/42',
        headRefName: 'feature/review-prompts',
        baseRefName: 'develop',
        baseRefOid: 'base-sha',
        headRefOid: 'head-sha',
        closingIssuesReferences: [],
      })),
      fetchTriggeringComment: vi.fn(async () => ({
        commentType: 'manual',
        comment: '@roomote verify this PR',
      })),
      fetchDiff: vi.fn(async () => ({
        diff: 'diff --git a/src/review.ts b/src/review.ts',
        changedFiles: ['src/review.ts'],
      })),
      fetchReviewComments: vi.fn(async () => []),
      fetchIssueComments: vi.fn(async () => []),
      fetchIssue: vi.fn(),
      fetchIssueComment: vi.fn(),
    },
  };
});

vi.mock('../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils')>()),
  getPrReviewCommentId: mockGetPrReviewCommentId,
}));

import type { GithubPullRequestReviewFollowUpTask } from '@roomote/types';
import { TaskPayloadKind } from '@roomote/types';

import { githubPrReviewFollowUp } from '../githubPrReviewFollowUp';

describe('githubPrReviewFollowUp', () => {
  it('appends additional team instructions to the follow-up prompt', async () => {
    mockGetPrReviewCommentId.mockResolvedValue(undefined);

    const result = await githubPrReviewFollowUp({
      taskSpec: {
        type: TaskPayloadKind.GithubPrReviewFollowUp,
        payload: {
          repo: 'acme/backend',
          prNumber: 42,
          prTitle: 'Improve review prompts',
          commentBody: '@roomote verify this PR',
        },
      } as GithubPullRequestReviewFollowUpTask,
      gitHubToken: 'token',
      taskRunUrl: 'https://roomote.example/task/1',
      additionalInstructions: 'Focus on authorization boundaries.',
    });

    expect(result.prompt).toContain('Additional team instructions:');
    expect(result.prompt).toContain('Focus on authorization boundaries.');
  });
});
