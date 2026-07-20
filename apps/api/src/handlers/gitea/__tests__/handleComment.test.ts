const {
  mockEnqueueTask,
  mockGetTaskUrl,
  mockGetGiteaAutomationTargets,
  mockCreateGiteaPullRequestComment,
  mockCreateGiteaIssueComment,
  mockGetGiteaDeploymentUser,
  mockFindActiveGitHubPrReviewTask,
  mockFindReusableGitHubPrFollowUpOwner,
  mockFindReusableGitHubIssueTaskOwner,
  mockSendMessageToTask,
  mockSteerMessageToTask,
  mockDbSelect,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockGetTaskUrl: vi.fn(),
  mockGetGiteaAutomationTargets: vi.fn(),
  mockCreateGiteaPullRequestComment: vi.fn(),
  mockCreateGiteaIssueComment: vi.fn(),
  mockGetGiteaDeploymentUser: vi.fn(),
  mockFindActiveGitHubPrReviewTask: vi.fn(),
  mockFindReusableGitHubPrFollowUpOwner: vi.fn(),
  mockFindReusableGitHubIssueTaskOwner: vi.fn(),
  mockSendMessageToTask: vi.fn(),
  mockSteerMessageToTask: vi.fn(),
  mockDbSelect: vi.fn(),
}));

// Prompt-framing fakes use distinctive markers so tests can assert the
// handler routes each piece of text through the right builder; the real
// escaping/wrapping behavior is unit-tested in @roomote/cloud-agents.
vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
  getTaskUrl: mockGetTaskUrl,
  buildMentionRequestBlock: (text: string) =>
    `<mention_request>${text}</mention_request>`,
  buildUntrustedContentPolicy: () => '<untrusted_content_policy/>',
  buildUntrustedExternalContentBlock: ({
    source,
    text,
  }: {
    source: string;
    text: string;
  }) =>
    `<untrusted_external_content source="${source}">${text}</untrusted_external_content>`,
  escapeTaskContextText: (value: string) => value,
}));

vi.mock('@roomote/gitea', () => ({
  createGiteaPullRequestComment: mockCreateGiteaPullRequestComment,
  createGiteaIssueComment: mockCreateGiteaIssueComment,
  getGiteaDeploymentUser: mockGetGiteaDeploymentUser,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
  environmentRepositoryMappings: {
    environmentId: 'environmentId',
    repositoryId: 'repositoryId',
  },
  eq: vi.fn((...args: unknown[]) => args),
  asc: vi.fn((value: unknown) => value),
  findActiveGitHubPrReviewTask: (...args: unknown[]) =>
    mockFindActiveGitHubPrReviewTask(...args),
  findReusableGitHubPrFollowUpOwner: (...args: unknown[]) =>
    mockFindReusableGitHubPrFollowUpOwner(...args),
  findReusableGitHubIssueTaskOwner: (...args: unknown[]) =>
    mockFindReusableGitHubIssueTaskOwner(...args),
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

vi.mock('../../tasks/helpers', () => ({
  findLatestTaskRun: vi.fn(),
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
    issue?: Partial<
      NonNullable<GiteaPullRequestCommentWebhook['issue']>
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
    comment: {
      id: 900,
      body: '@roomote please review this',
      user: { id: 10, login: 'alice' },
      ...overrides.comment,
    },
  };

  if (overrides.issue !== null) {
    payload.issue = {
      number: 42,
      title: 'Update backend',
      body: 'Issue body details',
      html_url: 'https://git.example.com/acme/backend/issues/42',
      ...overrides.issue,
    };
  }

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

function mockEnvironmentMappings(
  rows: Array<{ environmentId: string }> = [{ environmentId: 'env-1' }],
) {
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        orderBy: async () => rows,
      }),
    }),
  });
}

describe('handleGiteaComment', () => {
  beforeEach(() => {
    mockEnqueueTask.mockReset();
    mockGetTaskUrl.mockReset();
    mockGetGiteaAutomationTargets.mockReset();
    mockCreateGiteaPullRequestComment.mockReset();
    mockCreateGiteaIssueComment.mockReset();
    mockGetGiteaDeploymentUser.mockReset();
    mockFindActiveGitHubPrReviewTask.mockReset();
    mockFindReusableGitHubPrFollowUpOwner.mockReset();
    mockFindReusableGitHubIssueTaskOwner.mockReset();
    mockSendMessageToTask.mockReset();
    mockSteerMessageToTask.mockReset();
    mockDbSelect.mockReset();

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
    mockCreateGiteaIssueComment.mockResolvedValue({ id: 2 });
    mockFindActiveGitHubPrReviewTask.mockResolvedValue(null);
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue(null);
    mockEnvironmentMappings();
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
        message: expect.stringContaining(
          '<mention_request>@roomote please review this</mention_request>',
        ),
      }),
    );
    expect(mockSteerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('<untrusted_content_policy/>'),
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
          'before issue and pull request comments can start work here',
        ),
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

  it('handles PR issue_comment payloads that only include issue context when is_pull is true', async () => {
    const result = await handleGiteaComment(
      makeCommentPayload({
        pullRequest: null,
        isPull: true,
      }),
    );

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.GithubPrReview,
          payload: expect.objectContaining({
            prNumber: 42,
            prTitle: 'Update backend',
          }),
        }),
      }),
    );
  });

  it('starts a standard issue task for plain issue_comment mentions', async () => {
    const result = await handleGiteaComment(
      makeCommentPayload({
        isPull: false,
        pullRequest: null,
        issue: {
          number: 55,
          title: 'Login broken',
          body: 'Steps to reproduce',
          html_url: 'https://git.example.com/acme/backend/issues/55',
        },
        comment: {
          body: '@roomote fix this bug',
        },
      }),
    );

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockGetGiteaAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'pr_conflict_resolve',
        requireLinkedSenderAccount: true,
      }),
    );
    expect(mockFindReusableGitHubIssueTaskOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: 'acme/backend',
        issueNumber: 55,
        sourceControlProvider: 'gitea',
      }),
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            repo: 'acme/backend',
            sourceControlProvider: 'gitea',
            environmentId: 'env-1',
            description: expect.stringContaining(
              '<mention_request>@roomote fix this bug</mention_request>',
            ),
            linkedWorkItems: [
              expect.objectContaining({
                provider: 'gitea',
                identifier: '55',
                repository: 'acme/backend',
              }),
            ],
          }),
        }),
        workflow: 'standard',
        surface: 'gitea',
        initiator: { kind: 'user', userId: 'user-1' },
      }),
    );
    expect(mockCreateGiteaIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'acme/backend',
        issueNumber: 55,
        body: expect.stringContaining('I started a task for this issue'),
      }),
    );
    expect(mockCreateGiteaPullRequestComment).not.toHaveBeenCalled();
  });

  it('does not treat plain issues as pull requests when synthesizing context', async () => {
    await handleGiteaComment(
      makeCommentPayload({
        isPull: false,
        pullRequest: null,
        issue: { number: 77, title: 'Plain issue' },
        comment: { body: '@roomote look at this' },
      }),
    );

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.not.objectContaining({
            prNumber: expect.anything(),
          }),
        }),
      }),
    );
    expect(mockFindReusableGitHubPrFollowUpOwner).not.toHaveBeenCalled();
  });

  it('routes repeat issue mentions into the reusable issue task', async () => {
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue({
      taskId: 'task-issue',
      status: RunStatus.Running,
      taskPhase: 'running',
    });
    mockGetTaskUrl.mockReturnValue('https://roomote.example/tasks/task-issue');

    const result = await handleGiteaComment(
      makeCommentPayload({
        isPull: false,
        pullRequest: null,
        issue: { number: 55, title: 'Login broken' },
        comment: { body: '@roomote also check logout' },
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'active_issue_owner_routed',
    });
    expect(mockSteerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-issue',
        message: expect.stringContaining(
          '<mention_request>@roomote also check logout</mention_request>',
        ),
      }),
    );
    expect(mockCreateGiteaIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('existing task for this issue'),
      }),
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('prompts for a linked account on plain issue mentions', async () => {
    mockGetGiteaAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'Gitea user alice is not linked',
    });

    const result = await handleGiteaComment(
      makeCommentPayload({
        isPull: false,
        pullRequest: null,
        comment: { body: '@roomote fix this' },
      }),
    );

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mockCreateGiteaIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('settings?service=gitea'),
      }),
    );
    expect(mockCreateGiteaIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          'before issue and pull request comments can start work here',
        ),
      }),
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('requires a mapped environment for plain issue mentions', async () => {
    mockEnvironmentMappings([]);

    const result = await handleGiteaComment(
      makeCommentPayload({
        isPull: false,
        pullRequest: null,
        comment: { body: '@roomote fix this' },
      }),
    );

    expect(result).toEqual({ status: 'ok', message: 'environment_required' });
    expect(mockCreateGiteaIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('settings/environments'),
      }),
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
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
