const mocks = vi.hoisted(() => ({
  createBitbucketPullRequestComment: vi.fn(),
  getBitbucketAutomationTargets: vi.fn(),
  findActiveGitHubPrReviewTask: vi.fn(),
  findReusableGitHubPrFollowUpOwner: vi.fn(),
  startSourceControlFastSessionTurn: vi.fn(),
}));

vi.mock('@roomote/bitbucket', () => ({
  createBitbucketPullRequestComment: mocks.createBitbucketPullRequestComment,
}));

vi.mock('@roomote/db/server', () => ({
  findActiveGitHubPrReviewTask: mocks.findActiveGitHubPrReviewTask,
  findReusableGitHubIssueTaskOwner: vi.fn(),
  findReusableGitHubPrFollowUpOwner: mocks.findReusableGitHubPrFollowUpOwner,
}));

vi.mock('@roomote/sdk/server', () => ({
  startSourceControlFastSessionTurn: mocks.startSourceControlFastSessionTurn,
}));

vi.mock('../getBitbucketAutomationTargets', async () => {
  const actual = await vi.importActual<
    typeof import('../getBitbucketAutomationTargets')
  >('../getBitbucketAutomationTargets');
  return {
    ...actual,
    getBitbucketAutomationTargets: mocks.getBitbucketAutomationTargets,
  };
});

import { handleBitbucketComment } from '../handleComment';
import type { BitbucketPullRequestCommentWebhook } from '../types';

function makeCommentPayload(): BitbucketPullRequestCommentWebhook {
  return {
    pullrequest: {
      id: 1,
      title: 'Add feature',
      description: 'Adds the thing.',
      state: 'OPEN',
      source: { branch: { name: 'feature' }, commit: { hash: 'abc123' } },
      destination: { branch: { name: 'main' }, commit: { hash: 'def456' } },
      author: { nickname: 'bob' },
      links: {
        html: { href: 'https://bitbucket.org/acme/repo/pull-requests/1' },
      },
    },
    comment: {
      id: 2,
      content: { raw: '@roomote review this please' },
      user: {
        nickname: 'alice',
        account_id: 'account-1',
        display_name: 'Alice',
      },
    },
    repository: {
      full_name: 'acme/repo',
      uuid: '{repo-1}',
      links: { html: { href: 'https://bitbucket.org/acme/repo' } },
    },
    actor: { nickname: 'alice', account_id: 'account-1' },
  } as BitbucketPullRequestCommentWebhook;
}

describe('handleBitbucketComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBitbucketAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'bitbucket:pr_review:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: null },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });
    mocks.findActiveGitHubPrReviewTask.mockResolvedValue(null);
    mocks.findReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
    mocks.startSourceControlFastSessionTurn.mockResolvedValue({
      status: 'queued',
      fastConversationId: 'fast-1',
    });
    mocks.createBitbucketPullRequestComment.mockResolvedValue({ id: 3 });
  });

  it('enters a pull request comment into the pull request Session', async () => {
    const result = await handleBitbucketComment(
      makeCommentPayload(),
      'pullrequest:comment_created',
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'fast_session_queued',
      metadata: { fastConversationId: 'fast-1' },
    });
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith({
      discussion: {
        provider: 'bitbucket',
        host: 'bitbucket.org',
        repositoryFullName: 'acme/repo',
        kind: 'pull',
        number: 1,
      },
      userId: 'user-1',
      senderDisplayName: 'Alice',
      question: '@roomote review this please',
      agentContext: expect.stringContaining('Pull request: #1 - Add feature'),
      currentMessageId: 'bitbucket:comment:2',
      activeTasks: [],
    });
    expect(mocks.findReusableGitHubPrFollowUpOwner).toHaveBeenCalledWith({
      repoFullName: 'acme/repo',
      prNumber: 1,
      branchName: 'feature',
      sourceControlProvider: 'bitbucket',
    });
    expect(mocks.createBitbucketPullRequestComment).not.toHaveBeenCalled();
  });

  it('asks an unlinked commenter to link their account', async () => {
    mocks.getBitbucketAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'Bitbucket user alice is not linked',
    });

    const result = await handleBitbucketComment(
      makeCommentPayload(),
      'pullrequest:comment_created',
    );

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mocks.createBitbucketPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'acme/repo',
        pullRequestNumber: 1,
        body: expect.stringContaining('Link it from'),
      }),
    );
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });

  it('propagates a failed account-link reply so the webhook is recorded as failed', async () => {
    mocks.getBitbucketAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'Bitbucket user alice is not linked',
    });
    const responseError = new Error('Bitbucket API unavailable');
    mocks.createBitbucketPullRequestComment.mockRejectedValue(responseError);

    await expect(
      handleBitbucketComment(
        makeCommentPayload(),
        'pullrequest:comment_created',
      ),
    ).rejects.toThrow(responseError);
  });

  it('tells the commenter when the Session cannot start', async () => {
    mocks.startSourceControlFastSessionTurn.mockResolvedValue({
      status: 'unavailable',
    });

    const result = await handleBitbucketComment(
      makeCommentPayload(),
      'pullrequest:comment_created',
    );

    expect(result).toEqual({ status: 'error', message: 'fast_unavailable' });
    expect(mocks.createBitbucketPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("couldn't start a conversation"),
      }),
    );
  });

  it('ignores other events and comments without a mention', async () => {
    await expect(
      handleBitbucketComment(makeCommentPayload(), 'pullrequest:updated'),
    ).resolves.toEqual({
      status: 'ok',
      message: 'unsupported_comment_event:pullrequest:updated',
    });
    const payload = makeCommentPayload();
    payload.comment.content = { raw: 'no mention' };
    await expect(
      handleBitbucketComment(payload, 'pullrequest:comment_created'),
    ).resolves.toEqual({ status: 'ok', message: 'no_mention' });
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });
});
