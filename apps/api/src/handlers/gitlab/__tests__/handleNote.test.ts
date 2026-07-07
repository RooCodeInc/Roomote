const {
  mockEnqueueCloudTask,
  mockGetTaskUrl,
  mockGetGitLabAutomationTargets,
  mockFindReusableGitHubPrFollowUpOwner,
  mockFindActiveGitHubPrReviewTask,
  mockGetGitLabDeploymentUser,
  mockCreateGitLabMergeRequestNote,
  mockSendMessageToTask,
  mockSteerMessageToTask,
} = vi.hoisted(() => ({
  mockEnqueueCloudTask: vi.fn(),
  mockGetTaskUrl: vi.fn(),
  mockGetGitLabAutomationTargets: vi.fn(),
  mockFindReusableGitHubPrFollowUpOwner: vi.fn(),
  mockFindActiveGitHubPrReviewTask: vi.fn(),
  mockGetGitLabDeploymentUser: vi.fn(),
  mockCreateGitLabMergeRequestNote: vi.fn(),
  mockSendMessageToTask: vi.fn(),
  mockSteerMessageToTask: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueCloudTask: mockEnqueueCloudTask,
  getTaskUrl: mockGetTaskUrl,
}));

vi.mock('@roomote/db/server', () => ({
  findReusableGitHubPrFollowUpOwner: mockFindReusableGitHubPrFollowUpOwner,
  findActiveGitHubPrReviewTask: mockFindActiveGitHubPrReviewTask,
}));

vi.mock('@roomote/gitlab', () => ({
  getGitLabDeploymentUser: mockGetGitLabDeploymentUser,
  createGitLabMergeRequestNote: mockCreateGitLabMergeRequestNote,
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

import { CloudTaskStatus, CloudTaskType } from '@roomote/types';

import { handleGitLabNote } from '../handleNote';
import type { GitLabNoteWebhook } from '../types';

function makeNotePayload(
  overrides: {
    note?: Partial<GitLabNoteWebhook['object_attributes']>;
    mergeRequest?: Partial<NonNullable<GitLabNoteWebhook['merge_request']>>;
    user?: GitLabNoteWebhook['user'];
    includeMergeRequest?: boolean;
  } = {},
): GitLabNoteWebhook {
  const includeMergeRequest = overrides.includeMergeRequest ?? true;

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
      noteable_type: 'MergeRequest',
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
  };
}

describe('handleGitLabNote', () => {
  beforeEach(() => {
    mockEnqueueCloudTask.mockReset();
    mockGetTaskUrl.mockReset();
    mockGetGitLabAutomationTargets.mockReset();
    mockFindReusableGitHubPrFollowUpOwner.mockReset();
    mockFindActiveGitHubPrReviewTask.mockReset();
    mockGetGitLabDeploymentUser.mockReset();
    mockCreateGitLabMergeRequestNote.mockReset();
    mockSendMessageToTask.mockReset();
    mockSteerMessageToTask.mockReset();

    mockGetGitLabAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'gitlab:pr_reviewer:repo-1',
          settings: null,
          repositoryIds: ['repo-1'],
          userId: 'user-1',
        },
      ],
    });
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
    mockFindActiveGitHubPrReviewTask.mockResolvedValue(null);
    mockGetGitLabDeploymentUser.mockResolvedValue({
      id: 99,
      username: 'roomote-bot',
    });
    mockCreateGitLabMergeRequestNote.mockResolvedValue({ id: 1 });
    mockEnqueueCloudTask.mockResolvedValue({ id: 1234, taskId: 'task-1' });
    mockGetTaskUrl.mockReturnValue('https://app.roomote.dev/task/task-1');
  });

  it('enqueues a GitLab MR review task when a mention has no reusable owner', async () => {
    const result = await handleGitLabNote(makeNotePayload());

    expect(result).toEqual({ status: 'ok', metadata: { ids: [1234] } });
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        attributionOverride: { kind: 'automatic', sourceKind: 'gitlab' },
        type: CloudTaskType.GithubPrReview,
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
      expect.objectContaining({ launchClass: 'automation' }),
    );
    expect(mockCreateGitLabMergeRequestNote).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 123,
        mergeRequestIid: 42,
        body: expect.stringContaining('review task'),
      }),
    );
  });

  it('links to an active MR review instead of enqueuing a duplicate', async () => {
    mockFindActiveGitHubPrReviewTask.mockResolvedValue({
      taskId: 'review-task',
      jobId: 9,
      type: CloudTaskType.GithubPrReview,
      status: CloudTaskStatus.Running,
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
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
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
    expect(mockEnqueueCloudTask).toHaveBeenCalled();
  });

  it('steers the note into an actively running reusable owner task', async () => {
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue({
      taskId: 'owner-task',
      jobId: 5,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Running,
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
        senderMode: 'github_pr_follow_up',
      }),
    );
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
    expect(mockCreateGitLabMergeRequestNote).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('existing task'),
      }),
    );
  });

  it('sends (resumes) the note when the reusable owner is idle', async () => {
    mockFindReusableGitHubPrFollowUpOwner.mockResolvedValue({
      taskId: 'owner-task',
      jobId: 5,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Completed,
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
      jobId: 5,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Running,
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
    expect(mockEnqueueCloudTask).toHaveBeenCalled();
  });

  it('ignores notes without an @roomote mention', async () => {
    const result = await handleGitLabNote(
      makeNotePayload({ note: { note: 'just a normal comment' } }),
    );

    expect(result).toEqual({ status: 'ok', message: 'no_mention' });
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
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
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
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
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('ignores notes on non-merge-request targets', async () => {
    const result = await handleGitLabNote(
      makeNotePayload({
        note: { noteable_type: 'Issue' },
        includeMergeRequest: false,
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'unsupported_noteable_type:Issue',
    });
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
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
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
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
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('bypasses the MR author policy for mentions', async () => {
    await handleGitLabNote(makeNotePayload());

    expect(mockGetGitLabAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreAuthorPolicy: true }),
    );
  });
});
