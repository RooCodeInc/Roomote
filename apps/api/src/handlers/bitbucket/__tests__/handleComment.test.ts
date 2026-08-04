import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateBitbucketPullRequestComment,
  mockGetBitbucketAutomationTargets,
  mockEnqueueTask,
  mockFindActiveGitHubPrReviewTask,
  mockFindReusableGitHubPrFollowUpOwner,
  mockSendMessageToTask,
  mockSteerMessageToTask,
} = vi.hoisted(() => ({
  mockCreateBitbucketPullRequestComment: vi.fn(),
  mockGetBitbucketAutomationTargets: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockFindActiveGitHubPrReviewTask: vi.fn(),
  mockFindReusableGitHubPrFollowUpOwner: vi.fn(),
  mockSendMessageToTask: vi.fn(),
  mockSteerMessageToTask: vi.fn(),
}));

// Prompt-framing fakes use distinctive markers so tests can assert the
// handler routes each piece of text through the right builder; the real
// escaping/wrapping behavior is unit-tested in @roomote/cloud-agents.
vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
  getTaskUrl: vi.fn(),
  buildMentionRequestBlock: (text: string) =>
    `<mention_request>${text}</mention_request>`,
  buildUntrustedContentPolicy: () => '<untrusted_content_policy/>',
  escapeTaskContextText: (value: string) => value,
}));

vi.mock('@roomote/bitbucket', () => ({
  createBitbucketPullRequestComment: mockCreateBitbucketPullRequestComment,
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...actual,
    getDeploymentAccountLinkHelpText: vi.fn().mockResolvedValue(null),
    findActiveGitHubPrReviewTask: mockFindActiveGitHubPrReviewTask,
    findReusableGitHubPrFollowUpOwner: mockFindReusableGitHubPrFollowUpOwner,
  };
});

vi.mock('../../tasks/sendMessageToTask', () => ({
  sendMessageToTask: mockSendMessageToTask,
  steerMessageToTask: mockSteerMessageToTask,
}));

vi.mock('../getBitbucketAutomationTargets', async () => {
  const actual = await vi.importActual<
    typeof import('../getBitbucketAutomationTargets')
  >('../getBitbucketAutomationTargets');

  return {
    ...actual,
    getBitbucketAutomationTargets: mockGetBitbucketAutomationTargets,
  };
});

import { RunStatus } from '@roomote/types';

import { handleBitbucketComment } from '../handleComment';
import type { BitbucketPullRequestCommentWebhook } from '../types';

function makeCommentPayload(): BitbucketPullRequestCommentWebhook {
  return {
    pullrequest: {
      id: 1,
      title: 'Add feature',
      state: 'OPEN',
      source: { branch: { name: 'feature' }, commit: { hash: 'abc123' } },
      destination: { branch: { name: 'main' }, commit: { hash: 'def456' } },
      links: {
        html: { href: 'https://bitbucket.org/acme/repo/pull-requests/1' },
      },
    },
    comment: {
      id: 2,
      content: { raw: '@roomote review this please' },
      user: { nickname: 'alice', account_id: 'account-1' },
    },
    repository: {
      full_name: 'acme/repo',
      uuid: '{repo-1}',
      links: { html: { href: 'https://bitbucket.org/acme/repo' } },
    },
    actor: { nickname: 'alice', account_id: 'account-1' },
  };
}

describe('handleBitbucketComment', () => {
  beforeEach(() => {
    mockCreateBitbucketPullRequestComment.mockReset();
    mockGetBitbucketAutomationTargets.mockReset();
    mockEnqueueTask.mockReset();
    mockFindActiveGitHubPrReviewTask.mockReset();
    mockFindReusableGitHubPrFollowUpOwner.mockReset();
    mockSendMessageToTask.mockReset();
    mockSteerMessageToTask.mockReset();

    mockGetBitbucketAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'Bitbucket user alice is not linked',
    });
    mockFindActiveGitHubPrReviewTask.mockResolvedValue(null);
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
  });

  it('propagates a failed account-link response so the webhook is recorded as failed', async () => {
    const responseError = new Error('Bitbucket API unavailable');
    mockCreateBitbucketPullRequestComment.mockRejectedValue(responseError);

    await expect(
      handleBitbucketComment(
        makeCommentPayload(),
        'pullrequest:comment_created',
      ),
    ).rejects.toThrow(responseError);

    expect(mockCreateBitbucketPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'acme/repo',
        pullRequestNumber: 1,
        body: expect.stringContaining('Link it from'),
      }),
    );
  });

  it('posts an account-link reply and completes the webhook when Bitbucket accepts it', async () => {
    mockCreateBitbucketPullRequestComment.mockResolvedValue({ id: 3 });

    await expect(
      handleBitbucketComment(
        makeCommentPayload(),
        'pullrequest:comment_created',
      ),
    ).resolves.toEqual({ status: 'ok', message: 'account_link_required' });

    expect(mockCreateBitbucketPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'acme/repo',
        pullRequestNumber: 1,
        body: expect.stringContaining('Link it from'),
      }),
    );
  });

  it('posts an environment setup reply when no environment is mapped', async () => {
    mockGetBitbucketAutomationTargets.mockResolvedValue({
      status: 'error',
      message:
        'no environment mapping associated with [bitbucket:repo-1, acme/repo]',
    });
    mockCreateBitbucketPullRequestComment.mockResolvedValue({ id: 6 });

    await expect(
      handleBitbucketComment(
        makeCommentPayload(),
        'pullrequest:comment_created',
      ),
    ).resolves.toEqual({ status: 'ok', message: 'environment_required' });

    expect(mockCreateBitbucketPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('no Roomote environment is mapped'),
      }),
    );
  });

  it('does not suppress a human mention from the deployment OAuth identity', async () => {
    const payload = makeCommentPayload();
    payload.comment.user = {
      nickname: 'bruno',
      account_id: 'deployment-account',
    };
    payload.actor = payload.comment.user;
    mockCreateBitbucketPullRequestComment.mockResolvedValue({ id: 4 });

    await expect(
      handleBitbucketComment(payload, 'pullrequest:comment_created'),
    ).resolves.toEqual({ status: 'ok', message: 'account_link_required' });

    expect(mockCreateBitbucketPullRequestComment).toHaveBeenCalledOnce();
  });

  it('routes mentions into a reusable active task with untrusted-content framing', async () => {
    mockGetBitbucketAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'bitbucket:pr_review:repo-1',
          workflow: 'pr_review',
          settings: null,
          repo: {
            id: 'repo-1',
            host: 'bitbucket.org',
          },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue({
      taskId: 'task-existing',
      status: RunStatus.Running,
      taskPhase: 'running',
    });
    mockSteerMessageToTask.mockResolvedValue({ success: true, result: {} });
    mockCreateBitbucketPullRequestComment.mockResolvedValue({ id: 7 });

    const result = await handleBitbucketComment(
      makeCommentPayload(),
      'pullrequest:comment_created',
    );

    expect(result).toEqual({ status: 'ok', message: 'active_pr_owner_routed' });
    expect(mockSteerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-existing',
        userId: 'user-1',
        message: expect.stringContaining(
          '<mention_request>@roomote review this please</mention_request>',
        ),
        senderMode: 'github_pr_follow_up',
      }),
    );
    expect(mockSteerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('<untrusted_content_policy/>'),
      }),
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('logs enqueue failures and posts a queue-specific response', async () => {
    mockGetBitbucketAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'bitbucket:pr_review:repo-1',
          workflow: 'pr_review',
          settings: null,
          repo: {
            id: 'repo-1',
            host: 'bitbucket.org',
          },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });
    mockEnqueueTask.mockRejectedValue(new Error('queue unavailable'));
    mockCreateBitbucketPullRequestComment.mockResolvedValue({ id: 5 });

    await expect(
      handleBitbucketComment(
        makeCommentPayload(),
        'pullrequest:comment_created',
      ),
    ).resolves.toEqual({
      status: 'error',
      message: 'review_start_failed:queue unavailable',
    });

    expect(mockCreateBitbucketPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('could not queue a review task'),
      }),
    );
  });
});
