const { mockGetGitHubAutomationTargets, mockGetInstallationOctokit } =
  vi.hoisted(() => ({
    mockGetGitHubAutomationTargets: vi.fn(),
    mockGetInstallationOctokit: vi.fn(),
  }));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildGitHubExistingTaskFollowUpMessage: vi.fn(),
  buildGitHubRoutingContext: vi.fn(),
  enqueueCloudTask: vi.fn(),
  getTaskUrl: vi.fn(),
  routeGitHubTask: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  findActiveGitHubPrReviewTask: vi.fn(),
  findReusableGitHubPrFollowUpOwner: vi.fn(),
}));

vi.mock('@roomote/github', () => ({
  Schemas: {
    isRoomoteGitHubLogin: vi.fn(() => false),
  },
  getInstallationOctokit: mockGetInstallationOctokit,
}));

vi.mock('@roomote/sdk/server', () => ({
  ensureSnapshotResumeGitHubFollowUpFallback: vi.fn(),
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
  findLatestCloudJob: vi.fn(),
}));

vi.mock('../../tasks/sendMessageToTask', () => ({
  getTrackedUserDisplayName: vi.fn(),
  sendMessageToTask: vi.fn(),
  steerMessageToTask: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: {
    NEXT_PUBLIC_GITHUB_APP_SLUG: 'roomote',
    ROOMOTE_APP_URL: 'https://app.roomote.dev',
  },
}));

import { handlePrComment } from '../handlePrComment';
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
