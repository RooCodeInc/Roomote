import { Hono } from 'hono';

const {
  registeredHandlers,
  mockHandleInstallationCreated,
  mockHandlePrComment,
  mockHandleGitHubIssueComment,
  mockHandleGitHubIssueFixer,
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
  mockResolveGitHubRoomoteMentionEnabled,
  mockResolveDeploymentEnvVar,
  mockUpdateTaskPrStatus,
  mockUpsertGitHubPullRequestFactFromWebhook,
  mockRecordPrStatusChangeInTaskHistory,
  mockIsFromKnownInstallation,
  mockVerify,
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
  mockHandleGitHubIssueComment: vi.fn(),
  mockHandleGitHubIssueFixer: vi.fn(),
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
  mockResolveGitHubRoomoteMentionEnabled: vi.fn(),
  mockResolveDeploymentEnvVar: vi.fn(),
  mockUpdateTaskPrStatus: vi.fn(),
  mockUpsertGitHubPullRequestFactFromWebhook: vi.fn(),
  mockRecordPrStatusChangeInTaskHistory: vi.fn(),
  mockIsFromKnownInstallation: vi.fn(),
  mockVerify: vi.fn(),
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

    verify(payload: string, signature: string) {
      return mockVerify(payload, signature);
    }

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
  resolveGitHubRoomoteMentionEnabled: mockResolveGitHubRoomoteMentionEnabled,
}));

vi.mock('@roomote/sdk/server', () => ({
  updateTaskPrStatus: mockUpdateTaskPrStatus,
  upsertGitHubPullRequestFactFromWebhook:
    mockUpsertGitHubPullRequestFactFromWebhook,
  recordPrStatusChangeInTaskHistory: mockRecordPrStatusChangeInTaskHistory,
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

vi.mock('../isFromKnownInstallation', () => ({
  isFromKnownInstallation: mockIsFromKnownInstallation,
}));

vi.mock('../handlePrComment', () => ({
  handlePrComment: mockHandlePrComment,
}));

vi.mock('../handleGitHubIssueComment', () => ({
  handleGitHubIssueComment: mockHandleGitHubIssueComment,
}));

vi.mock('../handleGitHubIssueFixer', () => ({
  handleGitHubIssueFixer: mockHandleGitHubIssueFixer,
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
    mockHandleGitHubIssueComment.mockReset();
    mockHandleGitHubIssueFixer.mockReset();
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
    mockResolveGitHubRoomoteMentionEnabled.mockReset();
    mockResolveDeploymentEnvVar.mockReset();
    mockUpdateTaskPrStatus.mockReset();
    mockUpsertGitHubPullRequestFactFromWebhook.mockReset();
    mockIsFromKnownInstallation.mockReset();
    mockVerify.mockReset();
    mockVerifyAndReceive.mockReset();

    mockIsRepoSkipped.mockReturnValue(false);
    mockResolveConfiguredGitHubAppSlug.mockResolvedValue('roomote');
    mockResolveGitHubRoomoteMentionEnabled.mockResolvedValue(true);
    mockResolveDeploymentEnvVar.mockResolvedValue('test-secret');
    mockIsFromKnownInstallation.mockResolvedValue(true);
    mockVerify.mockResolvedValue(true);
    mockHandlePrComment.mockResolvedValue({ status: 'ok' });
    mockHandleGitHubIssueComment.mockResolvedValue({ status: 'ok' });
    mockHandleGitHubIssueFixer.mockResolvedValue({ status: 'ok' });
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

  it('routes plain issue comments through handleGitHubIssueComment', async () => {
    const payload = {
      action: 'created',
      installation: { id: 1 },
      repository: {
        id: 10,
        full_name: 'test-org/test-repo',
      },
      issue: {
        number: 42,
        title: 'Bug report',
        body: 'Something is broken',
      },
      comment: {
        id: 7,
        body: '@roomote please fix this',
        user: { login: 'alice' },
      },
      sender: { login: 'alice' },
    };

    const response = await app.request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-delivery': 'delivery-issue-1',
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': 'sha256=test',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(mockHandleGitHubIssueComment).toHaveBeenCalledWith(payload);
    expect(mockHandlePrComment).not.toHaveBeenCalled();
    expect(mockQueuePrReviewSummaryNotification).not.toHaveBeenCalled();
  });

  it('routes opened issues with body mentions through handleGitHubIssueComment', async () => {
    const payload = {
      action: 'opened',
      installation: { id: 1 },
      repository: {
        id: 10,
        full_name: 'test-org/test-repo',
      },
      issue: {
        number: 43,
        title: 'Please help',
        body: '@roomote fix the checkout crash',
      },
      sender: { login: 'alice' },
    };

    const response = await app.request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-delivery': 'delivery-issue-2',
        'x-github-event': 'issues',
        'x-hub-signature-256': 'sha256=test',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(mockHandleGitHubIssueComment).toHaveBeenCalledWith({
      installation: payload.installation,
      repository: payload.repository,
      sender: payload.sender,
      issue: payload.issue,
      mentionBody: payload.issue.body,
    });
    expect(mockHandleGitHubIssueFixer).toHaveBeenCalledWith(payload);
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

  it.each([
    {
      label: 'merges',
      merged: true,
      mergedAt: '2026-08-06T12:00:00Z',
      status: 'merged',
    },
    {
      label: 'closes without merging',
      merged: false,
      mergedAt: null,
      status: 'closed',
    },
  ] as const)(
    'notifies linked tasks when a pull request $label in a skipped repository',
    async ({ merged, mergedAt, status }) => {
      mockIsRepoSkipped.mockReturnValue(true);
      mockHandlePrMerge.mockResolvedValue({ status: 'ok' });
      mockUpdateTaskPrStatus.mockResolvedValue(undefined);
      mockUpsertGitHubPullRequestFactFromWebhook.mockResolvedValue(undefined);

      const payload = {
        action: 'closed',
        installation: { id: 1 },
        repository: {
          id: 10,
          full_name: 'test-org/test-repo',
        },
        pull_request: {
          id: 100,
          number: 42,
          title: 'Test PR',
          html_url: 'https://github.com/test-org/test-repo/pull/42',
          state: 'closed',
          draft: false,
          merged,
          merged_at: mergedAt,
          closed_at: '2026-08-06T12:00:00Z',
          created_at: '2026-08-06T11:00:00Z',
          updated_at: '2026-08-06T12:00:00Z',
          user: { login: 'author' },
          merged_by: merged ? { login: 'merger' } : null,
        },
        sender: { login: merged ? 'merger' : 'closer' },
      };

      const response = await app.request(
        'http://localhost/api/webhooks/github',
        {
          method: 'POST',
          headers: {
            'x-github-delivery': `delivery-skipped-repo-${status}`,
            'x-github-event': 'pull_request',
            'x-hub-signature-256': 'sha256=test',
          },
          body: JSON.stringify(payload),
        },
      );

      expect(response.status).toBe(200);
      expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
        'github',
        'test-org/test-repo',
        42,
        status,
      );
      expect(mockRecordPrStatusChangeInTaskHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: 'test-org/test-repo',
          prNumber: 42,
          status,
        }),
      );
      expect(mockHandlePrMerge).toHaveBeenCalledWith(payload);
    },
  );

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

  it('refreshes GitHub mention settings before dispatching handlers', async () => {
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
    expect(mockResolveGitHubRoomoteMentionEnabled).toHaveBeenCalledTimes(1);
    expect(
      mockResolveConfiguredGitHubAppSlug.mock.invocationCallOrder[0],
    ).toBeLessThan(mockVerifyAndReceive.mock.invocationCallOrder[0]!);
    expect(
      mockResolveGitHubRoomoteMentionEnabled.mock.invocationCallOrder[0],
    ).toBeLessThan(mockVerifyAndReceive.mock.invocationCallOrder[0]!);
  });

  it('returns 401 without an installation lookup when the signature is invalid', async () => {
    mockVerify.mockResolvedValue(false);

    const response = await app.request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-delivery': 'delivery-bad-signature',
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=forged',
      },
      body: JSON.stringify({ ref: 'refs/heads/main' }),
    });

    expect(response.status).toBe(401);
    expect(mockIsFromKnownInstallation).not.toHaveBeenCalled();
    expect(mockVerifyAndReceive).not.toHaveBeenCalled();
    expect(mockRecordWebhook).not.toHaveBeenCalled();
  });

  it('drops deliveries from unknown installations before recording or handling', async () => {
    mockIsFromKnownInstallation.mockResolvedValue(false);

    const payload = JSON.stringify({
      ref: 'refs/heads/main',
      installation: { id: 999 },
    });

    const response = await app.request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-delivery': 'delivery-unknown-installation',
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=test',
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'unknown_installation' });
    expect(mockIsFromKnownInstallation).toHaveBeenCalledWith('push', payload);
    expect(mockVerifyAndReceive).not.toHaveBeenCalled();
    expect(mockRecordWebhook).not.toHaveBeenCalled();
    expect(mockResolveConfiguredGitHubAppSlug).not.toHaveBeenCalled();
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
