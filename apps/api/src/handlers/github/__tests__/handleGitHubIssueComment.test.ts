const {
  mockGetGitHubAutomationTargets,
  mockGetInstallationOctokit,
  mockEnqueueTask,
  mockGetTaskUrl,
  mockDbSelect,
  mockFindReusableGitHubIssueTaskOwner,
  mockSendMessageToTask,
  mockSteerMessageToTask,
  mockFindLatestTaskRun,
} = vi.hoisted(() => ({
  mockGetGitHubAutomationTargets: vi.fn(),
  mockGetInstallationOctokit: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockGetTaskUrl: vi.fn(),
  mockDbSelect: vi.fn(),
  mockFindReusableGitHubIssueTaskOwner: vi.fn(),
  mockSendMessageToTask: vi.fn(),
  mockSteerMessageToTask: vi.fn(),
  mockFindLatestTaskRun: vi.fn(),
}));

// Prompt-framing fakes use distinctive markers so tests can assert the
// handler routes each piece of text through the right builder; the real
// escaping/wrapping behavior is unit-tested in @roomote/cloud-agents.
vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
  getTaskUrl: mockGetTaskUrl,
  buildMentionRequestBlock: (text: string) =>
    `<mention_request>${text}</mention_request>`,
  buildUntrustedExternalContentBlock: ({
    source,
    text,
  }: {
    source: string;
    text: string;
  }) =>
    `<untrusted_external_content source="${source}">${text}</untrusted_external_content>`,
  buildUntrustedContentPolicy: () => '<untrusted_content_policy/>',
  escapeTaskContextText: (value: string) => value,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: mockDbSelect,
  },
  environmentRepositoryMappings: {
    environmentId: 'environmentId',
    repositoryId: 'repositoryId',
  },
  eq: vi.fn((...args: unknown[]) => args),
  asc: vi.fn((value: unknown) => value),
  findReusableGitHubIssueTaskOwner: mockFindReusableGitHubIssueTaskOwner,
}));

vi.mock('@roomote/github', () => ({
  Schemas: {
    isRoomoteGitHubLogin: vi.fn(() => false),
  },
  getEffectiveGitHubAppSlug: vi.fn(() => 'roomote'),
  getInstallationOctokit: mockGetInstallationOctokit,
}));

vi.mock('../getGitHubAutomationTargets', () => ({
  getGitHubAutomationTargets: mockGetGitHubAutomationTargets,
}));

vi.mock('../../tasks/sendMessageToTask', () => ({
  sendMessageToTask: mockSendMessageToTask,
  steerMessageToTask: mockSteerMessageToTask,
}));

vi.mock('../../tasks/helpers', () => ({
  findLatestTaskRun: mockFindLatestTaskRun,
}));

vi.mock('@roomote/env', () => ({
  Env: {
    R_GITHUB_APP_SLUG: 'roomote',
    R_APP_URL: 'https://app.roomote.dev',
  },
}));

import { RunStatus, TaskPayloadKind } from '@roomote/types';

import { handleGitHubIssueComment } from '../handleGitHubIssueComment';
import type { WebhookIssueCommentCreated } from '../types';

function makePayload(
  overrides: Partial<WebhookIssueCommentCreated> = {},
): WebhookIssueCommentCreated {
  return {
    action: 'created',
    installation: { id: 123 },
    repository: {
      id: 456,
      full_name: 'acme/api',
      name: 'api',
      owner: { login: 'acme' },
      private: true,
      html_url: 'https://github.com/acme/api',
      default_branch: 'main',
    },
    sender: {
      id: 99,
      login: 'alice',
      type: 'User',
    },
    issue: {
      number: 42,
      title: 'Ship it',
      body: 'Please fix the bug',
      html_url: 'https://github.com/acme/api/issues/42',
      user: { login: 'bob' },
    },
    comment: {
      id: 777,
      body: '@roomote please take a look',
      user: { login: 'alice' },
    },
    ...overrides,
  } as WebhookIssueCommentCreated;
}

describe('handleGitHubIssueComment', () => {
  const createComment = vi.fn().mockResolvedValue({});
  const timelineRequest = vi.fn().mockResolvedValue({ data: [] });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    timelineRequest.mockResolvedValue({ data: [] });
    mockGetInstallationOctokit.mockResolvedValue({
      rest: {
        issues: {
          createComment,
        },
      },
      request: timelineRequest,
    });
    mockGetTaskUrl.mockReturnValue('https://app.roomote.dev/task/task-1');
    mockEnqueueTask.mockResolvedValue({ id: 11, taskId: 'task-1' });
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue(null);
    mockSendMessageToTask.mockResolvedValue({ success: true, result: {} });
    mockSteerMessageToTask.mockResolvedValue({ success: true, result: {} });
    mockFindLatestTaskRun.mockResolvedValue(null);
    mockGetGitHubAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'github:pr_conflict_resolve:repo-1',
          workflow: 'pr_conflict_resolve',
          settings: null,
          repo: { id: 'repo-1', fullName: 'acme/api' },
          collaborators: [],
          repositoryIds: ['repo-1'],
          properties: {
            userId: 'user-1',
            githubLogin: 'alice',
            githubUserId: 99,
          },
        },
      ],
    });
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([{ environmentId: 'env-1' }]),
        }),
      }),
    });
  });

  it('starts a standard task for a plain issue @mention', async () => {
    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({
      status: 'ok',
      metadata: { ids: [11] },
    });
    expect(mockFindReusableGitHubIssueTaskOwner).toHaveBeenCalledWith({
      repoFullName: 'acme/api',
      issueNumber: 42,
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            repo: 'acme/api',
            environmentId: 'env-1',
            selectedRepositories: ['acme/api'],
            linkedWorkItems: [
              expect.objectContaining({
                provider: 'github',
                identifier: '42',
                repository: 'acme/api',
              }),
            ],
          }),
        }),
        surface: 'github',
        workflow: 'standard',
        initiator: { kind: 'user', userId: 'user-1' },
      }),
    );
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
        body: expect.stringContaining('See task'),
      }),
    );
  });

  it('frames the mention comment and issue body as delimited untrusted content', async () => {
    const result = await handleGitHubIssueComment(makePayload());

    expect(result.status).toBe('ok');
    const description = mockEnqueueTask.mock.calls[0]?.[0].task.payload
      .description as string;
    expect(description).toContain(
      '<mention_request>@roomote please take a look</mention_request>',
    );
    expect(description).toContain(
      '<untrusted_external_content source="github_issue_body">Please fix the bug</untrusted_external_content>',
    );
    expect(description).toContain('authored by @bob');
    expect(description).toContain('<untrusted_content_policy/>');
  });

  it('includes linked pull requests and issues from the timeline in mention context', async () => {
    timelineRequest.mockResolvedValue({
      data: [
        {
          event: 'cross-referenced',
          source: {
            issue: {
              number: 963,
              title: 'feat: enable image support for DeepSeek V4 models',
              html_url: 'https://github.com/acme/api/pull/963',
              state: 'open',
              pull_request: {},
              repository: { full_name: 'acme/api' },
            },
          },
        },
      ],
    });

    const result = await handleGitHubIssueComment(makePayload());

    expect(result.status).toBe('ok');
    expect(timelineRequest).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline',
      expect.objectContaining({
        owner: 'acme',
        repo: 'api',
        issue_number: 42,
      }),
    );
    const description = mockEnqueueTask.mock.calls[0]?.[0].task.payload
      .description as string;
    expect(description).toContain(
      'Linked issues and pull requests (context only):',
    );
    expect(description).toContain('source="github_linked_references"');
    expect(description).toContain(
      'Pull request acme/api#963 — feat: enable image support for DeepSeek V4 models',
    );
  });

  it('does not duplicate the issue body when the mention is the issue body itself', async () => {
    const issueBody = 'Take a look at this crash please, @roomote';
    const base = makePayload();
    // `issues.opened` shape: no comment object, the issue body is the mention.
    const result = await handleGitHubIssueComment({
      installation: base.installation,
      repository: base.repository,
      sender: base.sender,
      issue: {
        number: 42,
        title: 'Ship it',
        body: issueBody,
        html_url: 'https://github.com/acme/api/issues/42',
        user: { login: 'alice' },
      },
      mentionBody: issueBody,
    });

    expect(result.status).toBe('ok');
    const description = mockEnqueueTask.mock.calls[0]?.[0].task.payload
      .description as string;
    expect(description).toContain(
      `<mention_request>${issueBody}</mention_request>`,
    );
    expect(description).not.toContain('source="github_issue_body"');
    expect(description).toContain('<untrusted_content_policy/>');
  });

  it('routes a second issue @mention into the existing task', async () => {
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue({
      runId: 9,
      taskId: 'task-existing',
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      delivery: 'attach',
    });
    mockGetTaskUrl.mockReturnValue(
      'https://app.roomote.dev/task/task-existing',
    );

    const result = await handleGitHubIssueComment(
      makePayload({
        comment: {
          id: 778,
          body: '@roomote also fix the tests',
          user: { login: 'alice' },
        } as WebhookIssueCommentCreated['comment'],
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'active_issue_owner_routed',
    });
    expect(mockSteerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-existing',
        userId: 'user-1',
        message: expect.stringContaining(
          '<mention_request>@roomote also fix the tests</mention_request>',
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
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('existing task for this issue'),
      }),
    );
  });

  it('includes linked references on follow-up issue mentions', async () => {
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue({
      runId: 9,
      taskId: 'task-existing',
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      delivery: 'attach',
    });
    timelineRequest.mockResolvedValue({
      data: [
        {
          event: 'cross-referenced',
          source: {
            issue: {
              number: 963,
              title: 'Linked PR',
              html_url: 'https://github.com/acme/api/pull/963',
              state: 'open',
              pull_request: {},
              repository: { full_name: 'acme/api' },
            },
          },
        },
      ],
    });

    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'active_issue_owner_routed',
    });
    expect(mockSteerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          'Pull request acme/api#963 — Linked PR',
        ),
      }),
    );
  });

  it('queues a second issue @mention onto a non-running owner via sendMessage', async () => {
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue({
      runId: 9,
      taskId: 'task-existing',
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      delivery: 'attach',
    });

    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'active_issue_owner_routed',
    });
    expect(mockSendMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-existing',
        userId: 'user-1',
      }),
    );
    expect(mockSteerMessageToTask).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('waits for a booting issue task to accept messages before falling back', async () => {
    vi.useFakeTimers();
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue({
      runId: 9,
      taskId: 'task-existing',
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Pending,
      taskPhase: null,
      delivery: 'attach',
    });
    mockSteerMessageToTask
      .mockResolvedValueOnce({
        success: false,
        error: 'no active sandbox',
        status: 409,
      })
      .mockResolvedValueOnce({ success: true, result: {} });
    mockFindLatestTaskRun
      .mockResolvedValueOnce({
        id: 9,
        status: RunStatus.Pending,
        taskPhase: null,
        sandboxServerUrl: null,
      })
      .mockResolvedValueOnce({
        id: 9,
        status: RunStatus.Running,
        taskPhase: 'running',
        sandboxServerUrl: 'https://sandbox.example',
      });

    const resultPromise = handleGitHubIssueComment(makePayload());
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(result).toEqual({
      status: 'ok',
      message: 'active_issue_owner_routed',
    });
    expect(mockSteerMessageToTask).toHaveBeenCalledTimes(2);
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('retries when sandbox URL exists but the RPC is still booting', async () => {
    vi.useFakeTimers();
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue({
      runId: 9,
      taskId: 'task-existing',
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      delivery: 'attach',
    });
    mockSteerMessageToTask
      .mockResolvedValueOnce({
        success: false,
        error:
          "The task hasn't started yet — the sandbox is still booting. Try again in a few seconds.",
        status: 409,
      })
      .mockResolvedValueOnce({ success: true, result: {} });
    mockFindLatestTaskRun.mockResolvedValue({
      id: 9,
      status: RunStatus.Running,
      taskPhase: 'running',
      sandboxServerUrl: 'https://sandbox.example',
    });

    const resultPromise = handleGitHubIssueComment(makePayload());
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(result).toEqual({
      status: 'ok',
      message: 'active_issue_owner_routed',
    });
    expect(mockSteerMessageToTask).toHaveBeenCalledTimes(2);
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('falls back to starting a new task when follow-up delivery fails', async () => {
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue({
      runId: 9,
      taskId: 'task-existing',
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      delivery: 'attach',
    });
    mockSteerMessageToTask.mockResolvedValue({
      success: false,
      error: 'permanent failure',
      status: 500,
    });

    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({
      status: 'ok',
      metadata: { ids: [11] },
    });
    expect(mockEnqueueTask).toHaveBeenCalled();
    expect(mockFindLatestTaskRun).not.toHaveBeenCalled();
  });

  it('prompts the commenter to link GitHub before starting work', async () => {
    mockGetGitHubAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'GitHub user alice is not linked',
    });

    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('GitHub account linked'),
      }),
    );
  });

  it('requires an environment mapped to the repository', async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({ status: 'ok', message: 'environment_required' });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('no Roomote environment is mapped'),
      }),
    );
  });

  it('ignores comments without a bot mention', async () => {
    const result = await handleGitHubIssueComment(
      makePayload({
        comment: {
          id: 777,
          body: 'just a regular comment',
          user: { login: 'alice' },
        } as WebhookIssueCommentCreated['comment'],
      }),
    );

    expect(result).toEqual({ status: 'ok', message: 'no_mention' });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('starts a task from an issue body mention when no comment is present', async () => {
    const result = await handleGitHubIssueComment({
      installation: { id: 123 } as WebhookIssueCommentCreated['installation'],
      repository: makePayload().repository,
      sender: makePayload().sender,
      issue: {
        ...makePayload().issue,
        body: '@roomote please investigate this',
      },
      mentionBody: '@roomote please investigate this',
    });

    expect(result).toEqual({
      status: 'ok',
      metadata: { ids: [11] },
    });
    expect(mockEnqueueTask).toHaveBeenCalled();
  });
});
