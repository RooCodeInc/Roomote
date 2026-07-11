import { Hono } from 'hono';

const {
  registeredHandlers,
  mockHandleInstallationCreated,
  mockHandlePrComment,
  mockHandlePrMerge,
  mockHandlePrOpen,
  mockHandlePrReadyForReview,
  mockHandlePrReopen,
  mockHandlePrSynchronize,
  mockHandlePushConflictCheck,
  mockIsRepoSkipped,
  mockQueuePrReviewActivityNotification,
  mockQueuePrReviewSummaryNotification,
  mockRecordWebhook,
  mockResolveConfiguredGitHubAppSlug,
  mockResolveDeploymentEnvVar,
  mockUpdateTaskPrStatus,
  mockUpsertGitHubPullRequestFactFromWebhook,
  mockVerifyAndReceive,
  webhooksConstructorParams,
} = vi.hoisted(() => ({
  registeredHandlers: new Map<
    string,
    (event: {
      id: string;
      name: string;
      payload: Record<string, unknown>;
    }) => unknown
  >(),
  mockHandleInstallationCreated: vi.fn(),
  mockHandlePrComment: vi.fn(),
  mockHandlePrMerge: vi.fn(),
  mockHandlePrOpen: vi.fn(),
  mockHandlePrReadyForReview: vi.fn(),
  mockHandlePrReopen: vi.fn(),
  mockHandlePrSynchronize: vi.fn(),
  mockHandlePushConflictCheck: vi.fn(),
  mockIsRepoSkipped: vi.fn(),
  mockQueuePrReviewActivityNotification: vi.fn(),
  mockQueuePrReviewSummaryNotification: vi.fn(),
  mockRecordWebhook: vi.fn(),
  mockResolveConfiguredGitHubAppSlug: vi.fn(),
  mockResolveDeploymentEnvVar: vi.fn(),
  mockUpdateTaskPrStatus: vi.fn(),
  mockUpsertGitHubPullRequestFactFromWebhook: vi.fn(),
  mockVerifyAndReceive: vi.fn(),
  webhooksConstructorParams: [] as unknown[],
}));

vi.mock('@octokit/webhooks', () => ({
  Webhooks: class MockWebhooks {
    constructor(params: unknown) {
      webhooksConstructorParams.push(params);
    }

    on(
      name: string,
      handler: (event: {
        id: string;
        name: string;
        payload: Record<string, unknown>;
      }) => unknown,
    ) {
      registeredHandlers.set(name, handler);
    }

    onError() {}

    verifyAndReceive({
      id,
      name,
      payload,
    }: {
      id: string;
      name: string;
      payload: string;
      signature: string;
    }) {
      return mockVerifyAndReceive({ id, name, payload });
    }
  },
}));

vi.mock('@roomote/db/server', () => ({
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
}));

vi.mock('@roomote/github', () => ({
  isRepoSkipped: mockIsRepoSkipped,
  resolveConfiguredGitHubAppSlug: mockResolveConfiguredGitHubAppSlug,
}));

vi.mock('@roomote/sdk/server', () => ({
  updateTaskPrStatus: mockUpdateTaskPrStatus,
  upsertGitHubPullRequestFactFromWebhook:
    mockUpsertGitHubPullRequestFactFromWebhook,
}));

vi.mock('../../logging', () => ({
  apiLogger: {
    debug: vi.fn(),
  },
  logApiError: vi.fn(),
}));

vi.mock('../handleInstallationCreated', () => ({
  handleInstallationCreated: mockHandleInstallationCreated,
}));

vi.mock('../handlePrComment', () => ({
  handlePrComment: mockHandlePrComment,
}));

vi.mock('../handlePrMerge', () => ({
  handlePrMerge: mockHandlePrMerge,
}));

vi.mock('../handlePrOpen', () => ({
  handlePrOpen: mockHandlePrOpen,
}));

vi.mock('../handlePrReadyForReview', () => ({
  handlePrReadyForReview: mockHandlePrReadyForReview,
}));

vi.mock('../handlePrReopen', () => ({
  handlePrReopen: mockHandlePrReopen,
}));

vi.mock('../handlePrSynchronize', () => ({
  handlePrSynchronize: mockHandlePrSynchronize,
}));

vi.mock('../handlePushConflictCheck', () => ({
  handlePushConflictCheck: mockHandlePushConflictCheck,
}));

vi.mock('../handleWorkflowRunCompleted', () => ({
  handleWorkflowRunCompleted: vi.fn(async () => ({ status: 'ok' as const })),
}));

vi.mock('../recordWebhook', () => ({
  recordWebhook: mockRecordWebhook,
}));

vi.mock('../notifyPrReviewActivity', () => ({
  queuePrReviewActivityNotification: mockQueuePrReviewActivityNotification,
  queuePrReviewSummaryNotification: mockQueuePrReviewSummaryNotification,
}));

describe('github webhook router', () => {
  let app: Hono;

  beforeEach(async () => {
    // Fresh module per test so the module-level webhook-secret cache resets.
    vi.resetModules();
    registeredHandlers.clear();
    webhooksConstructorParams.length = 0;
    mockHandleInstallationCreated.mockReset();
    mockHandlePrComment.mockReset();
    mockHandlePrMerge.mockReset();
    mockHandlePrOpen.mockReset();
    mockHandlePrReadyForReview.mockReset();
    mockHandlePrReopen.mockReset();
    mockHandlePrSynchronize.mockReset();
    mockHandlePushConflictCheck.mockReset();
    mockIsRepoSkipped.mockReset();
    mockQueuePrReviewActivityNotification.mockReset();
    mockQueuePrReviewSummaryNotification.mockReset();
    mockRecordWebhook.mockReset();
    mockResolveConfiguredGitHubAppSlug.mockReset();
    mockResolveDeploymentEnvVar.mockReset();
    mockUpdateTaskPrStatus.mockReset();
    mockUpsertGitHubPullRequestFactFromWebhook.mockReset();
    mockVerifyAndReceive.mockReset();

    mockIsRepoSkipped.mockReturnValue(false);
    mockResolveConfiguredGitHubAppSlug.mockResolvedValue('roomote');
    mockResolveDeploymentEnvVar.mockResolvedValue('test-secret');
    mockHandlePrComment.mockResolvedValue({ status: 'ok' });
    mockRecordWebhook.mockImplementation(
      async (
        _deliveryId: string,
        _event: string,
        _payload: unknown,
        handler: () => Promise<unknown>,
      ) => await handler(),
    );
    mockVerifyAndReceive.mockImplementation(
      async ({
        id,
        name,
        payload,
      }: {
        id: string;
        name: string;
        payload: string;
      }) => {
        const parsedPayload = JSON.parse(payload) as { action?: string };
        const key = parsedPayload.action
          ? `${name}.${parsedPayload.action}`
          : name;
        const handler = registeredHandlers.get(key);

        if (!handler) {
          throw new Error(`No handler registered for ${key}`);
        }

        await handler({ id, name, payload: parsedPayload });
      },
    );

    const { github } = await import('../index');
    app = new Hono();
    app.route('/api/webhooks/github', github);
  });

  it('routes submitted pull request reviews through handlePrComment', async () => {
    const payload = {
      action: 'submitted',
      installation: { id: 1 },
      repository: {
        id: 10,
        full_name: 'test-org/test-repo',
      },
      pull_request: {
        number: 42,
        title: 'Test PR',
        user: { login: 'roomote[bot]' },
      },
      review: {
        body: '@roomote please update the changes',
        state: 'changes_requested',
        user: { login: 'reviewer' },
      },
      sender: {
        login: 'reviewer',
      },
    };

    const response = await app.request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': 'sha256=test',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(mockRecordWebhook).toHaveBeenCalledWith(
      'delivery-1',
      'pull_request_review.submitted',
      payload,
      expect.any(Function),
    );
    expect(mockHandlePrComment).toHaveBeenCalledWith(payload);
    expect(mockQueuePrReviewActivityNotification).toHaveBeenCalledWith(payload);
  });

  it('routes edited PR issue comments to the review-summary notifier without starting tasks', async () => {
    const payload = {
      action: 'edited',
      installation: { id: 1 },
      repository: {
        id: 10,
        full_name: 'test-org/test-repo',
      },
      issue: {
        number: 42,
        pull_request: {
          html_url: 'https://github.com/test-org/test-repo/pull/42',
        },
      },
      comment: {
        id: 7,
        body: '<!-- roomote-review-summary sha=abc -->',
        user: { login: 'roomote[bot]' },
      },
      sender: { login: 'roomote[bot]' },
    };

    const response = await app.request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-delivery': 'delivery-2',
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': 'sha256=test',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(mockQueuePrReviewSummaryNotification).toHaveBeenCalledWith(payload);
    expect(mockHandlePrComment).not.toHaveBeenCalled();
  });

  it('verifies deliveries with a secret that only exists in encrypted deployment env vars', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValue('db-only-secret');

    const response = await app.request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-delivery': 'delivery-3',
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=test',
      },
      body: JSON.stringify({ ref: 'refs/heads/main' }),
    });

    expect(response.status).toBe(200);
    expect(mockResolveDeploymentEnvVar).toHaveBeenCalledWith(
      'R_GITHUB_WEBHOOK_SECRET',
    );
    expect(webhooksConstructorParams).toEqual([{ secret: 'db-only-secret' }]);
    expect(mockHandlePushConflictCheck).toHaveBeenCalled();
  });

  it('refreshes the configured app slug before dispatching handlers', async () => {
    const response = await app.request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-delivery': 'delivery-slug',
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=test',
      },
      body: JSON.stringify({ ref: 'refs/heads/main' }),
    });

    expect(response.status).toBe(200);
    expect(mockResolveConfiguredGitHubAppSlug).toHaveBeenCalledTimes(1);
    expect(
      mockResolveConfiguredGitHubAppSlug.mock.invocationCallOrder[0],
    ).toBeLessThan(mockVerifyAndReceive.mock.invocationCallOrder[0]!);
  });

  it('returns 401 without processing when no webhook secret is configured', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValue(null);

    const response = await app.request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-delivery': 'delivery-4',
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=test',
      },
      body: JSON.stringify({ ref: 'refs/heads/main' }),
    });

    expect(response.status).toBe(401);
    expect(mockVerifyAndReceive).not.toHaveBeenCalled();
    expect(mockRecordWebhook).not.toHaveBeenCalled();
  });

  it('caches the resolved secret across deliveries but not misses', async () => {
    mockResolveDeploymentEnvVar.mockResolvedValueOnce(null);

    const request = () =>
      app.request('http://localhost/api/webhooks/github', {
        method: 'POST',
        headers: {
          'x-github-delivery': 'delivery-5',
          'x-github-event': 'push',
          'x-hub-signature-256': 'sha256=test',
        },
        body: JSON.stringify({ ref: 'refs/heads/main' }),
      });

    // Miss is not cached: the next delivery re-resolves and succeeds.
    expect((await request()).status).toBe(401);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);

    // One miss + one successful resolve; the third delivery hit the cache.
    expect(mockResolveDeploymentEnvVar).toHaveBeenCalledTimes(2);
  });
});
