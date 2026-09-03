const mocks = vi.hoisted(() => ({
  getAdoAutomationTargets: vi.fn(),
  getAdoDeploymentUser: vi.fn(),
  createAdoPullRequestComment: vi.fn(),
  findActiveGitHubPrReviewTask: vi.fn(),
  findReusableGitHubPrFollowUpOwner: vi.fn(),
  startSourceControlFastSessionTurn: vi.fn(),
}));

vi.mock('@roomote/ado', () => ({
  createAdoPullRequestComment: mocks.createAdoPullRequestComment,
  getAdoDeploymentUser: mocks.getAdoDeploymentUser,
}));

vi.mock('@roomote/db/server', () => ({
  findActiveGitHubPrReviewTask: mocks.findActiveGitHubPrReviewTask,
  findReusableGitHubIssueTaskOwner: vi.fn(),
  findReusableGitHubPrFollowUpOwner: mocks.findReusableGitHubPrFollowUpOwner,
}));

vi.mock('@roomote/sdk/server', () => ({
  startSourceControlFastSessionTurn: mocks.startSourceControlFastSessionTurn,
}));

vi.mock('../getAdoAutomationTargets', async () => {
  const actual = await vi.importActual<
    typeof import('../getAdoAutomationTargets')
  >('../getAdoAutomationTargets');
  return {
    ...actual,
    getAdoAutomationTargets: mocks.getAdoAutomationTargets,
  };
});

import { handleAdoComment } from '../handleComment';
import type { AdoPullRequestCommentWebhook } from '../types';

function makeCommentPayload(
  overrides: {
    comment?: Partial<AdoPullRequestCommentWebhook['resource']['comment']>;
  } = {},
): AdoPullRequestCommentWebhook {
  return {
    id: 'comment-delivery-1',
    eventType: 'ms.vss-code.git-pullrequest-comment-event',
    publisherId: 'tfs',
    resourceContainers: {
      account: { baseUrl: 'https://dev.azure.com/acme/' },
    },
    resource: {
      comment: {
        id: 900,
        author: {
          id: 'ado-user-1',
          uniqueName: 'alice@acme.example',
          displayName: 'Alice',
        },
        content: '@roomote please review this',
        commentType: 'text',
        _links: {
          threads: {
            href: 'https://dev.azure.com/acme/Platform/_apis/git/repositories/repo-1/pullRequests/42/threads/5',
          },
        },
        ...overrides.comment,
      },
      pullRequest: {
        repository: {
          id: 'repo-1',
          name: 'backend',
          project: { id: 'project-1', name: 'Platform' },
        },
        pullRequestId: 42,
        title: 'Update backend',
        description: 'Refactors the retry loop.',
        status: 'active',
        sourceRefName: 'refs/heads/feature/test',
        targetRefName: 'refs/heads/main',
        createdBy: { uniqueName: 'bob@acme.example' },
        lastMergeSourceCommit: { commitId: 'abc123' },
        _links: {
          web: {
            href: 'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
          },
        },
      },
    },
  } as AdoPullRequestCommentWebhook;
}

describe('handleAdoComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdoDeploymentUser.mockResolvedValue(null);
    mocks.getAdoAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'ado:pr_review:repo-1',
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
    mocks.createAdoPullRequestComment.mockResolvedValue({
      threadId: '5',
      commentId: '901',
    });
  });

  it('enters a pull request comment into the pull request Session, threaded under its comment thread', async () => {
    const result = await handleAdoComment(makeCommentPayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'fast_session_queued',
      metadata: { fastConversationId: 'fast-1' },
    });
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith({
      discussion: {
        provider: 'ado',
        host: 'dev.azure.com',
        repositoryFullName: 'acme/Platform/backend',
        kind: 'pull',
        number: 42,
        reviewCommentId: '5',
        replyCommentId: '900',
      },
      userId: 'user-1',
      senderDisplayName: 'alice@acme.example',
      question: '@roomote please review this',
      agentContext: expect.stringContaining(
        'Pull request: #42 - Update backend',
      ),
      currentMessageId: 'ado:comment:900',
      activeTasks: [],
    });
    const context = mocks.startSourceControlFastSessionTurn.mock.calls[0]?.[0]
      .agentContext as string;
    expect(context).toContain('Head branch: feature/test');
    expect(context).toContain('Target branch: main');
    expect(mocks.findReusableGitHubPrFollowUpOwner).toHaveBeenCalledWith({
      repoFullName: 'acme/Platform/backend',
      prNumber: 42,
      branchName: 'feature/test',
      sourceControlProvider: 'ado',
    });
    expect(mocks.createAdoPullRequestComment).not.toHaveBeenCalled();
  });

  it('scopes the owner lookup to the repository host when it has one', async () => {
    mocks.getAdoAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'ado:pr_review:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: 'ado.internal.example' },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });

    await handleAdoComment(makeCommentPayload());

    expect(mocks.findReusableGitHubPrFollowUpOwner).toHaveBeenCalledWith({
      repoFullName: 'acme/Platform/backend',
      prNumber: 42,
      branchName: 'feature/test',
      sourceControlProvider: 'ado',
      host: 'ado.internal.example',
    });
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        discussion: expect.objectContaining({ host: 'ado.internal.example' }),
      }),
    );
  });

  it('asks an unlinked commenter to link their account in the same thread', async () => {
    mocks.getAdoAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'not linked',
    });

    const result = await handleAdoComment(makeCommentPayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mocks.createAdoPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'acme/Platform/backend',
        repositoryId: 'repo-1',
        pullRequestNumber: 42,
        threadId: '5',
        body: expect.stringContaining('Azure DevOps account linked'),
      }),
    );
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });

  it('tells the commenter when the Session cannot start', async () => {
    mocks.startSourceControlFastSessionTurn.mockResolvedValue({
      status: 'unavailable',
    });

    const result = await handleAdoComment(makeCommentPayload());

    expect(result).toEqual({ status: 'error', message: 'fast_unavailable' });
    expect(mocks.createAdoPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("couldn't start a conversation"),
      }),
    );
  });

  it('ignores non-text comments, Roomote-authored comments, and comments without a mention', async () => {
    await expect(
      handleAdoComment(
        makeCommentPayload({ comment: { commentType: 'system' } }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      message: 'unsupported_comment_type:system',
    });
    await expect(
      handleAdoComment(makeCommentPayload({ comment: { content: 'plain' } })),
    ).resolves.toEqual({ status: 'ok', message: 'no_mention' });
    mocks.getAdoDeploymentUser.mockResolvedValue({
      id: 'ado-user-1',
      uniqueName: 'alice@acme.example',
      displayName: 'Alice',
    });
    await expect(handleAdoComment(makeCommentPayload())).resolves.toEqual({
      status: 'ok',
      message: 'roomote_authored_comment',
    });
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });
});
