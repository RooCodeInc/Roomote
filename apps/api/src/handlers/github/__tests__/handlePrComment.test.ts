const {
  mockGetGitHubAutomationTargets,
  mockGetInstallationOctokit,
  mockEnqueueTask,
  mockFindLatestTaskRun,
  mockGetTaskChannelBindings,
  mockPublishGithubPrReviewCheck,
  mockAcquireGithubPrReviewLifecycleLock,
  mockReleaseGithubPrReviewLifecycleLock,
  MockSnapshotResumeAlreadyExistsError,
} = vi.hoisted(() => ({
  mockGetGitHubAutomationTargets: vi.fn(),
  mockGetInstallationOctokit: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockFindLatestTaskRun: vi.fn(),
  mockGetTaskChannelBindings: vi.fn(),
  mockPublishGithubPrReviewCheck: vi.fn(),
  mockAcquireGithubPrReviewLifecycleLock: vi.fn(),
  mockReleaseGithubPrReviewLifecycleLock: Object.assign(vi.fn(), {
    signal: new AbortController().signal,
  }),
  MockSnapshotResumeAlreadyExistsError: class extends Error {},
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildGitHubExistingTaskFollowUpMessage: vi.fn(),
  buildGitHubRoutingContext: vi.fn(),
  enqueueTask: mockEnqueueTask,
  getTaskUrl: vi.fn(),
  routeGitHubTask: vi.fn(),
  SnapshotResumeAlreadyExistsError: MockSnapshotResumeAlreadyExistsError,
}));

vi.mock('@roomote/db/server', () => ({
  findActiveGitHubPrReviewTask: vi.fn(),
  findReusableGitHubPrFollowUpOwner: vi.fn(),
}));

vi.mock('@roomote/github', () => ({
  Schemas: {
    isRoomoteGitHubLogin: vi.fn(() => false),
  },
  getEffectiveGitHubAppSlug: vi.fn(() => 'roomote'),
  isGitHubRoomoteMentionEnabled: vi.fn(() => true),
  getInstallationOctokit: mockGetInstallationOctokit,
}));

vi.mock('@roomote/sdk/server', () => ({
  acquireGithubPrReviewLifecycleLock: mockAcquireGithubPrReviewLifecycleLock,
  ensureSnapshotResumeGitHubFollowUpFallback: vi.fn(),
  publishGithubPrReviewCheck: mockPublishGithubPrReviewCheck,
}));

vi.mock('../getGitHubAutomationTargets', async () => {
  const actual = await vi.importActual<
    typeof import('../getGitHubAutomationTargets')
  >('../getGitHubAutomationTargets');

  return {
    ...actual,
    getGitHubAutomationTargets: mockGetGitHubAutomationTargets,
  };
});

vi.mock('../../tasks/helpers', () => ({
  findLatestTaskRun: mockFindLatestTaskRun,
  getTaskChannelBindings: mockGetTaskChannelBindings,
}));

vi.mock('../../tasks/sendMessageToTask', () => ({
  getTrackedUserDisplayName: vi.fn(),
  sendMessageToTask: vi.fn(),
  steerMessageToTask: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: {
    R_GITHUB_APP_SLUG: 'roomote',
    R_APP_URL: 'https://app.roomote.dev',
  },
}));

import {
  handlePrComment,
  resumeExistingTaskAndDeliverFollowUp,
} from '../handlePrComment';
import type { WebhookIssueCommentCreated } from '../types';

function makePayload(): WebhookIssueCommentCreated {
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
      body: 'Please review',
      user: { login: 'bob' },
      pull_request: {
        html_url: 'https://github.com/acme/api/pull/42',
      },
    },
    comment: {
      id: 777,
      body: '@roomote please take a look',
      user: { login: 'alice' },
    },
  } as WebhookIssueCommentCreated;
}

describe('handlePrComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetGitHubAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'GitHub user alice is not linked',
    });
    mockGetInstallationOctokit.mockResolvedValue({
      rest: {
        issues: {
          createComment: vi.fn().mockResolvedValue({}),
        },
      },
      request: vi.fn(),
    });
    mockGetTaskChannelBindings.mockResolvedValue(null);
    mockAcquireGithubPrReviewLifecycleLock.mockResolvedValue(
      mockReleaseGithubPrReviewLifecycleLock,
    );
  });

  it('returns a normal delivery failure when another GitHub resume wins', async () => {
    mockFindLatestTaskRun.mockResolvedValue({
      id: 42,
      status: 'completed',
      taskPhase: null,
      snapshotId: 'snapshot-1',
      snapshotCreatedAt: new Date(),
      payload: { repo: 'acme/api' },
      port: null,
      actingUserId: 'user-1',
    });
    mockEnqueueTask.mockRejectedValueOnce(
      new MockSnapshotResumeAlreadyExistsError(),
    );

    const result = await resumeExistingTaskAndDeliverFollowUp({
      taskId: 'task-1',
      userId: 'user-1',
      sourceRunId: 42,
      message: 'Handle the second comment.',
      resumePromptFallbackTask: {
        type: 'github_pr_review_follow_up',
        userId: 'user-1',
        payload: {
          repo: 'acme/api',
          prNumber: 42,
          prTitle: 'Ship it',
          commentBody: 'Handle the second comment.',
          followUpSource: 'github_mention',
        },
      },
    });

    expect(result).toEqual({
      success: false,
      error: 'Reusable PR owner is already resuming',
      status: 409,
    });
  });

  it('prompts the commenter to link GitHub before starting work', async () => {
    const result = await handlePrComment(makePayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    const octokit = await mockGetInstallationOctokit.mock.results[0]?.value;
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('GitHub account linked'),
      }),
    );
  });
});
