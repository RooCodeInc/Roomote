const mocks = vi.hoisted(() => ({
  getGitHubAutomationTargets: vi.fn(),
  getInstallationOctokit: vi.fn(),
  findReusableGitHubIssueTaskOwner: vi.fn(),
  startSourceControlFastSessionTurn: vi.fn(),
  fetchGitHubLinkedReferences: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  findReusableGitHubIssueTaskOwner: mocks.findReusableGitHubIssueTaskOwner,
}));

vi.mock('@roomote/github', () => ({
  Schemas: {
    isRoomoteGitHubLogin: vi.fn(() => false),
  },
  getEffectiveGitHubAppSlug: vi.fn(() => 'roomote'),
  isGitHubRoomoteMentionEnabled: vi.fn(() => true),
  getInstallationOctokit: mocks.getInstallationOctokit,
}));

vi.mock('@roomote/sdk/server', () => ({
  startSourceControlFastSessionTurn: mocks.startSourceControlFastSessionTurn,
}));

vi.mock('../getGitHubAutomationTargets', () => ({
  getGitHubAutomationTargets: mocks.getGitHubAutomationTargets,
}));

vi.mock('../linked-issue-pr-context', () => ({
  fetchGitHubLinkedReferences: mocks.fetchGitHubLinkedReferences,
  formatGitHubLinkedReferencesSection: (references: unknown[]) =>
    references.length > 0 ? '<linked_references/>' : undefined,
}));

vi.mock('@roomote/env', () => ({
  Env: {
    R_GITHUB_APP_SLUG: 'roomote',
    R_APP_URL: 'https://app.roomote.dev',
  },
}));

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
    sender: { id: 99, login: 'alice', type: 'User' },
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
  const createForIssueComment = vi.fn().mockResolvedValue({});

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getInstallationOctokit.mockResolvedValue({
      rest: {
        issues: { createComment },
        reactions: { createForIssueComment },
      },
    });
    mocks.findReusableGitHubIssueTaskOwner.mockResolvedValue(null);
    mocks.fetchGitHubLinkedReferences.mockResolvedValue([]);
    mocks.startSourceControlFastSessionTurn.mockResolvedValue({
      status: 'queued',
      fastConversationId: 'fast-1',
    });
    mocks.getGitHubAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'github:pr_conflict_resolve:repo-1',
          workflow: 'pr_conflict_resolve',
          settings: null,
          repo: { id: 'repo-1', fullName: 'acme/api', host: null },
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
  });

  it('enters an issue mention into the issue Session with the issue as context', async () => {
    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'fast_session_queued',
      metadata: { fastConversationId: 'fast-1' },
    });
    expect(createForIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 777, content: 'eyes' }),
    );
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith({
      discussion: {
        provider: 'github',
        host: 'github.com',
        repositoryFullName: 'acme/api',
        kind: 'issues',
        number: 42,
      },
      userId: 'user-1',
      senderDisplayName: 'alice',
      question: '@roomote please take a look',
      agentContext: expect.stringContaining('Issue: #42 - Ship it'),
      currentMessageId: 'github:comment:777',
      activeTasks: [],
    });
    const context = mocks.startSourceControlFastSessionTurn.mock.calls[0]?.[0]
      .agentContext as string;
    expect(context).toContain('> Please fix the bug');
    expect(context).toContain('Author: @bob');
    expect(createComment).not.toHaveBeenCalled();
  });

  it('hands the Session the task that already owns the issue', async () => {
    mocks.findReusableGitHubIssueTaskOwner.mockResolvedValue({
      taskId: 'task-owner',
      runId: 5,
      type: 'standard_task',
      status: 'running',
      taskPhase: null,
      delivery: 'message',
    });

    await handleGitHubIssueComment(makePayload());

    expect(mocks.findReusableGitHubIssueTaskOwner).toHaveBeenCalledWith({
      repoFullName: 'acme/api',
      issueNumber: 42,
      host: null,
    });
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTasks: [{ taskId: 'task-owner', status: 'running' }],
      }),
    );
  });

  it('does not repeat the issue body when the mention is the issue body itself', async () => {
    const base = makePayload();
    await handleGitHubIssueComment({
      installation: base.installation,
      repository: base.repository,
      sender: base.sender,
      issue: { ...base.issue, body: '@roomote please investigate this' },
      mentionBody: '@roomote please investigate this',
    });

    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        question: '@roomote please investigate this',
        currentMessageId: 'github:issue:acme/api#42',
        agentContext: expect.stringContaining(
          'mentioned Roomote in the issue body',
        ),
      }),
    );
    const context = mocks.startSourceControlFastSessionTurn.mock.calls[0]?.[0]
      .agentContext as string;
    expect(context).not.toContain('Body (context only)');
  });

  it('prompts the commenter to link GitHub before starting work', async () => {
    mocks.getGitHubAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'GitHub user alice is not linked',
    });

    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('GitHub account linked'),
      }),
    );
  });

  it('tells the commenter when the Session cannot start', async () => {
    mocks.startSourceControlFastSessionTurn.mockResolvedValue({
      status: 'unavailable',
    });

    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({ status: 'error', message: 'fast_unavailable' });
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
        body: expect.stringContaining("couldn't start a conversation"),
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
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });
});
