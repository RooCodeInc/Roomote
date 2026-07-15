const {
  mockEnqueueTask,
  mockGetTaskUrl,
  mockGetGiteaAutomationTargets,
  mockCreateGiteaPullRequestComment,
  mockGetGiteaDeploymentUser,
  mockFindActiveGitHubPrReviewTask,
  mockFindReusableGitHubPrFollowUpOwner,
  mockSendMessageToTask,
  mockSteerMessageToTask,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockGetTaskUrl: vi.fn(),
  mockGetGiteaAutomationTargets: vi.fn(),
  mockCreateGiteaPullRequestComment: vi.fn(),
  mockGetGiteaDeploymentUser: vi.fn(),
  mockFindActiveGitHubPrReviewTask: vi.fn(),
  mockFindReusableGitHubPrFollowUpOwner: vi.fn(),
  mockSendMessageToTask: vi.fn(),
  mockSteerMessageToTask: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
  getTaskUrl: mockGetTaskUrl,
}));

vi.mock('@roomote/gitea', () => ({
  createGiteaPullRequestComment: mockCreateGiteaPullRequestComment,
  getGiteaDeploymentUser: mockGetGiteaDeploymentUser,
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

import { RunStatus, TaskPayloadKind } from '@roomote/types';

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
    mockEnqueueTask.mockReset();
    mockGetTaskUrl.mockReset();
    mockGetGiteaAutomationTargets.mockReset();
    mockCreateGiteaPullRequestComment.mockReset();
    mockGetGiteaDeploymentUser.mockReset();
    mockFindActiveGitHubPrReviewTask.mockReset();
    mockFindReusableGitHubPrFollowUpOwner.mockReset();
    mockSendMessageToTask.mockReset();
    mockSteerMessageToTask.mockReset();

    mockGetGiteaDeploymentUser.mockResolvedValue(null);
    mockGetGiteaAutomationTargets.mockResolvedValue({
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
    mockCreateGiteaPullRequestComment.mockResolvedValue({ id: 1 });
    mockFindActiveGitHubPrReviewTask.mockResolvedValue(null);
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
    mockEnqueueTask.mockResolvedValue({ id: 1234, taskId: 'task-1' });
    mockGetTaskUrl.mockReturnValue('https://roomote.example/tasks/task-1');
    mockSendMessageToTask.mockResolvedValue({ success: true });
    mockSteerMessageToTask.mockResolvedValue({ success: true });
  });

  it('enqueues a Gitea PR review task when a mention has no reusable owner', async () => {
    const result = await handleGiteaComment(makeCommentPayload());

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
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
    // A repository row without a recorded host omits the payload host field
    // entirely so resolution falls back to (provider, fullName).
    const [{ task }] = mockEnqueueTask.mock.calls[0]! as unknown as [
      { task: { payload: Record<string, unknown> } },
    ];
    expect('sourceControlHost' in task.payload).toBe(false);
  });

  it('selects and stamps the webhook host among same-name repositories on multiple hosts', async () => {
    // Two active rows share the repository identity; only the host differs.
    const rows = [
      { id: 'repo-host-a', host: 'gitea.host-a.example' },
      { id: 'repo-host-b', host: 'gitea.host-b.example' },
    ];
    mockGetGiteaAutomationTargets.mockImplementation(
      async ({ webhookHost }: { webhookHost?: string | null }) => {
        const repo = rows.find((row) => row.host === webhookHost);
        return repo
          ? {
              status: 'ok',
              targets: [
                {
                  id: `gitea:pr_review:${repo.id}`,
                  settings: null,
                  repo,
                  repositoryIds: [repo.id],
                  userId: 'user-1',
                },
              ],
            }
          : { status: 'error', message: 'no matching repository row' };
      },
    );

    await handleGiteaComment(
      makeCommentPayload({
        pullRequest: {
          html_url: 'https://gitea.host-a.example/acme/backend/pulls/42',
        },
      }),
    );

    // The handler derives the instance host from the webhook URL...
    expect(mockGetGiteaAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({ webhookHost: 'gitea.host-a.example' }),
    );
    // ...and the launched payload pins the matching row's host.
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlHost: 'gitea.host-a.example',
          }),
        }),
      }),
    );
  });

  it('stamps the repository host into mention review payloads when the repository row has one', async () => {
    mockGetGiteaAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitea:pr_review:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: 'git.example.com' },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });

    await handleGiteaComment(makeCommentPayload());

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlProvider: 'gitea',
            // Pins repository resolution to the webhook repository's host.
            sourceControlHost: 'git.example.com',
          }),
        }),
      }),
    );
  });

  it('routes mentions into a reusable active task before starting a new review', async () => {
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue({
      taskId: 'task-existing',
      status: RunStatus.Running,
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
    expect(mockEnqueueTask).not.toHaveBeenCalled();
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
    expect(mockEnqueueTask).not.toHaveBeenCalled();
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
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('replies when no active environment target exists', async () => {
    mockGetGiteaAutomationTargets.mockResolvedValue({
      status: 'error',
      message:
        'no environment mapping associated with [gitea:123, acme/backend]',
    });

    const result = await handleGiteaComment(makeCommentPayload());

    expect(result).toEqual({ status: 'ok', message: 'reviewer_gate_miss' });
    expect(mockCreateGiteaPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('settings/environments'),
      }),
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('handles issue comment payloads that only include issue PR context', async () => {
    const result = await handleGiteaComment(
      makeCommentPayload({
        pullRequest: null,
      }),
    );

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
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
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('ignores comments from the deployment token identity even without a roomote username prefix', async () => {
    mockGetGiteaDeploymentUser.mockResolvedValue({
      id: 99,
      login: 'deploy-bot',
    });

    const result = await handleGiteaComment(
      makeCommentPayload({
        sender: { id: 99, login: 'deploy-bot' },
        comment: { user: { id: 99, login: 'deploy-bot' } },
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'roomote_authored_comment',
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('ignores deployment-authored comments when only the Gitea user id matches', async () => {
    // Login strings can drift across username fields; stable id must still stop loops.
    mockGetGiteaDeploymentUser.mockResolvedValue({
      id: 99,
      login: 'ci-agent',
    });

    const result = await handleGiteaComment(
      makeCommentPayload({
        sender: { id: 99, login: 'CI-Agent-Renamed' },
        comment: {
          body: '@roomote I started a pull request review task for this request',
          user: { id: 99, username: 'CI-Agent-Renamed' },
        },
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'roomote_authored_comment',
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('still enqueues mentions from non-deployment authors without a roomote prefix', async () => {
    mockGetGiteaDeploymentUser.mockResolvedValue({
      id: 99,
      login: 'ci-agent',
    });

    const result = await handleGiteaComment(
      makeCommentPayload({
        sender: { id: 10, login: 'alice' },
        comment: { user: { id: 10, login: 'alice' } },
      }),
    );

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueTask).toHaveBeenCalled();
  });

  it('falls back to sender when comment.user has no usable username', async () => {
    const result = await handleGiteaComment(
      makeCommentPayload({
        sender: { id: 10, login: 'alice' },
        comment: {
          // Partial comment.user with id only — username lives on sender.
          user: { id: 10 },
        },
      }),
    );

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: { kind: 'user', userId: 'user-1' },
      }),
    );
  });

  it('falls back to sender when comment.user.login is blank', async () => {
    const result = await handleGiteaComment(
      makeCommentPayload({
        sender: { id: 10, login: 'alice' },
        comment: {
          user: { id: 10, login: '' },
        },
      }),
    );

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueTask).toHaveBeenCalled();
  });

  it('ignores deployment-authored comments when only sender carries the login', async () => {
    // No deployment id — id match must not hide the sender.login path.
    mockGetGiteaDeploymentUser.mockResolvedValue({
      login: 'ci-agent',
    });

    const result = await handleGiteaComment(
      makeCommentPayload({
        // comment.user intentionally has a non-matching id and no username.
        sender: { id: 99, login: 'ci-agent' },
        comment: {
          body: '@roomote I started a pull request review task for this request',
          user: { id: 1 },
        },
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'roomote_authored_comment',
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
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
