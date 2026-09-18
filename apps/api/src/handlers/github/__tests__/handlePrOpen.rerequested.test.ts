const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  enqueueTask: vi.fn(),
  findLinkage: vi.fn(),
  getCurrentHead: vi.fn(),
  getRelayPayload: vi.fn(),
  getTargets: vi.fn(),
  publishCheck: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mocks.enqueueTask,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => args),
  db: {
    query: {
      taskPullRequests: { findFirst: mocks.findLinkage },
    },
  },
  eq: vi.fn((...args: unknown[]) => args),
  taskPullRequests: {
    githubCheckRunId: 'githubCheckRunId',
    id: 'id',
    prNumber: 'prNumber',
    repository: 'repository',
    sourceControlProvider: 'sourceControlProvider',
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  acquireGithubPrReviewLifecycleLock: mocks.acquireLock,
  publishGithubPrReviewCheck: mocks.publishCheck,
}));

vi.mock('../getGitHubAutomationTargets', () => ({
  getGitHubAutomationTargets: mocks.getTargets,
}));

vi.mock('../backgroundGithubTaskProperties', () => ({
  getBackgroundGithubTaskProperties: vi.fn(() => ({})),
}));

vi.mock('../currentPrHead', () => ({
  getCurrentGitHubPrHeadSha: mocks.getCurrentHead,
}));

vi.mock('../reviewTaskRelayPayload', () => ({
  getReviewTaskRelayPayload: mocks.getRelayPayload,
}));

import { handlePrOpen } from '../handlePrOpen';

const payload = {
  installation: { id: 123 },
  repository: { id: 456, full_name: 'acme/widgets' },
  sender: { id: 789, login: 'maintainer' },
  pull_request: {
    number: 42,
    title: 'Improve widgets',
    body: null,
    html_url: 'https://github.com/acme/widgets/pull/42',
    locked: false,
    draft: true,
    user: { login: 'author' },
    head: { ref: 'feature/widgets' },
    base: { ref: 'main', sha: 'base-sha' },
  },
};

describe('handlePrOpen rerequest fencing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.releaseLock.mockResolvedValue(undefined);
    Object.assign(mocks.releaseLock, { signal: new AbortController().signal });
    mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
    mocks.findLinkage.mockResolvedValue({ id: 'link-1' });
    mocks.getCurrentHead.mockResolvedValue('head-sha');
    mocks.getRelayPayload.mockResolvedValue({});
    mocks.getTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'github:pr_review:repo-1',
          settings: { reviewOnCommit: false, reviewDraftPrs: false },
          repo: { id: 'repo-1', host: null },
          properties: {},
        },
      ],
    });
    mocks.enqueueTask.mockResolvedValue({ id: 78, taskId: 'task-1' });
    mocks.publishCheck.mockResolvedValue(undefined);
  });

  it('launches an explicit same-head review despite automatic review filters', async () => {
    const result = await handlePrOpen(payload as never, {
      isExplicitReviewRequest: true,
      expectedGithubCheckRunId: 9001,
      expectedHeadSha: 'head-sha',
    });

    expect(result).toEqual({ status: 'ok', metadata: { ids: [78] } });
    expect(mocks.enqueueTask).toHaveBeenCalledTimes(1);
    expect(mocks.publishCheck).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 78, headSha: 'head-sha' }),
    );
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('starts only one cycle when duplicate deliveries race after check replacement', async () => {
    mocks.findLinkage
      .mockResolvedValueOnce({ id: 'link-1' })
      .mockResolvedValueOnce(undefined);

    await handlePrOpen(payload as never, {
      isExplicitReviewRequest: true,
      expectedGithubCheckRunId: 9001,
      expectedHeadSha: 'head-sha',
    });
    const duplicate = await handlePrOpen(payload as never, {
      isExplicitReviewRequest: true,
      expectedGithubCheckRunId: 9001,
      expectedHeadSha: 'head-sha',
    });

    expect(duplicate).toEqual({ status: 'ok', metadata: { ids: [] } });
    expect(mocks.enqueueTask).toHaveBeenCalledTimes(1);
    expect(mocks.publishCheck).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(2);
  });

  it('does not launch when the PR head changes before the lock is acquired', async () => {
    mocks.getCurrentHead.mockResolvedValue('new-head-sha');

    const result = await handlePrOpen(payload as never, {
      isExplicitReviewRequest: true,
      expectedGithubCheckRunId: 9001,
      expectedHeadSha: 'head-sha',
    });

    expect(result).toEqual({ status: 'ok', metadata: { ids: [] } });
    expect(mocks.enqueueTask).not.toHaveBeenCalled();
    expect(mocks.publishCheck).not.toHaveBeenCalled();
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });
});
