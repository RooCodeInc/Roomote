const mocks = vi.hoisted(() => ({
  getGitLabAutomationTargets: vi.fn(),
  getGitLabDeploymentUser: vi.fn(),
  createGitLabMergeRequestNote: vi.fn(),
  createGitLabIssueNote: vi.fn(),
  startSourceControlFastSessionTurn: vi.fn(),
  findReusableGitHubPrFollowUpOwner: vi.fn(),
  findReusableGitHubIssueTaskOwner: vi.fn(),
  findActiveGitHubPrReviewTask: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  findActiveGitHubPrReviewTask: mocks.findActiveGitHubPrReviewTask,
  findReusableGitHubIssueTaskOwner: mocks.findReusableGitHubIssueTaskOwner,
  findReusableGitHubPrFollowUpOwner: mocks.findReusableGitHubPrFollowUpOwner,
}));

vi.mock('@roomote/gitlab', () => ({
  createGitLabIssueNote: mocks.createGitLabIssueNote,
  createGitLabMergeRequestNote: mocks.createGitLabMergeRequestNote,
  getGitLabDeploymentUser: mocks.getGitLabDeploymentUser,
}));

vi.mock('@roomote/sdk/server', () => ({
  startSourceControlFastSessionTurn: mocks.startSourceControlFastSessionTurn,
}));

vi.mock('../getGitLabAutomationTargets', async () => {
  const actual = await vi.importActual<
    typeof import('../getGitLabAutomationTargets')
  >('../getGitLabAutomationTargets');
  return {
    ...actual,
    getGitLabAutomationTargets: mocks.getGitLabAutomationTargets,
  };
});

import { handleGitLabNote } from '../handleNote';
import type { GitLabNoteWebhook } from '../types';

function makeNotePayload(
  overrides: {
    note?: Partial<GitLabNoteWebhook['object_attributes']>;
    user?: GitLabNoteWebhook['user'];
    includeIssue?: boolean;
  } = {},
): GitLabNoteWebhook {
  const includeIssue = overrides.includeIssue ?? false;
  return {
    object_kind: 'note',
    event_type: 'note',
    user: overrides.user ?? { id: 7, username: 'alice', name: 'Alice' },
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
    ...(includeIssue
      ? {
          issue: {
            iid: 17,
            title: 'Broken login',
            description: 'Repro steps for the crash',
            url: 'https://gitlab.com/acme/backend/-/issues/17',
          },
        }
      : {
          merge_request: {
            iid: 42,
            title: 'Update backend',
            description: 'Refactors the retry loop.',
            url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
            source_branch: 'feature/test',
            target_branch: 'main',
            last_commit: { id: 'abc123' },
          },
        }),
  } as GitLabNoteWebhook;
}

describe('handleGitLabNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGitLabDeploymentUser.mockResolvedValue(null);
    mocks.getGitLabAutomationTargets.mockResolvedValue({
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
    mocks.findReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
    mocks.findReusableGitHubIssueTaskOwner.mockResolvedValue(null);
    mocks.findActiveGitHubPrReviewTask.mockResolvedValue(null);
    mocks.startSourceControlFastSessionTurn.mockResolvedValue({
      status: 'queued',
      fastConversationId: 'fast-1',
    });
    mocks.createGitLabMergeRequestNote.mockResolvedValue({ id: 1 });
    mocks.createGitLabIssueNote.mockResolvedValue({ id: 2 });
  });

  it('enters a merge request note into the merge request Session', async () => {
    const result = await handleGitLabNote(makeNotePayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'fast_session_queued',
      metadata: { fastConversationId: 'fast-1' },
    });
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith({
      discussion: {
        provider: 'gitlab',
        host: 'gitlab.com',
        repositoryFullName: 'acme/backend',
        kind: 'pull',
        number: 42,
      },
      userId: 'user-1',
      senderDisplayName: 'Alice',
      question: 'Hey @roomote please take a look',
      agentContext: expect.stringContaining(
        'Merge request: #42 - Update backend',
      ),
      currentMessageId: 'gitlab:note:555',
      activeTasks: [],
    });
    const context = mocks.startSourceControlFastSessionTurn.mock.calls[0]?.[0]
      .agentContext as string;
    expect(context).toContain('Head branch: feature/test');
    expect(context).toContain('> Refactors the retry loop.');
    expect(mocks.createGitLabMergeRequestNote).not.toHaveBeenCalled();
  });

  it('hands the Session the task that owns the merge request and any running review', async () => {
    mocks.findReusableGitHubPrFollowUpOwner.mockResolvedValue({
      taskId: 'task-owner',
      runId: 5,
      status: 'running',
      taskPhase: null,
      delivery: 'message',
    });
    mocks.findActiveGitHubPrReviewTask.mockResolvedValue({
      taskId: 'task-review',
      status: 'processing',
    });

    await handleGitLabNote(makeNotePayload());

    expect(mocks.findReusableGitHubPrFollowUpOwner).toHaveBeenCalledWith({
      repoFullName: 'acme/backend',
      prNumber: 42,
      branchName: 'feature/test',
      sourceControlProvider: 'gitlab',
      host: 'gitlab.com',
    });
    expect(mocks.findActiveGitHubPrReviewTask).toHaveBeenCalledWith({
      repoFullName: 'acme/backend',
      prNumber: 42,
      headSha: 'abc123',
      sourceControlProvider: 'gitlab',
      host: 'gitlab.com',
    });
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTasks: [
          { taskId: 'task-owner', status: 'running' },
          { taskId: 'task-review', status: 'processing' },
        ],
      }),
    );
  });

  it('enters an issue note into the issue Session', async () => {
    mocks.findReusableGitHubIssueTaskOwner.mockResolvedValue({
      taskId: 'task-issue',
      runId: 9,
      type: 'standard_task',
      status: 'idle',
      taskPhase: null,
      delivery: 'message',
    });

    await handleGitLabNote(makeNotePayload({ includeIssue: true }));

    expect(mocks.getGitLabAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: 'pr_conflict_resolve' }),
    );
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        discussion: expect.objectContaining({ kind: 'issues', number: 17 }),
        agentContext: expect.stringContaining('Issue: #17 - Broken login'),
        activeTasks: [{ taskId: 'task-issue', status: 'idle' }],
      }),
    );
  });

  it('asks an unlinked commenter to link their account', async () => {
    mocks.getGitLabAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'not linked',
    });

    const result = await handleGitLabNote(makeNotePayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mocks.createGitLabMergeRequestNote).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 123,
        mergeRequestIid: 42,
        body: expect.stringContaining('GitLab account linked'),
      }),
    );
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });

  it('tells the commenter when the Session cannot start', async () => {
    mocks.startSourceControlFastSessionTurn.mockResolvedValue({
      status: 'unavailable',
    });

    const result = await handleGitLabNote(makeNotePayload());

    expect(result).toEqual({ status: 'error', message: 'fast_unavailable' });
    expect(mocks.createGitLabMergeRequestNote).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("couldn't start a conversation"),
      }),
    );
  });

  it('ignores system notes, Roomote-authored notes, and notes without a mention', async () => {
    await expect(
      handleGitLabNote(makeNotePayload({ note: { system: true } })),
    ).resolves.toEqual({ status: 'ok', message: 'system_note' });
    await expect(
      handleGitLabNote(makeNotePayload({ note: { note: 'no mention here' } })),
    ).resolves.toEqual({ status: 'ok', message: 'no_mention' });
    await expect(
      handleGitLabNote(
        makeNotePayload({ user: { id: 9, username: 'project_123_bot_abc' } }),
      ),
    ).resolves.toEqual({ status: 'ok', message: 'roomote_authored_note' });
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });
});
