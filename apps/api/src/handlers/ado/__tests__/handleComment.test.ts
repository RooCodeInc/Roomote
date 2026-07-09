const {
  mockEnqueueCloudTask,
  mockGetTaskUrl,
  mockGetAdoAutomationTargets,
  mockGetAdoDeploymentUser,
  mockCreateAdoPullRequestComment,
  mockFindActiveGitHubPrReviewTask,
  mockFindReusableGitHubPrFollowUpOwner,
  mockSendMessageToTask,
  mockSteerMessageToTask,
} = vi.hoisted(() => ({
  mockEnqueueCloudTask: vi.fn(),
  mockGetTaskUrl: vi.fn(),
  mockGetAdoAutomationTargets: vi.fn(),
  mockGetAdoDeploymentUser: vi.fn(),
  mockCreateAdoPullRequestComment: vi.fn(),
  mockFindActiveGitHubPrReviewTask: vi.fn(),
  mockFindReusableGitHubPrFollowUpOwner: vi.fn(),
  mockSendMessageToTask: vi.fn(),
  mockSteerMessageToTask: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueCloudTask: mockEnqueueCloudTask,
  getTaskUrl: mockGetTaskUrl,
}));

vi.mock('@roomote/ado', () => ({
  getAdoDeploymentUser: mockGetAdoDeploymentUser,
  createAdoPullRequestComment: mockCreateAdoPullRequestComment,
}));

vi.mock('@roomote/db/server', () => ({
  findActiveGitHubPrReviewTask: mockFindActiveGitHubPrReviewTask,
  findReusableGitHubPrFollowUpOwner: mockFindReusableGitHubPrFollowUpOwner,
}));

vi.mock('../getAdoAutomationTargets', () => ({
  getAdoAutomationTargets: mockGetAdoAutomationTargets,
  getAdoIdentityName: (identity?: {
    uniqueName?: string;
    displayName?: string;
  }) => identity?.uniqueName ?? identity?.displayName,
  isRoomoteAdoIdentity: (identityName: string) => {
    const normalized = identityName.toLowerCase().trim();
    return (
      normalized.startsWith('roomote') || normalized.startsWith('@roomote')
    );
  },
}));

vi.mock('../../tasks/sendMessageToTask', () => ({
  sendMessageToTask: mockSendMessageToTask,
  steerMessageToTask: mockSteerMessageToTask,
}));

import { CloudTaskStatus, CloudTaskType } from '@roomote/types';

import { handleAdoComment } from '../handleComment';
import type { AdoPullRequestCommentWebhook } from '../types';

function makeCommentPayload(
  overrides: {
    comment?: Partial<AdoPullRequestCommentWebhook['resource']['comment']>;
    pullRequest?: Partial<
      AdoPullRequestCommentWebhook['resource']['pullRequest']
    >;
  } = {},
): AdoPullRequestCommentWebhook {
  return {
    id: 'comment-delivery-1',
    eventType: 'ms.vss-code.git-pullrequest-comment-event',
    publisherId: 'tfs',
    resourceContainers: {
      account: {
        baseUrl: 'https://dev.azure.com/acme/',
      },
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
          project: {
            id: 'project-1',
            name: 'Platform',
          },
        },
        pullRequestId: 42,
        title: 'Update backend',
        status: 'active',
        sourceRefName: 'refs/heads/feature/test',
        targetRefName: 'refs/heads/main',
        createdBy: {
          uniqueName: 'roomote-bot@acme.example',
        },
        lastMergeSourceCommit: {
          commitId: 'abc123',
        },
        _links: {
          web: {
            href: 'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
          },
        },
        ...overrides.pullRequest,
      },
    },
  };
}

describe('handleAdoComment', () => {
  beforeEach(() => {
    mockEnqueueCloudTask.mockReset();
    mockGetTaskUrl.mockReset();
    mockGetAdoAutomationTargets.mockReset();
    mockGetAdoDeploymentUser.mockReset();
    mockCreateAdoPullRequestComment.mockReset();
    mockFindActiveGitHubPrReviewTask.mockReset();
    mockFindReusableGitHubPrFollowUpOwner.mockReset();
    mockSendMessageToTask.mockReset();
    mockSteerMessageToTask.mockReset();

    mockGetAdoAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'ado:pr_reviewer:repo-1',
          settings: null,
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });
    mockGetAdoDeploymentUser.mockResolvedValue({
      id: 'ado-roomote-bot',
      uniqueName: 'roomote-bot@acme.example',
      displayName: 'Roomote Bot',
    });
    mockCreateAdoPullRequestComment.mockResolvedValue({
      threadId: '5',
      commentId: '1',
    });
    mockFindActiveGitHubPrReviewTask.mockResolvedValue(null);
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
    mockEnqueueCloudTask.mockResolvedValue({ id: 1234, taskId: 'task-1' });
    mockGetTaskUrl.mockReturnValue('https://roomote.example/tasks/task-1');
    mockSendMessageToTask.mockResolvedValue({ success: true });
    mockSteerMessageToTask.mockResolvedValue({ success: true });
  });

  it('enqueues an ADO PR review task when a mention has no reusable owner', async () => {
    const result = await handleAdoComment(makeCommentPayload());

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        attributionOverride: { kind: 'automatic', sourceKind: 'ado' },
        type: CloudTaskType.GithubPrReview,
        payload: expect.objectContaining({
          repo: 'acme/Platform/backend',
          sourceControlProvider: 'ado',
          prNumber: 42,
          prUrl:
            'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
          branch: 'feature/test',
          sha: 'abc123',
          targetBranch: 'main',
        }),
      }),
      expect.objectContaining({ launchClass: 'automation' }),
    );
    expect(mockCreateAdoPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'acme/Platform/backend',
        repositoryId: 'repo-1',
        pullRequestNumber: 42,
        threadId: '5',
        parentCommentId: 900,
        body: expect.stringContaining('started a pull request review task'),
      }),
    );
  });

  it('uses the legacy Visual Studio repository host as the organization fallback', async () => {
    const payload = makeCommentPayload({
      pullRequest: {
        repository: {
          id: 'repo-1',
          name: 'backend',
          project: {
            id: 'project-1',
            name: 'Platform',
          },
          webUrl: 'https://acme.visualstudio.com/Platform/_git/backend',
        },
        _links: undefined,
      },
    });
    payload.resourceContainers = undefined;

    await handleAdoComment(payload);

    expect(mockFindReusableGitHubPrFollowUpOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'acme/Platform/backend',
      }),
    );
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          repo: 'acme/Platform/backend',
        }),
      }),
      expect.any(Object),
    );
    expect(mockCreateAdoPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'acme/Platform/backend',
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

    const result = await handleAdoComment(makeCommentPayload());

    expect(result).toEqual({ status: 'ok', message: 'active_pr_owner_routed' });
    expect(mockSteerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-existing',
        userId: 'user-1',
        message: expect.stringContaining('mentioned Roomote in a comment'),
        senderMode: 'github_pr_follow_up',
      }),
    );
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
    expect(mockCreateAdoPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('existing task'),
      }),
    );
  });

  it('links to an active PR review instead of enqueuing a duplicate', async () => {
    mockFindActiveGitHubPrReviewTask.mockResolvedValue({
      taskId: 'review-task',
      jobId: 9,
      type: CloudTaskType.GithubPrReview,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      match: 'github_pr',
    });
    mockGetTaskUrl.mockReturnValue('https://roomote.example/tasks/review-task');

    const result = await handleAdoComment(makeCommentPayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'active_pr_review_linked',
    });
    expect(mockFindActiveGitHubPrReviewTask).toHaveBeenCalledWith({
      repoFullName: 'acme/Platform/backend',
      prNumber: 42,
      headSha: 'abc123',
    });
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
    expect(mockCreateAdoPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('already running'),
      }),
    );
  });

  it('ignores comments without an @roomote mention', async () => {
    const result = await handleAdoComment(
      makeCommentPayload({ comment: { content: 'just a normal comment' } }),
    );

    expect(result).toEqual({ status: 'ok', message: 'no_mention' });
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
    expect(mockCreateAdoPullRequestComment).not.toHaveBeenCalled();
  });

  it('detects mentions case-insensitively', async () => {
    const result = await handleAdoComment(
      makeCommentPayload({ comment: { content: 'ping @RooMote here' } }),
    );

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
  });

  it('ignores comments from the deployment token identity', async () => {
    mockGetAdoDeploymentUser.mockResolvedValue({
      id: 'ado-user-1',
      uniqueName: 'alice@acme.example',
      displayName: 'Alice',
    });

    const result = await handleAdoComment(makeCommentPayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'roomote_authored_comment',
    });
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
    expect(mockGetAdoAutomationTargets).not.toHaveBeenCalled();
  });

  it('processes mentions from a human whose email domain contains roomote', async () => {
    // Regression: users in a `roomote.*` Entra tenant have `@roomote…`
    // uniqueNames and must not be mistaken for Roomote's own bot.
    const result = await handleAdoComment(
      makeCommentPayload({
        comment: {
          author: {
            id: 'ado-user-2',
            uniqueName: 'dan@roomote.onmicrosoft.com',
            displayName: 'Dan Riccio',
          },
        },
      }),
    );

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueCloudTask).toHaveBeenCalled();
  });

  it('posts a reviewer-gate comment when no automation target is found', async () => {
    mockGetAdoAutomationTargets.mockResolvedValue({
      status: 'error',
      message: 'no active Azure DevOps repository',
    });

    const result = await handleAdoComment(makeCommentPayload());

    expect(result).toEqual({ status: 'ok', message: 'reviewer_gate_miss' });
    expect(mockCreateAdoPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'acme/Platform/backend',
        pullRequestNumber: 42,
        body: expect.stringContaining('could not start work'),
      }),
    );
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('bypasses the PR author policy for explicit mentions', async () => {
    await handleAdoComment(makeCommentPayload());

    expect(mockGetAdoAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        ignoreAuthorPolicy: true,
        requireLinkedSenderAccount: true,
        payload: expect.objectContaining({
          commentAuthor: expect.objectContaining({
            id: 'ado-user-1',
            uniqueName: 'alice@acme.example',
          }),
        }),
      }),
    );
  });

  it('prompts the commenter to link Azure DevOps before starting work', async () => {
    mockGetAdoAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'Azure DevOps user alice is not linked',
    });

    const result = await handleAdoComment(makeCommentPayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mockCreateAdoPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('Azure DevOps account linked'),
      }),
    );
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('creates a new response thread when the comment thread link is absent', async () => {
    await handleAdoComment(
      makeCommentPayload({ comment: { _links: undefined } }),
    );

    expect(mockCreateAdoPullRequestComment).toHaveBeenCalledWith(
      expect.not.objectContaining({
        threadId: expect.anything(),
      }),
    );
  });
});
