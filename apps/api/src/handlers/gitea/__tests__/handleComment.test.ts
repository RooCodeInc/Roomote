const mocks = vi.hoisted(() => ({
  getGiteaAutomationTargets: vi.fn(),
  createGiteaPullRequestComment: vi.fn(),
  createGiteaIssueComment: vi.fn(),
  getGiteaDeploymentUser: vi.fn(),
  findActiveGitHubPrReviewTask: vi.fn(),
  findReusableGitHubPrFollowUpOwner: vi.fn(),
  findReusableGitHubIssueTaskOwner: vi.fn(),
  startSourceControlFastSessionTurn: vi.fn(),
}));

vi.mock('@roomote/gitea', () => ({
  createGiteaIssueComment: mocks.createGiteaIssueComment,
  createGiteaPullRequestComment: mocks.createGiteaPullRequestComment,
  getGiteaDeploymentUser: mocks.getGiteaDeploymentUser,
}));

vi.mock('@roomote/db/server', () => ({
  findActiveGitHubPrReviewTask: mocks.findActiveGitHubPrReviewTask,
  findReusableGitHubIssueTaskOwner: mocks.findReusableGitHubIssueTaskOwner,
  findReusableGitHubPrFollowUpOwner: mocks.findReusableGitHubPrFollowUpOwner,
}));

vi.mock('@roomote/sdk/server', () => ({
  startSourceControlFastSessionTurn: mocks.startSourceControlFastSessionTurn,
}));

vi.mock('../getGiteaAutomationTargets', async () => {
  const actual = await vi.importActual<
    typeof import('../getGiteaAutomationTargets')
  >('../getGiteaAutomationTargets');
  return {
    ...actual,
    getGiteaAutomationTargets: mocks.getGiteaAutomationTargets,
  };
});

import { handleGiteaComment } from '../handleComment';
import type { GiteaPullRequestCommentWebhook } from '../types';

function makeCommentPayload(
  overrides: {
    comment?: Partial<GiteaPullRequestCommentWebhook['comment']>;
    sender?: GiteaPullRequestCommentWebhook['sender'];
    action?: string;
    isPull?: boolean;
    withPullRequest?: boolean;
  } = {},
): GiteaPullRequestCommentWebhook {
  const payload = {
    action: overrides.action ?? 'created',
    is_pull: overrides.isPull ?? true,
    sender: overrides.sender ?? { id: 10, login: 'alice' },
    repository: {
      id: 123,
      full_name: 'acme/backend',
      html_url: 'https://git.example.com/acme/backend',
    },
    comment: {
      id: 900,
      body: '@roomote please review this',
      user: { id: 10, login: 'alice' },
      ...overrides.comment,
    },
    issue: {
      number: 42,
      title: 'Update backend',
      body: 'Issue body details',
      html_url: 'https://git.example.com/acme/backend/issues/42',
      user: { id: 11, login: 'bob' },
    },
    ...(overrides.withPullRequest === false
      ? {}
      : {
          pull_request: {
            number: 42,
            title: 'Update backend',
            body: 'Refactors the retry loop.',
            html_url: 'https://git.example.com/acme/backend/pulls/42',
            head: { ref: 'feature/test', sha: 'abc123' },
            base: { ref: 'main' },
            user: { id: 11, login: 'bob' },
          },
        }),
  };
  return payload as unknown as GiteaPullRequestCommentWebhook;
}

describe('handleGiteaComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGiteaDeploymentUser.mockResolvedValue(null);
    mocks.getGiteaAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitea:pr_review:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: null },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });
    mocks.findActiveGitHubPrReviewTask.mockResolvedValue(null);
    mocks.findReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
    mocks.findReusableGitHubIssueTaskOwner.mockResolvedValue(null);
    mocks.startSourceControlFastSessionTurn.mockResolvedValue({
      status: 'queued',
      fastConversationId: 'fast-1',
    });
    mocks.createGiteaPullRequestComment.mockResolvedValue({ id: 1 });
    mocks.createGiteaIssueComment.mockResolvedValue({ id: 2 });
  });

  it('enters a pull request comment into the pull request Session', async () => {
    const result = await handleGiteaComment(makeCommentPayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'fast_session_queued',
      metadata: { fastConversationId: 'fast-1' },
    });
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith({
      discussion: {
        provider: 'gitea',
        host: 'git.example.com',
        repositoryFullName: 'acme/backend',
        kind: 'pull',
        number: 42,
      },
      userId: 'user-1',
      senderDisplayName: 'alice',
      question: '@roomote please review this',
      agentContext: expect.stringContaining(
        'Pull request: #42 - Update backend',
      ),
      currentMessageId: 'gitea:comment:900',
      activeTasks: [],
    });
    expect(mocks.findReusableGitHubPrFollowUpOwner).toHaveBeenCalledWith({
      repoFullName: 'acme/backend',
      prNumber: 42,
      branchName: 'feature/test',
      sourceControlProvider: 'gitea',
    });
    expect(mocks.createGiteaPullRequestComment).not.toHaveBeenCalled();
  });

  it('enters an issue comment into the issue Session', async () => {
    mocks.findReusableGitHubIssueTaskOwner.mockResolvedValue({
      taskId: 'task-issue',
      runId: 9,
      type: 'standard_task',
      status: 'idle',
      taskPhase: null,
      delivery: 'message',
    });

    await handleGiteaComment(
      makeCommentPayload({ isPull: false, withPullRequest: false }),
    );

    expect(mocks.getGiteaAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: 'pr_conflict_resolve' }),
    );
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        discussion: expect.objectContaining({ kind: 'issues', number: 42 }),
        agentContext: expect.stringContaining('Issue: #42 - Update backend'),
        activeTasks: [{ taskId: 'task-issue', status: 'idle' }],
      }),
    );
  });

  it('asks an unlinked commenter to link their account', async () => {
    mocks.getGiteaAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'not linked',
    });

    const result = await handleGiteaComment(makeCommentPayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mocks.createGiteaPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'acme/backend',
        pullRequestNumber: 42,
        body: expect.stringContaining('Gitea account linked'),
      }),
    );
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });

  it('tells the commenter when the Session cannot start', async () => {
    mocks.startSourceControlFastSessionTurn.mockResolvedValue({
      status: 'unavailable',
    });

    const result = await handleGiteaComment(makeCommentPayload());

    expect(result).toEqual({ status: 'error', message: 'fast_unavailable' });
    expect(mocks.createGiteaPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("couldn't start a conversation"),
      }),
    );
  });

  it('ignores other actions, deployment-authored comments, and comments without a mention', async () => {
    await expect(
      handleGiteaComment(makeCommentPayload({ action: 'edited' })),
    ).resolves.toEqual({
      status: 'ok',
      message: 'unsupported_comment_action:edited',
    });
    await expect(
      handleGiteaComment(makeCommentPayload({ comment: { body: 'plain' } })),
    ).resolves.toEqual({ status: 'ok', message: 'no_mention' });
    mocks.getGiteaDeploymentUser.mockResolvedValue({ id: 10, login: 'alice' });
    await expect(handleGiteaComment(makeCommentPayload())).resolves.toEqual({
      status: 'ok',
      message: 'roomote_authored_comment',
    });
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });
});
