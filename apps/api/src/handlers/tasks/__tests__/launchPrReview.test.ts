const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  findConversationById: vi.fn(),
  getTaskUrl: vi.fn(() => 'https://roomote.example/task/review-task'),
  repositoriesFindMany: vi.fn(),
  buildDelivery: vi.fn(),
  resolveTarget: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mocks.enqueueTask,
  fastAgentConversationRepository: { findById: mocks.findConversationById },
  getTaskUrl: mocks.getTaskUrl,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      repositories: {
        findMany: (...args: unknown[]) => mocks.repositoriesFindMany(...args),
      },
    },
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
  repositories: {
    fullName: 'fullName',
    isActive: 'isActive',
    sourceControlProvider: 'sourceControlProvider',
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  buildSourceControlFastConversation: vi.fn((discussion: unknown) => ({
    surface: (discussion as { provider: string }).provider,
    workspaceId: 'github.com/acme/api',
    conversationId: 'pull/42',
    replyTarget: { channelId: 'github.com/acme/api', threadId: null },
    discussion,
  })),
  buildSourceControlFastDelivery: mocks.buildDelivery,
}));

import { handlePrReviewLaunch } from '../launchPrReview';

const fastParent = {
  sessionId: '33333333-3333-4333-8333-333333333333',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

function makeContext() {
  const json = vi.fn((body: unknown, status?: number) => ({ body, status }));
  return { c: { json } as never, json };
}

describe('handlePrReviewLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repositoriesFindMany.mockResolvedValue([
      { id: 'repo-1', sourceControlProvider: 'github', host: null },
    ]);
    mocks.resolveTarget.mockResolvedValue({
      repositoryId: 'repo-1',
      branch: 'feature/ship',
      pullRequest: {
        url: 'https://github.com/acme/api/pull/42',
        title: 'Ship it',
        sha: 'abc123',
      },
    });
    mocks.buildDelivery.mockResolvedValue({
      resolveTarget: mocks.resolveTarget,
    });
    mocks.findConversationById.mockResolvedValue({
      id: fastParent.sessionId,
      userId: 'user-1',
      conversation: fastParent.conversation,
    });
    mocks.enqueueTask.mockImplementation(
      async (input: { task: { payload: unknown } }) => ({
        id: 900,
        taskId: 'review-task',
        payload: input.task.payload,
      }),
    );
  });

  it('requires a repository and pull request number', async () => {
    const { c, json } = makeContext();

    await handlePrReviewLaunch(c, { userId: 'user-1' }, {});

    expect(json).toHaveBeenCalledWith(
      { error: 'pr-review launches require repo and prNumber.' },
      400,
    );
    expect(mocks.enqueueTask).not.toHaveBeenCalled();
  });

  it('rejects a repository that resolves on multiple providers or hosts', async () => {
    mocks.repositoriesFindMany.mockResolvedValue([
      { id: 'repo-1', sourceControlProvider: 'github', host: null },
      {
        id: 'repo-2',
        sourceControlProvider: 'gitlab',
        host: 'git.example.com',
      },
    ]);
    const { c, json } = makeContext();

    await handlePrReviewLaunch(
      c,
      { userId: 'user-1' },
      { repo: 'acme/api', prNumber: 42 },
    );

    expect(json).toHaveBeenCalledWith(
      { error: expect.stringContaining('ambiguous') },
      400,
    );
    expect(mocks.enqueueTask).not.toHaveBeenCalled();
  });

  it('launches the review pipeline attached to the requesting Session', async () => {
    const { c, json } = makeContext();

    await handlePrReviewLaunch(
      c,
      { userId: 'user-1' },
      {
        repo: 'acme/api',
        prNumber: 42,
        fastConversationId: fastParent.sessionId,
      },
    );

    expect(mocks.enqueueTask).toHaveBeenCalledWith({
      task: {
        type: 'github_pr_review',
        payload: expect.objectContaining({
          repo: 'acme/api',
          sourceControlProvider: 'github',
          prNumber: 42,
          prTitle: 'Ship it',
          prUrl: 'https://github.com/acme/api/pull/42',
          headSha: 'abc123',
          branchName: 'feature/ship',
          fastAgentParent: fastParent,
          fastAgentSessionId: fastParent.sessionId,
          fastParentRequestedReview: true,
        }),
      },
      initiator: { kind: 'user', userId: 'user-1' },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'manual',
      prLinkage: {
        provider: 'github',
        host: 'github.com',
        repositoryId: 'repo-1',
        repository: 'acme/api',
        prNumber: 42,
        prUrl: 'https://github.com/acme/api/pull/42',
        prTitle: 'Ship it',
        prSha: 'abc123',
      },
    });
    expect(json).toHaveBeenCalledWith({
      success: true,
      taskId: 'review-task',
      runId: 900,
      taskUrl: 'https://roomote.example/task/review-task',
      prUrl: 'https://github.com/acme/api/pull/42',
      prTitle: 'Ship it',
    });
  });

  it("rejects binding to another user's web Session", async () => {
    mocks.findConversationById.mockResolvedValue({
      id: fastParent.sessionId,
      userId: 'someone-else',
      conversation: { ...fastParent.conversation, surface: 'web' },
    });
    const { c, json } = makeContext();

    await handlePrReviewLaunch(
      c,
      { userId: 'user-1' },
      {
        repo: 'acme/api',
        prNumber: 42,
        fastConversationId: fastParent.sessionId,
      },
    );

    expect(json).toHaveBeenCalledWith(
      { error: 'The requesting Session belongs to another user.' },
      403,
    );
    expect(mocks.enqueueTask).not.toHaveBeenCalled();
  });

  it('reports an already-running review instead of promising a settle', async () => {
    mocks.enqueueTask.mockResolvedValue({
      id: 900,
      taskId: 'review-task',
      // The reused active run keeps its original payload without this
      // launch's Session binding.
      payload: { repo: 'acme/api', prNumber: 42 },
    });
    const { c, json } = makeContext();

    await handlePrReviewLaunch(
      c,
      { userId: 'user-1' },
      {
        repo: 'acme/api',
        prNumber: 42,
        fastConversationId: fastParent.sessionId,
      },
    );

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, alreadyRunning: true }),
    );
  });

  it('fails cleanly when the pull request cannot be resolved', async () => {
    mocks.resolveTarget.mockResolvedValue({ repositoryId: 'repo-1' });
    const { c, json } = makeContext();

    await handlePrReviewLaunch(
      c,
      { userId: 'user-1' },
      { repo: 'acme/api', prNumber: 42 },
    );

    expect(json).toHaveBeenCalledWith(
      { error: expect.stringContaining('could not be resolved') },
      404,
    );
    expect(mocks.enqueueTask).not.toHaveBeenCalled();
  });
});
