const {
  mockEnqueueCloudTask,
  mockGetTaskUrl,
  mockGetGiteaAutomationTargets,
  mockGetGiteaDeploymentUser,
  mockCreateGiteaPullRequestComment,
  mockFindActiveGitHubPrReviewTask,
  mockFindReusableGitHubPrFollowUpOwner,
  mockSendMessageToTask,
  mockSteerMessageToTask,
} = vi.hoisted(() => ({
  mockEnqueueCloudTask: vi.fn(),
  mockGetTaskUrl: vi.fn(),
  mockGetGiteaAutomationTargets: vi.fn(),
  mockGetGiteaDeploymentUser: vi.fn(),
  mockCreateGiteaPullRequestComment: vi.fn(),
  mockFindActiveGitHubPrReviewTask: vi.fn(),
  mockFindReusableGitHubPrFollowUpOwner: vi.fn(),
  mockSendMessageToTask: vi.fn(),
  mockSteerMessageToTask: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueCloudTask: mockEnqueueCloudTask,
  getTaskUrl: mockGetTaskUrl,
}));

vi.mock('@roomote/gitea', () => ({
  getGiteaDeploymentUser: mockGetGiteaDeploymentUser,
  createGiteaPullRequestComment: mockCreateGiteaPullRequestComment,
}));

vi.mock('@roomote/db/server', () => ({
  findActiveGitHubPrReviewTask: (...args: unknown[]) =>
    mockFindActiveGitHubPrReviewTask(...args),
  findReusableGitHubPrFollowUpOwner: (...args: unknown[]) =>
    mockFindReusableGitHubPrFollowUpOwner(...args),
}));

vi.mock('../getGiteaAutomationTargets', async () => {
  const actual = await vi.importActual<
    typeof import('../getGiteaAutomationTargets')
  >('../getGiteaAutomationTargets');

  return {
    ...actual,
    getGiteaAutomationTargets: mockGetGiteaAutomationTargets,
  };
});

vi.mock('../../tasks/sendMessageToTask', () => ({
  sendMessageToTask: mockSendMessageToTask,
  steerMessageToTask: mockSteerMessageToTask,
}));

import { CloudTaskStatus, TaskPayloadKind } from '@roomote/types';

import { handleGiteaComment } from '../handleComment';
import type { GiteaPullRequestCommentWebhook } from '../types';

function makeCommentPayload(
  overrides: {
    comment?: Partial<GiteaPullRequestCommentWebhook['comment']>;
    pullRequest?: Partial<
      NonNullable<GiteaPullRequestCommentWebhook['pull_request']>
    > | null;
    sender?: GiteaPullRequestCommentWebhook['sender'];
    action?: string;
    isPull?: boolean;
  } = {},
): GiteaPullRequestCommentWebhook {
  const payload: GiteaPullRequestCommentWebhook = {
    action: overrides.action ?? 'created',
    is_pull: overrides.isPull ?? true,
    sender: overrides.sender ?? { id: 10, login: 'alice' },
    repository: {
      id: 123,
      full_name: 'acme/backend',
      html_url: 'https://git.example.com/acme/backend',
    },
    issue: {
      number: 42,
      title: 'Update backend',
    },
    comment: {
      id: 900,
      body: '@roomote please review this',
      user: { id: 10, login: 'alice' },
      ...overrides.comment,
    },
  };

  if (overrides.pullRequest !== null) {
    payload.pull_request = {
      number: 42,
      title: 'Update backend',
      html_url: 'https://git.example.com/acme/backend/pulls/42',
      head: { ref: 'feature/test', sha: 'abc123' },
      base: { ref: 'main' },
      ...overrides.pullRequest,
    };
  }

  return payload;
}

describe('handleGiteaComment', () => {
  beforeEach(() => {
    mockEnqueueCloudTask.mockReset();
    mockGetTaskUrl.mockReset();
    mockGetGiteaAutomationTargets.mockReset();
    mockGetGiteaDeploymentUser.mockReset();
    mockCreateGiteaPullRequestComment.mockReset();
    mockFindActiveGitHubPrReviewTask.mockReset();
    mockFindReusableGitHubPrFollowUpOwner.mockReset();
    mockSendMessageToTask.mockReset();
    mockSteerMessageToTask.mockReset();

    mockGetGiteaAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitea:pr_reviewer:repo-1',
          settings: null,
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });
    mockGetGiteaDeploymentUser.mockResolvedValue({ login: 'roomote-bot' });
    mockCreateGiteaPullRequestComment.mockResolvedValue({ id: 1 });
    mockFindActiveGitHubPrReviewTask.mockResolvedValue(null);
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
    mockEnqueueCloudTask.mockResolvedValue({ id: 1234, taskId: 'task-1' });
    mockGetTaskUrl.mockReturnValue('https://roomote.example/tasks/task-1');
    mockSendMessageToTask.mockResolvedValue({ success: true });
    mockSteerMessageToTask.mockResolvedValue({ success: true });
  });

  it('enqueues a Gitea PR review task when a mention has no reusable owner', async () => {
    const result = await handleGiteaComment(makeCommentPayload());

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.GithubPrReview,
          payload: expect.objectContaining({
            repo: 'acme/backend',
            sourceControlProvider: 'gitea',
            prNumber: 42,
            prUrl: 'https://git.example.com/acme/backend/pulls/42',
            branch: 'feature/test',
            sha: 'abc123',
            targetBranch: 'main',
          }),
        }),
        // A human @roomote mention: the linked commenter is the initiator.
        initiator: { kind: 'user', userId: 'user-1' },
        workflow: 'pr_review',
        surface: 'gitea',
        trigger: 'message',
        prLinkage: expect.objectContaining({
          provider: 'gitea',
          repository: 'acme/backend',
          prNumber: 42,
        }),
      }),
    );
    expect(mockCreateGiteaPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'acme/backend',
        pullRequestNumber: 42,
        body: expect.stringContaining('I started a pull request review task'),
      }),
    );
  });

  it('routes mentions into a reusable active task before starting a new review', async () => {
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue({
      taskId: 'task-existing',
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
    });
    mockGetTaskUrl.mockReturnValue(
      'https://roomote.example/tasks/task-existing',
    );

    const result = await handleGiteaComment(makeCommentPayload());

    expect(result).toEqual({ status: 'ok', message: 'active_pr_owner_routed' });
    expect(mockSteerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-existing',
        userId: 'user-1',
        message: expect.stringContaining('mentioned Roomote in a comment'),
      }),
    );
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('links to an active review instead of starting a duplicate review task', async () => {
    mockFindActiveGitHubPrReviewTask.mockResolvedValue({
      taskId: 'task-review',
    });
    mockGetTaskUrl.mockReturnValue('https://roomote.example/tasks/task-review');

    const result = await handleGiteaComment(makeCommentPayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'active_pr_review_linked',
    });
    expect(mockCreateGiteaPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          'https://roomote.example/tasks/task-review',
        ),
      }),
    );
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('prompts the commenter to link Gitea before starting work', async () => {
    mockGetGiteaAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'Gitea user alice is not linked',
    });

    const result = await handleGiteaComment(makeCommentPayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mockCreateGiteaPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('settings?service=gitea'),
      }),
    );
    expect(mockCreateGiteaPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          'ask an admin to add the Gitea OAuth client credentials',
        ),
      }),
    );
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('handles issue comment payloads that only include issue PR context', async () => {
    const result = await handleGiteaComment(
      makeCommentPayload({
        pullRequest: null,
      }),
    );

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            prNumber: 42,
            prTitle: 'Update backend',
          }),
        }),
      }),
    );
  });

  it('ignores comments from the deployment token identity', async () => {
    const result = await handleGiteaComment(
      makeCommentPayload({
        sender: { id: 11, login: 'roomote-bot' },
        comment: { user: { id: 11, login: 'roomote-bot' } },
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'roomote_authored_comment',
    });
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('requires linked commenter attribution for explicit mentions', async () => {
    await handleGiteaComment(makeCommentPayload());

    expect(mockGetGiteaAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        ignoreAuthorPolicy: true,
        requireLinkedSenderAccount: true,
        payload: expect.objectContaining({
          commentAuthor: expect.objectContaining({ login: 'alice' }),
        }),
      }),
    );
  });
});
