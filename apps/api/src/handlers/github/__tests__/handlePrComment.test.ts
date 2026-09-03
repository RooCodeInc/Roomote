const mocks = vi.hoisted(() => ({
  getGitHubAutomationTargets: vi.fn(),
  getInstallationOctokit: vi.fn(),
  findActiveGitHubPrReviewTask: vi.fn(),
  findGitHubPullRequestLinkedTask: vi.fn(),
  findReusableGitHubPrFollowUpOwner: vi.fn(),
  startSourceControlFastSessionTurn: vi.fn(),
  fetchGitHubLinkedReferences: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  findActiveGitHubPrReviewTask: mocks.findActiveGitHubPrReviewTask,
  findGitHubPullRequestLinkedTask: mocks.findGitHubPullRequestLinkedTask,
  findReusableGitHubPrFollowUpOwner: mocks.findReusableGitHubPrFollowUpOwner,
}));

vi.mock('@roomote/github', () => ({
  Schemas: {
    isRoomoteGitHubLogin: vi.fn(
      (login: string) => login === 'roomote' || login === 'roomote[bot]',
    ),
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

import { handlePrComment } from '../handlePrComment';
import type {
  WebhookIssueCommentCreated,
  WebhookPullRequestCommentCreated,
} from '../types';

const repository = {
  id: 456,
  full_name: 'acme/api',
  name: 'api',
  owner: { login: 'acme' },
  private: true,
  html_url: 'https://github.com/acme/api',
  default_branch: 'main',
};
const sender = { id: 99, login: 'alice', type: 'User' };

function makeIssueCommentPayload(): WebhookIssueCommentCreated {
  return {
    action: 'created',
    installation: { id: 123 },
    repository,
    sender,
    issue: {
      number: 42,
      title: 'Ship it',
      body: 'Please review',
      user: { login: 'bob' },
      pull_request: { html_url: 'https://github.com/acme/api/pull/42' },
    },
    comment: {
      id: 777,
      body: '@roomote please take a look',
      user: { login: 'alice' },
    },
  } as WebhookIssueCommentCreated;
}

function makeReviewCommentPayload(): WebhookPullRequestCommentCreated {
  return {
    action: 'created',
    installation: { id: 123 },
    repository,
    sender,
    pull_request: {
      number: 42,
      title: 'Ship it',
      body: 'Please review',
      html_url: 'https://github.com/acme/api/pull/42',
      user: { login: 'bob' },
      head: { ref: 'feature/ship', sha: 'abc123' },
    },
    comment: {
      id: 900,
      in_reply_to_id: 800,
      body: '@roomote can you address this?',
      user: { login: 'alice' },
    },
  } as unknown as WebhookPullRequestCommentCreated;
}

describe('handlePrComment', () => {
  const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
  const createForIssueComment = vi.fn().mockResolvedValue({});
  const createForPullRequestReviewComment = vi.fn().mockResolvedValue({});
  const request = vi.fn();
  const pullsGet = vi.fn();
  const listComments = vi.fn().mockResolvedValue({ data: [] });
  const listReviewComments = vi.fn().mockResolvedValue({ data: [] });

  beforeEach(() => {
    vi.clearAllMocks();
    request.mockImplementation(async (route: string) => {
      if (route.startsWith('GET /repos/{owner}/{repo}/pulls/comments/')) {
        return {
          data: {
            id: 800,
            body: 'This loop never terminates.',
            path: 'src/retry.ts',
            diff_hunk: '@@ -1 +1 @@\n-old\n+new',
            user: { login: 'carol' },
          },
        };
      }
      return { data: {} };
    });
    pullsGet.mockResolvedValue({
      data: {
        head: { ref: 'feature/ship', sha: 'abc123' },
        html_url: 'https://github.com/acme/api/pull/42',
      },
    });
    mocks.getInstallationOctokit.mockResolvedValue({
      rest: {
        issues: { createComment, listComments },
        pulls: { get: pullsGet, listReviewComments },
        reactions: { createForIssueComment, createForPullRequestReviewComment },
      },
      request,
    });
    mocks.getGitHubAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'github:pr_review:repo-1',
          workflow: 'pr_review',
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
    mocks.findActiveGitHubPrReviewTask.mockResolvedValue(null);
    mocks.findReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
    mocks.findGitHubPullRequestLinkedTask.mockResolvedValue(null);
    mocks.fetchGitHubLinkedReferences.mockResolvedValue([]);
    mocks.startSourceControlFastSessionTurn.mockResolvedValue({
      status: 'queued',
      fastConversationId: 'fast-1',
    });
  });

  it('enters a PR comment mention into the pull request Session with the discussion as context', async () => {
    listComments.mockResolvedValueOnce({
      data: [{ user: { login: 'bob' }, body: 'Earlier note.' }],
    });

    const result = await handlePrComment(makeIssueCommentPayload());

    expect(result).toEqual({
      status: 'ok',
      message: 'fast_session_queued',
      metadata: { fastConversationId: 'fast-1' },
    });
    expect(createForIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 777, content: 'eyes' }),
    );
    expect(mocks.getGitHubAutomationTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'pr_conflict_resolve',
        requireLinkedSenderAccount: true,
      }),
    );
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith({
      discussion: {
        provider: 'github',
        host: 'github.com',
        repositoryFullName: 'acme/api',
        kind: 'pull',
        number: 42,
      },
      userId: 'user-1',
      senderDisplayName: 'alice',
      question: '@roomote please take a look',
      agentContext: expect.stringContaining('Earlier note.'),
      currentMessageId: 'github:comment:777',
      activeTasks: [],
    });
    const context = mocks.startSourceControlFastSessionTurn.mock.calls[0]?.[0]
      .agentContext as string;
    expect(context).toContain('Pull request: #42 - Ship it');
    expect(context).toContain('Head branch: feature/ship');
    expect(createComment).not.toHaveBeenCalled();
  });

  it('threads review-comment mentions under their thread and quotes the parent comment', async () => {
    await handlePrComment(makeReviewCommentPayload());

    expect(createForPullRequestReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 900, content: 'eyes' }),
    );
    expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        discussion: expect.objectContaining({
          kind: 'pull',
          number: 42,
          reviewCommentId: '800',
        }),
        currentMessageId: 'github:comment:900',
        agentContext: expect.stringContaining('This loop never terminates.'),
      }),
    );
  });

  it('hands the Session the task that already owns the pull request and any running review', async () => {
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

    await handlePrComment(makeIssueCommentPayload());

    expect(mocks.findReusableGitHubPrFollowUpOwner).toHaveBeenCalledWith({
      repoFullName: 'acme/api',
      prNumber: 42,
      branchName: 'feature/ship',
      host: 'github.com',
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

  it('reports a setup gap instead of asking to link when the repository is not active', async () => {
    mocks.getGitHubAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [],
    });

    const result = await handlePrComment(makeIssueCommentPayload());

    expect(result).toEqual({ status: 'ok', message: 'reviewer_gate_miss' });
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('could not start work on this PR'),
      }),
    );
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });

  it('prompts the commenter to link GitHub before starting work', async () => {
    mocks.getGitHubAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'GitHub user alice is not linked',
    });

    const result = await handlePrComment(makeIssueCommentPayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('GitHub account linked'),
      }),
    );
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });

  it('tells the commenter when the Session cannot start', async () => {
    mocks.startSourceControlFastSessionTurn.mockResolvedValue({
      status: 'unavailable',
    });

    const result = await handlePrComment(makeIssueCommentPayload());

    expect(result).toEqual({ status: 'error', message: 'fast_unavailable' });
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
        body: expect.stringContaining("couldn't start a conversation"),
      }),
    );
  });

  it('ignores comments without a mention', async () => {
    const payload = makeIssueCommentPayload();
    payload.comment.body = 'just a note';

    const result = await handlePrComment(payload);

    expect(result).toEqual({ status: 'ok', message: 'no_mention' });
    expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
  });

  describe('replies in a review thread Roomote opened', () => {
    function makeRoomoteThreadReplyPayload(): WebhookPullRequestCommentCreated {
      const payload = makeReviewCommentPayload();
      payload.comment.body = 'Can you make this loop bounded instead?';
      return payload;
    }

    beforeEach(() => {
      request.mockImplementation(async (route: string) => {
        if (route.startsWith('GET /repos/{owner}/{repo}/pulls/comments/')) {
          return {
            data: {
              id: 800,
              body: 'This loop never terminates.',
              path: 'src/retry.ts',
              diff_hunk: '@@ -1 +1 @@\n-old\n+new',
              user: { login: 'roomote[bot]' },
            },
          };
        }
        return { data: {} };
      });
    });

    it('enters the Session without an @mention when no task owns the pull request', async () => {
      const result = await handlePrComment(makeRoomoteThreadReplyPayload());

      expect(result).toEqual(
        expect.objectContaining({
          status: 'ok',
          message: 'fast_session_queued',
        }),
      );
      expect(mocks.findGitHubPullRequestLinkedTask).toHaveBeenCalledWith({
        repoFullName: 'acme/api',
        prNumber: 42,
        host: 'github.com',
      });
      // The gate's fetch is reused for the context; the parent is not
      // fetched a second time.
      expect(
        request.mock.calls.filter(([route]) =>
          String(route).startsWith('GET /repos/{owner}/{repo}/pulls/comments/'),
        ),
      ).toHaveLength(1);
      expect(createForPullRequestReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 900, content: 'eyes' }),
      );
      expect(mocks.startSourceControlFastSessionTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          discussion: expect.objectContaining({
            kind: 'pull',
            number: 42,
            reviewCommentId: '800',
          }),
          question: 'Can you make this loop bounded instead?',
          agentContext: expect.stringContaining(
            "alice replied to Roomote's review comment #800",
          ),
        }),
      );
    });

    it('leaves replies on a Roomote-opened pull request to the review-feedback pipeline, even after its task finished', async () => {
      // The opening task is done and has no resumable snapshot, so the
      // active-owner lookup finds nothing; the durable PR linkage still does.
      mocks.findReusableGitHubPrFollowUpOwner.mockResolvedValue(null);
      mocks.findGitHubPullRequestLinkedTask.mockResolvedValue({
        taskId: 'task-owner',
        runId: 5,
        type: 'standard_task',
        status: 'completed',
      });

      const result = await handlePrComment(makeRoomoteThreadReplyPayload());

      expect(result).toEqual({ status: 'ok', message: 'no_mention' });
      expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
      expect(createForPullRequestReviewComment).not.toHaveBeenCalled();
    });

    it('ignores replies to review comments written by people', async () => {
      request.mockImplementation(async (route: string) => {
        if (route.startsWith('GET /repos/{owner}/{repo}/pulls/comments/')) {
          return {
            data: {
              id: 800,
              body: 'This loop never terminates.',
              user: { login: 'carol' },
            },
          };
        }
        return { data: {} };
      });

      const result = await handlePrComment(makeRoomoteThreadReplyPayload());

      expect(result).toEqual({ status: 'ok', message: 'no_mention' });
      expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
    });

    it('ignores top-level review comments without a mention', async () => {
      const payload = makeRoomoteThreadReplyPayload();
      delete (payload.comment as { in_reply_to_id?: number }).in_reply_to_id;

      const result = await handlePrComment(payload);

      expect(result).toEqual({ status: 'ok', message: 'no_mention' });
      expect(request).not.toHaveBeenCalled();
      expect(mocks.startSourceControlFastSessionTurn).not.toHaveBeenCalled();
    });
  });
});
