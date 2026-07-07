import { Hono } from 'hono';

const {
  mockHandleAdoComment,
  mockHandleAdoPullRequest,
  mockRecordWebhook,
  mockResolveDeploymentEnvVar,
} = vi.hoisted(() => ({
  mockHandleAdoComment: vi.fn(),
  mockHandleAdoPullRequest: vi.fn(),
  mockRecordWebhook: vi.fn(),
  mockResolveDeploymentEnvVar: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
}));

vi.mock('../../logging', () => ({
  apiLogger: {
    debug: vi.fn(),
  },
  logApiError: vi.fn(),
}));

vi.mock('../../github/recordWebhook', () => ({
  recordWebhook: mockRecordWebhook,
}));

vi.mock('../handlePullRequest', () => ({
  handleAdoPullRequest: mockHandleAdoPullRequest,
}));

vi.mock('../handleComment', () => ({
  handleAdoComment: mockHandleAdoComment,
}));

describe('ado webhook router', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.resetModules();
    mockHandleAdoComment.mockReset();
    mockHandleAdoPullRequest.mockReset();
    mockRecordWebhook.mockReset();
    mockResolveDeploymentEnvVar.mockReset();
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) =>
      name === 'ADO_WEBHOOK_SECRET' ? 'ado-secret' : null,
    );
    mockHandleAdoComment.mockResolvedValue({ status: 'ok' });
    mockHandleAdoPullRequest.mockResolvedValue({ status: 'ok' });
    mockRecordWebhook.mockImplementation(
      async (
        _deliveryId: string,
        _event: string,
        _payload: unknown,
        handler: () => Promise<unknown>,
      ) => await handler(),
    );

    const { ado } = await import('../index');
    app = new Hono();
    app.route('/api/webhooks/ado', ado);
  });

  it('records and routes pull request webhooks', async () => {
    const payload = {
      id: 'delivery-1',
      eventType: 'git.pullrequest.created',
      publisherId: 'tfs',
      resourceContainers: {
        account: {
          baseUrl: 'https://dev.azure.com/acme/',
        },
      },
      resource: {
        repository: {
          id: 'repo-1',
          name: 'backend',
          project: {
            id: 'project-1',
            name: 'Platform',
          },
        },
        pullRequestId: 42,
        title: 'Update backend',
        status: 'active',
        sourceRefName: 'refs/heads/feature/test',
        targetRefName: 'refs/heads/main',
      },
    };
    const body = JSON.stringify(payload);

    const response = await app.request('http://localhost/api/webhooks/ado', {
      method: 'POST',
      headers: {
        'x-roomote-webhook-secret': 'ado-secret',
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(mockRecordWebhook).toHaveBeenCalledWith(
      'delivery-1',
      'git.pullrequest.created',
      expect.objectContaining({
        eventType: 'git.pullrequest.created',
      }),
      expect.any(Function),
      { provider: 'ado' },
    );
    expect(mockHandleAdoPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({
          pullRequestId: 42,
        }),
      }),
    );
  });

  it('passes updated notification type hints from service-hook URLs', async () => {
    const payload = {
      id: 'delivery-2',
      eventType: 'git.pullrequest.updated',
      publisherId: 'tfs',
      resourceContainers: {
        account: {
          baseUrl: 'https://dev.azure.com/acme/',
        },
      },
      resource: {
        repository: {
          id: 'repo-1',
          name: 'backend',
          project: {
            id: 'project-1',
            name: 'Platform',
          },
        },
        pullRequestId: 42,
        title: 'Update backend',
        status: 'active',
        sourceRefName: 'refs/heads/feature/test',
        targetRefName: 'refs/heads/main',
      },
    };

    const response = await app.request(
      'http://localhost/api/webhooks/ado?notificationType=PushNotification',
      {
        method: 'POST',
        headers: {
          'x-roomote-webhook-secret': 'ado-secret',
        },
        body: JSON.stringify(payload),
      },
    );

    expect(response.status).toBe(200);
    expect(mockHandleAdoPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'git.pullrequest.updated',
      }),
      { updatedNotificationType: 'PushNotification' },
    );
  });

  it('records and routes pull request comment webhooks', async () => {
    const payload = {
      id: 'comment-delivery-1',
      eventType: 'ms.vss-code.git-pullrequest-comment-event',
      publisherId: 'tfs',
      resourceContainers: {
        account: {
          baseUrl: 'https://dev.azure.com/acme/',
        },
      },
      resource: {
        comment: {
          id: 900,
          author: {
            id: 'user-1',
            uniqueName: 'alice@acme.example',
            displayName: 'Alice',
          },
          content: '@roomote take a look',
          commentType: 'text',
        },
        pullRequest: {
          repository: {
            id: 'repo-1',
            name: 'backend',
            project: {
              id: 'project-1',
              name: 'Platform',
            },
          },
          pullRequestId: 42,
          title: 'Update backend',
          status: 'active',
          sourceRefName: 'refs/heads/feature/test',
          targetRefName: 'refs/heads/main',
        },
      },
    };
    const body = JSON.stringify(payload);

    const response = await app.request('http://localhost/api/webhooks/ado', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('roomote:ado-secret').toString(
          'base64',
        )}`,
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(mockRecordWebhook).toHaveBeenCalledWith(
      'comment-delivery-1',
      'ms.vss-code.git-pullrequest-comment-event',
      expect.objectContaining({
        eventType: 'ms.vss-code.git-pullrequest-comment-event',
      }),
      expect.any(Function),
      { provider: 'ado' },
    );
    expect(mockHandleAdoComment).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({
          comment: expect.objectContaining({
            content: '@roomote take a look',
          }),
          pullRequest: expect.objectContaining({
            pullRequestId: 42,
          }),
        }),
      }),
    );
    expect(mockHandleAdoPullRequest).not.toHaveBeenCalled();
  });

  it('records merge-attempted ADO events without routing to pull request handling', async () => {
    const payload = {
      id: 'merged-delivery-1',
      eventType: 'git.pullrequest.merged',
      resource: {
        repository: {
          id: 'repo-1',
          name: 'backend',
          project: {
            id: 'project-1',
            name: 'Platform',
          },
        },
        pullRequestId: 42,
        title: 'Update backend',
        status: 'completed',
      },
    };

    const response = await app.request('http://localhost/api/webhooks/ado', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('roomote:ado-secret').toString(
          'base64',
        )}`,
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(mockRecordWebhook).toHaveBeenCalledWith(
      'merged-delivery-1',
      'git.pullrequest.merged',
      payload,
      expect.any(Function),
      { provider: 'ado' },
    );
    expect(mockHandleAdoPullRequest).not.toHaveBeenCalled();
    expect(mockHandleAdoComment).not.toHaveBeenCalled();
  });

  it('rejects invalid secrets', async () => {
    const response = await app.request('http://localhost/api/webhooks/ado', {
      method: 'POST',
      headers: {
        'x-roomote-webhook-secret': 'wrong',
      },
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(mockRecordWebhook).not.toHaveBeenCalled();
  });
});
