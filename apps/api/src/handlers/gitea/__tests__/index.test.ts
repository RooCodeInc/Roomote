import { createHmac } from 'node:crypto';

import { Hono } from 'hono';

const {
  mockHandleGiteaPullRequest,
  mockHandleGiteaComment,
  mockRecordWebhook,
  mockResolveDeploymentEnvVar,
} = vi.hoisted(() => ({
  mockHandleGiteaPullRequest: vi.fn(),
  mockHandleGiteaComment: vi.fn(),
  mockRecordWebhook: vi.fn(),
  mockResolveDeploymentEnvVar: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
}));

vi.mock('../../logging', () => ({
  apiLogger: {
    debug: vi.fn(),
    info: vi.fn(),
  },
  logApiError: vi.fn(),
}));

vi.mock('../../github/recordWebhook', () => ({
  recordWebhook: mockRecordWebhook,
}));

vi.mock('../handlePullRequest', () => ({
  handleGiteaPullRequest: mockHandleGiteaPullRequest,
}));

vi.mock('../handleComment', () => ({
  handleGiteaComment: mockHandleGiteaComment,
}));

function sign(body: string): string {
  return createHmac('sha256', 'gitea-secret').update(body).digest('hex');
}

describe('gitea webhook router', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.resetModules();
    mockHandleGiteaPullRequest.mockReset();
    mockHandleGiteaComment.mockReset();
    mockRecordWebhook.mockReset();
    mockResolveDeploymentEnvVar.mockReset();
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) =>
      name === 'GITEA_WEBHOOK_SECRET' ? 'gitea-secret' : null,
    );
    mockHandleGiteaPullRequest.mockResolvedValue({ status: 'ok' });
    mockHandleGiteaComment.mockResolvedValue({ status: 'ok' });
    mockRecordWebhook.mockImplementation(
      async (
        _deliveryId: string,
        _event: string,
        _payload: unknown,
        handler: () => Promise<unknown>,
      ) => await handler(),
    );

    const { gitea } = await import('../index');
    app = new Hono();
    app.route('/api/webhooks/gitea', gitea);
  });

  it('records and routes pull request webhooks', async () => {
    const payload = {
      action: 'opened',
      number: 42,
      sender: { id: 10, login: 'roomote-bot' },
      repository: {
        id: 123,
        full_name: 'acme/backend',
        html_url: 'https://git.example.com/acme/backend',
      },
      pull_request: {
        number: 42,
        title: 'Update backend',
        html_url: 'https://git.example.com/acme/backend/pulls/42',
        head: { ref: 'feature/test', sha: 'abc123' },
        base: { ref: 'main' },
      },
    };
    const body = JSON.stringify(payload);

    const response = await app.request('http://localhost/api/webhooks/gitea', {
      method: 'POST',
      headers: {
        'x-gitea-signature': sign(body),
        'x-gitea-event': 'pull_request',
        'x-gitea-delivery': 'delivery-1',
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(mockRecordWebhook).toHaveBeenCalledWith(
      'delivery-1',
      'pull_request.opened',
      expect.objectContaining({
        action: 'opened',
      }),
      expect.any(Function),
      { provider: 'gitea' },
    );
    expect(mockHandleGiteaPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: expect.objectContaining({
          full_name: 'acme/backend',
        }),
      }),
    );
  });

  it('records and routes pull request comment webhooks', async () => {
    const payload = {
      action: 'created',
      is_pull: true,
      sender: { id: 7, login: 'alice' },
      repository: {
        id: 123,
        full_name: 'acme/backend',
        html_url: 'https://git.example.com/acme/backend',
      },
      issue: {
        number: 42,
        title: 'Update backend',
      },
      pull_request: {
        number: 42,
        title: 'Update backend',
        html_url: 'https://git.example.com/acme/backend/pulls/42',
        head: { ref: 'feature/test', sha: 'abc123' },
        base: { ref: 'main' },
      },
      comment: {
        id: 900,
        body: 'Hey @roomote please take a look',
        user: { id: 7, login: 'alice' },
      },
    };
    const body = JSON.stringify(payload);

    const response = await app.request('http://localhost/api/webhooks/gitea', {
      method: 'POST',
      headers: {
        'x-gitea-signature': sign(body),
        'x-gitea-event': 'pull_request_comment',
        'x-gitea-delivery': 'delivery-comment-1',
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(mockRecordWebhook).toHaveBeenCalledWith(
      'delivery-comment-1',
      'pull_request_comment.created',
      expect.objectContaining({ action: 'created' }),
      expect.any(Function),
      { provider: 'gitea' },
    );
    expect(mockHandleGiteaComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment: expect.objectContaining({
          body: expect.stringContaining('@roomote'),
        }),
      }),
    );
    expect(mockHandleGiteaPullRequest).not.toHaveBeenCalled();
  });

  it('routes pull request issue_comment webhooks with issue-only context', async () => {
    const payload = {
      action: 'created',
      is_pull: true,
      sender: { id: 7, login: 'alice' },
      repository: {
        id: 123,
        full_name: 'acme/backend',
        html_url: 'https://git.example.com/acme/backend',
      },
      issue: {
        number: 42,
        title: 'Update backend',
      },
      comment: {
        id: 900,
        body: 'Hey @roomote please take a look',
        user: { id: 7, login: 'alice' },
      },
    };
    const body = JSON.stringify(payload);

    const response = await app.request('http://localhost/api/webhooks/gitea', {
      method: 'POST',
      headers: {
        'x-gitea-signature': sign(body),
        'x-gitea-event': 'issue_comment',
        'x-gitea-delivery': 'delivery-comment-2',
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(mockRecordWebhook).toHaveBeenCalledWith(
      'delivery-comment-2',
      'issue_comment.created',
      expect.objectContaining({ action: 'created' }),
      expect.any(Function),
      { provider: 'gitea' },
    );
    expect(mockHandleGiteaComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: expect.objectContaining({ number: 42 }),
      }),
    );
  });

  it('ignores issue_comment webhooks when Gitea omits is_pull', async () => {
    const payload = {
      action: 'created',
      sender: { id: 7, login: 'alice' },
      repository: {
        id: 123,
        full_name: 'acme/backend',
        html_url: 'https://git.example.com/acme/backend',
      },
      issue: {
        number: 42,
        title: 'Update backend',
      },
      comment: {
        id: 900,
        body: 'Hey @roomote please take a look',
        user: { id: 7, login: 'alice' },
      },
    };
    const body = JSON.stringify(payload);

    const response = await app.request('http://localhost/api/webhooks/gitea', {
      method: 'POST',
      headers: {
        'x-gitea-signature': sign(body),
        'x-gitea-event': 'issue_comment',
        'x-gitea-delivery': 'delivery-comment-3',
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(mockRecordWebhook).toHaveBeenCalledWith(
      'delivery-comment-3',
      'issue_comment.created',
      expect.objectContaining({ action: 'created' }),
      expect.any(Function),
      { provider: 'gitea' },
    );
    expect(mockHandleGiteaComment).not.toHaveBeenCalled();
  });

  it('rejects invalid signatures', async () => {
    const response = await app.request('http://localhost/api/webhooks/gitea', {
      method: 'POST',
      headers: {
        'x-gitea-signature': 'wrong',
        'x-gitea-event': 'pull_request',
      },
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(mockRecordWebhook).not.toHaveBeenCalled();
  });
});
