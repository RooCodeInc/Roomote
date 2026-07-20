const {
  mockEnqueueTask,
  mockGetTaskUrl,
  mockGetGitLabAutomationTargets,
  mockFindReusableGitHubPrFollowUpOwner,
  mockFindReusableGitHubIssueTaskOwner,
  mockFindActiveGitHubPrReviewTask,
  mockGetGitLabDeploymentUser,
  mockCreateGitLabMergeRequestNote,
  mockCreateGitLabIssueNote,
  mockSendMessageToTask,
  mockSteerMessageToTask,
  mockDbSelect,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockGetTaskUrl: vi.fn(),
  mockGetGitLabAutomationTargets: vi.fn(),
  mockFindReusableGitHubPrFollowUpOwner: vi.fn(),
  mockFindReusableGitHubIssueTaskOwner: vi.fn(),
  mockFindActiveGitHubPrReviewTask: vi.fn(),
  mockGetGitLabDeploymentUser: vi.fn(),
  mockCreateGitLabMergeRequestNote: vi.fn(),
  mockCreateGitLabIssueNote: vi.fn(),
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
  findReusableGitHubPrFollowUpOwner: mockFindReusableGitHubPrFollowUpOwner,
  findReusableGitHubIssueTaskOwner: mockFindReusableGitHubIssueTaskOwner,
  findActiveGitHubPrReviewTask: mockFindActiveGitHubPrReviewTask,
}));

vi.mock('@roomote/gitlab', () => ({
  getGitLabDeploymentUser: mockGetGitLabDeploymentUser,
  createGitLabMergeRequestNote: mockCreateGitLabMergeRequestNote,
  createGitLabIssueNote: mockCreateGitLabIssueNote,
}));

vi.mock('../getGitLabAutomationTargets', async () => {
  const actual = await vi.importActual<
    typeof import('../getGitLabAutomationTargets')
  >('../getGitLabAutomationTargets');
  return {
    ...actual,
    getGitLabAutomationTargets: mockGetGitLabAutomationTargets,
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

import { handleGitLabNote } from '../handleNote';
import type { GitLabNoteWebhook } from '../types';

function makeNotePayload(
  overrides: {
    note?: Partial<GitLabNoteWebhook['object_attributes']>;
    mergeRequest?: Partial<NonNullable<GitLabNoteWebhook['merge_request']>>;
    issue?: Partial<NonNullable<GitLabNoteWebhook['issue']>>;
    user?: GitLabNoteWebhook['user'];
    includeMergeRequest?: boolean;
    includeIssue?: boolean;
  } = {},
): GitLabNoteWebhook {
  const includeMergeRequest = overrides.includeMergeRequest ?? true;
  const includeIssue = overrides.includeIssue ?? false;

  return {
    object_kind: 'note',
    event_type: 'note',
    user: overrides.user ?? { id: 7, username: 'alice' },
    project: {
      id: 123,
      path_with_namespace: 'acme/backend',
      web_url: 'https://gitlab.com/acme/backend',
    },
    object_attributes: {
      id: 555,
      note: 'Hey @roomote please take a look',
      noteable_type: includeIssue ? 'Issue' : 'MergeRequest',
      action: 'create',
      ...overrides.note,
    },
    ...(includeMergeRequest
      ? {
          merge_request: {
            iid: 42,
            title: 'Update backend',
            url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
            source_branch: 'feature/test',
            target_branch: 'main',
            last_commit: { id: 'abc123' },
            ...overrides.mergeRequest,
          },
        }
      : {}),
    ...(includeIssue
      ? {
          issue: {
            iid: 17,
            title: 'Broken login',
            description: 'Repro steps for the crash',
            url: 'https://gitlab.com/acme/backend/-/issues/17',
            ...overrides.issue,
          },
        }
      : {}),
  };
}

describe('handleGitLabNote', () => {
  beforeEach(() => {
    mockEnqueueTask.mockReset();
    mockGetTaskUrl.mockReset();
    mockGetGitLabAutomationTargets.mockReset();
    mockFindReusableGitHubPrFollowUpOwner.mockReset();
    mockFindReusableGitHubIssueTaskOwner.mockReset();
    mockFindActiveGitHubPrReviewTask.mockReset();
    mockGetGitLabDeploymentUser.mockReset();
    mockCreateGitLabMergeRequestNote.mockReset();
    mockCreateGitLabIssueNote.mockReset();
    mockSendMessageToTask.mockReset();
    mockSteerMessageToTask.mockReset();
    mockDbSelect.mockReset();

    mockGetGitLabAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitlab:pr_review:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: null },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue(null);
    mockFindActiveGitHubPrReviewTask.mockResolvedValue(null);
    mockGetGitLabDeploymentUser.mockResolvedValue({
      id: 99,
      username: 'roomote-bot',
    });
    mockCreateGitLabMergeRequestNote.mockResolvedValue({ id: 1 });
    mockCreateGitLabIssueNote.mockResolvedValue({ id: 2 });
    mockEnqueueTask.mockResolvedValue({ id: 1234, taskId: 'task-1' });
    mockGetTaskUrl.mockReturnValue('https://app.roomote.dev/task/task-1');
    mockSendMessageToTask.mockResolvedValue({ success: true, result: {} });
    mockSteerMessageToTask.mockResolvedValue({ success: true, result: {} });
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([{ environmentId: 'env-1' }]),
        }),
      }),
    });
  });

  it('enqueues a GitLab MR review task when a mention has no reusable owner', async () => {
    const result = await handleGitLabNote(makeNotePayload());

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.GithubPrReview,
          payload: expect.objectContaining({
            repo: 'acme/backend',
            sourceControlProvider: 'gitlab',
            prNumber: 42,
            prUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
            headSha: 'abc123',
            branchName: 'feature/test',
            branch: 'feature/test',
            sha: 'abc123',
            targetBranch: 'main',
          }),
        }),
        // A human @roomote mention: the linked commenter is the initiator.
        initiator: { kind: 'user', userId: 'user-1' },
        workflow: 'pr_review',
        surface: 'gitlab',
        trigger: 'message',
        prLinkage: expect.objectContaining({
          provider: 'gitlab',
          repository: 'acme/backend',
          prNumber: 42,
        }),
      }),
    );
    expect(mockCreateGitLabMergeRequestNote).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 123,
        mergeRequestIid: 42,
        body: expect.stringContaining('review task'),
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
      { id: 'repo-host-a', host: 'gitlab.host-a.example' },
      { id: 'repo-host-b', host: 'gitlab.host-b.example' },
    ];
    mockGetGitLabAutomationTargets.mockImplementation(
      async ({ webhookHost }: { webhookHost?: string | null }) => {
        const repo = rows.find((row) => row.host === webhookHost);
        return repo
          ? {
              status: 'ok',
              targets: [
                {
                  id: `gitlab:pr_review:${repo.id}`,
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

    await handleGitLabNote(
      makeNotePayload({
        mergeRequest: {
          url: 'https://gitlab.host-a.example/acme/backend/-/merge_requests/42',
        },
      }),
    );

    // The handler derives the instance host from the webhook URL...
    expect(mockGetGitLabAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({ webhookHost: 'gitlab.host-a.example' }),
    );
    // ...and the launched payload pins the matching row's host.
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlHost: 'gitlab.host-a.example',
          }),
        }),
      }),
    );
  });

  it('stamps the repository host into mention review payloads when the repository row has one', async () => {
    mockGetGitLabAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitlab:pr_review:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: 'gitlab.example.com' },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });

    await handleGitLabNote(makeNotePayload());

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlProvider: 'gitlab',
            // Pins repository resolution to the webhook repository's host.
            sourceControlHost: 'gitlab.example.com',
          }),
        }),
      }),
    );
  });

  it('links to an active MR review instead of enqueuing a duplicate', async () => {
    mockFindActiveGitHubPrReviewTask.mockResolvedValue({
      taskId: 'review-task',
      runId: 9,
      type: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'running',
      match: 'github_pr',
    });

    const result = await handleGitLabNote(makeNotePayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'active_mr_review_linked',
    });
    expect(mockFindActiveGitHubPrReviewTask).toHaveBeenCalledWith({
      repoFullName: 'acme/backend',
      prNumber: 42,
      headSha: 'abc123',
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockCreateGitLabMergeRequestNote).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('already running'),
      }),
    );
  });

  it('does not run the active-review check when head SHA is unknown', async () => {
    await handleGitLabNote(
      makeNotePayload({ mergeRequest: { last_commit: undefined } }),
    );

    expect(mockFindActiveGitHubPrReviewTask).not.toHaveBeenCalled();
    expect(mockEnqueueTask).toHaveBeenCalled();
  });

  it('steers the note into an actively running reusable owner task', async () => {
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue({
      taskId: 'owner-task',
      runId: 5,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      match: 'task_pull_request',
      delivery: 'attach',
    });
    mockSteerMessageToTask.mockResolvedValue({ success: true, result: {} });

    const result = await handleGitLabNote(makeNotePayload());

    expect(result).toEqual({ status: 'ok', message: 'active_mr_owner_routed' });
    expect(mockSteerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'owner-task',
        userId: 'user-1',
        message: expect.stringContaining(
          '<mention_request>Hey @roomote please take a look</mention_request>',
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
    expect(mockCreateGitLabMergeRequestNote).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('existing task'),
      }),
    );
  });

  it('sends (resumes) the note when the reusable owner is idle', async () => {
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue({
      taskId: 'owner-task',
      runId: 5,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Completed,
      taskPhase: null,
      match: 'task_pull_request',
      delivery: 'resume',
    });
    mockSendMessageToTask.mockResolvedValue({ success: true, result: {} });

    const result = await handleGitLabNote(makeNotePayload());

    expect(result).toEqual({ status: 'ok', message: 'active_mr_owner_routed' });
    expect(mockSendMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'owner-task',
        senderMode: 'github_pr_follow_up',
      }),
    );
    expect(mockSteerMessageToTask).not.toHaveBeenCalled();
  });

  it('falls back to a new review task when owner delivery fails', async () => {
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue({
      taskId: 'owner-task',
      runId: 5,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      match: 'task_pull_request',
      delivery: 'attach',
    });
    mockSteerMessageToTask.mockResolvedValue({
      success: false,
      error: 'no active sandbox',
      status: 409,
    });

    const result = await handleGitLabNote(makeNotePayload());

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueTask).toHaveBeenCalled();
  });

  it('ignores notes without an @roomote mention', async () => {
    const result = await handleGitLabNote(
      makeNotePayload({ note: { note: 'just a normal comment' } }),
    );

    expect(result).toEqual({ status: 'ok', message: 'no_mention' });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockCreateGitLabMergeRequestNote).not.toHaveBeenCalled();
  });

  it('detects mentions case-insensitively', async () => {
    const result = await handleGitLabNote(
      makeNotePayload({ note: { note: 'ping @RooMote here' } }),
    );

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
  });

  it('ignores notes authored by a Roomote-prefixed user', async () => {
    const result = await handleGitLabNote(
      makeNotePayload({ user: { id: 1, username: 'roomote-bot' } }),
    );

    expect(result).toEqual({ status: 'ok', message: 'roomote_authored_note' });
    expect(mockGetGitLabAutomationTargets).not.toHaveBeenCalled();
  });

  it('ignores notes authored by the deployment token identity', async () => {
    mockGetGitLabDeploymentUser.mockResolvedValue({
      id: 42,
      username: 'ci-service-account',
    });

    const result = await handleGitLabNote(
      makeNotePayload({ user: { id: 42, username: 'ci-service-account' } }),
    );

    expect(result).toEqual({ status: 'ok', message: 'roomote_authored_note' });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('ignores notes authored by a project access token bot identity', async () => {
    const result = await handleGitLabNote(
      makeNotePayload({ user: { id: 8, username: 'project_123_bot_abcdef' } }),
    );

    expect(result).toEqual({ status: 'ok', message: 'roomote_authored_note' });
  });

  it('ignores GitLab system notes even when they echo a mention', async () => {
    const result = await handleGitLabNote(
      makeNotePayload({
        note: { note: 'mentioned in commit that pings @roomote', system: true },
      }),
    );

    expect(result).toEqual({ status: 'ok', message: 'system_note' });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('ignores notes on unsupported targets', async () => {
    const result = await handleGitLabNote(
      makeNotePayload({
        note: { noteable_type: 'Commit' },
        includeMergeRequest: false,
        includeIssue: false,
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'unsupported_noteable_type:Commit',
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('posts a reviewer-gate note when no automation target is found', async () => {
    mockGetGitLabAutomationTargets.mockResolvedValue({
      status: 'error',
      message: 'no active GitLab repository',
    });

    const result = await handleGitLabNote(makeNotePayload());

    expect(result).toEqual({ status: 'ok', message: 'reviewer_gate_miss' });
    expect(mockCreateGitLabMergeRequestNote).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 123,
        mergeRequestIid: 42,
      }),
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('prompts the commenter to link GitLab before starting work', async () => {
    mockGetGitLabAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'GitLab user alice is not linked',
    });

    const result = await handleGitLabNote(makeNotePayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mockCreateGitLabMergeRequestNote).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('GitLab account linked'),
      }),
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('bypasses the MR author policy for mentions', async () => {
    await handleGitLabNote(makeNotePayload());

    expect(mockGetGitLabAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreAuthorPolicy: true }),
    );
  });

  it('starts a standard task for a first @roomote mention on an issue', async () => {
    const result = await handleGitLabNote(
      makeNotePayload({
        includeMergeRequest: false,
        includeIssue: true,
      }),
    );

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockGetGitLabAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'pr_conflict_resolve',
        requireLinkedSenderAccount: true,
        ignoreAuthorPolicy: true,
      }),
    );
    expect(mockFindReusableGitHubIssueTaskOwner).toHaveBeenCalledWith({
      repoFullName: 'acme/backend',
      issueNumber: 17,
      sourceControlProvider: 'gitlab',
      host: null,
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            repo: 'acme/backend',
            sourceControlProvider: 'gitlab',
            environmentId: 'env-1',
            selectedRepositories: ['acme/backend'],
            linkedWorkItems: [
              expect.objectContaining({
                provider: 'gitlab',
                identifier: '17',
                repository: 'acme/backend',
                url: 'https://gitlab.com/acme/backend/-/issues/17',
                title: 'Broken login',
              }),
            ],
          }),
        }),
        initiator: { kind: 'user', userId: 'user-1' },
        workflow: 'standard',
        surface: 'gitlab',
        trigger: 'message',
      }),
    );
    const description = mockEnqueueTask.mock.calls[0]?.[0].task.payload
      .description as string;
    expect(description).toContain(
      '<mention_request>Hey @roomote please take a look</mention_request>',
    );
    expect(description).toContain(
      '<untrusted_external_content source="gitlab_issue_description">Repro steps for the crash</untrusted_external_content>',
    );
    expect(description).toContain('<untrusted_content_policy/>');
    expect(mockCreateGitLabIssueNote).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 123,
        issueIid: 17,
        body: expect.stringContaining('started a task for this issue'),
      }),
    );
    expect(mockCreateGitLabMergeRequestNote).not.toHaveBeenCalled();
  });

  it('threads the repository host into issue reuse lookup and launch payloads', async () => {
    mockGetGitLabAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitlab:pr_conflict_resolve:repo-1',
          settings: null,
          repo: { id: 'repo-1', host: 'gitlab.example.com' },
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });

    await handleGitLabNote(
      makeNotePayload({
        includeMergeRequest: false,
        includeIssue: true,
      }),
    );

    expect(mockFindReusableGitHubIssueTaskOwner).toHaveBeenCalledWith({
      repoFullName: 'acme/backend',
      issueNumber: 17,
      sourceControlProvider: 'gitlab',
      host: 'gitlab.example.com',
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlHost: 'gitlab.example.com',
          }),
        }),
      }),
    );
  });

  it('routes a second issue @mention into the existing issue task', async () => {
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue({
      taskId: 'issue-task',
      runId: 8,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      delivery: 'attach',
    });
    mockGetTaskUrl.mockReturnValue('https://app.roomote.dev/task/issue-task');

    const result = await handleGitLabNote(
      makeNotePayload({
        includeMergeRequest: false,
        includeIssue: true,
        note: { note: '@roomote also fix the tests' },
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'active_issue_owner_routed',
    });
    expect(mockSteerMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'issue-task',
        userId: 'user-1',
        message: expect.stringContaining(
          '<mention_request>@roomote also fix the tests</mention_request>',
        ),
        senderMode: 'github_pr_follow_up',
      }),
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockCreateGitLabIssueNote).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('existing task for this issue'),
      }),
    );
  });

  it('resumes an idle issue owner on a second mention', async () => {
    mockFindReusableGitHubIssueTaskOwner.mockResolvedValue({
      taskId: 'issue-task',
      runId: 8,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
      delivery: 'attach',
    });

    const result = await handleGitLabNote(
      makeNotePayload({
        includeMergeRequest: false,
        includeIssue: true,
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'active_issue_owner_routed',
    });
    expect(mockSendMessageToTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'issue-task',
        userId: 'user-1',
      }),
    );
    expect(mockSteerMessageToTask).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('requires a mapped environment before starting an issue task', async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await handleGitLabNote(
      makeNotePayload({
        includeMergeRequest: false,
        includeIssue: true,
      }),
    );

    expect(result).toEqual({ status: 'ok', message: 'environment_required' });
    expect(mockCreateGitLabIssueNote).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('environment is mapped'),
      }),
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('prompts account linking on issue mentions when the sender is unlinked', async () => {
    mockGetGitLabAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'GitLab user alice is not linked',
    });

    const result = await handleGitLabNote(
      makeNotePayload({
        includeMergeRequest: false,
        includeIssue: true,
      }),
    );

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mockCreateGitLabIssueNote).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('GitLab account linked'),
      }),
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });
});
