import { Hono } from 'hono';

const {
  mockHandleGitLabMergeRequest,
  mockHandleGitLabNote,
  mockHandleGitLabIssue,
  mockRecordWebhook,
  mockResolveDeploymentEnvVar,
} = vi.hoisted(() => ({
  mockHandleGitLabMergeRequest: vi.fn(),
  mockHandleGitLabNote: vi.fn(),
  mockHandleGitLabIssue: vi.fn(),
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

vi.mock('../handleMergeRequest', () => ({
  handleGitLabMergeRequest: mockHandleGitLabMergeRequest,
}));

vi.mock('../handleNote', () => ({
  handleGitLabNote: mockHandleGitLabNote,
}));

vi.mock('../handleIssue', () => ({
  handleGitLabIssue: mockHandleGitLabIssue,
}));

describe('gitlab webhook router', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.resetModules();
    mockHandleGitLabMergeRequest.mockReset();
    mockHandleGitLabNote.mockReset();
    mockHandleGitLabIssue.mockReset();
    mockRecordWebhook.mockReset();
    mockResolveDeploymentEnvVar.mockReset();
    // Secrets resolve through encrypted deployment env vars, matching
    // values saved by /setup rather than the process environment.
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) =>
      name === 'GITLAB_WEBHOOK_SECRET' ? 'gitlab-secret' : null,
    );
    mockHandleGitLabMergeRequest.mockResolvedValue({ status: 'ok' });
    mockHandleGitLabNote.mockResolvedValue({ status: 'ok' });
    mockHandleGitLabIssue.mockResolvedValue({ status: 'ok' });
    mockRecordWebhook.mockImplementation(
      async (
        _deliveryId: string,
        _event: string,
        _payload: unknown,
        handler: () => Promise<unknown>,
      ) => await handler(),
    );

    const { gitlab } = await import('../index');
    app = new Hono();
    app.route('/api/webhooks/gitlab', gitlab);
  });

  it('records and routes merge request webhooks', async () => {
    const payload = {
      object_kind: 'merge_request',
      event_type: 'merge_request',
      user: { id: 10, username: 'roomote-bot' },
      project: {
        id: 123,
        path_with_namespace: 'acme/backend',
      },
      object_attributes: {
        action: 'open',
        id: 999,
        iid: 42,
        title: 'Update backend',
        url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
        source_branch: 'feature/test',
        target_branch: 'main',
        last_commit: { id: 'abc123' },
      },
    };

    const response = await app.request('http://localhost/api/webhooks/gitlab', {
      method: 'POST',
      headers: {
        'x-gitlab-token': 'gitlab-secret',
        'x-gitlab-event': 'Merge Request Hook',
        'x-gitlab-webhook-uuid': 'delivery-1',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(mockRecordWebhook).toHaveBeenCalledWith(
      'delivery-1',
      'merge_request.open',
      expect.objectContaining({
        object_kind: 'merge_request',
      }),
      expect.any(Function),
      { provider: 'gitlab' },
    );
    expect(mockHandleGitLabMergeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        project: expect.objectContaining({
          path_with_namespace: 'acme/backend',
        }),
      }),
    );
  });

  it('records and routes note webhooks', async () => {
    const payload = {
      object_kind: 'note',
      event_type: 'note',
      user: { id: 7, username: 'alice' },
      project: {
        id: 123,
        path_with_namespace: 'acme/backend',
      },
      object_attributes: {
        id: 555,
        note: 'Hey @roomote please take a look',
        noteable_type: 'MergeRequest',
        action: 'create',
      },
      merge_request: {
        iid: 42,
        title: 'Update backend',
        source_branch: 'feature/test',
        target_branch: 'main',
        last_commit: { id: 'abc123' },
      },
    };

    const response = await app.request('http://localhost/api/webhooks/gitlab', {
      method: 'POST',
      headers: {
        'x-gitlab-token': 'gitlab-secret',
        'x-gitlab-event': 'Note Hook',
        'x-gitlab-webhook-uuid': 'delivery-note-1',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(mockRecordWebhook).toHaveBeenCalledWith(
      'delivery-note-1',
      'note.MergeRequest',
      expect.objectContaining({ object_kind: 'note' }),
      expect.any(Function),
      { provider: 'gitlab' },
    );
    expect(mockHandleGitLabNote).toHaveBeenCalledWith(
      expect.objectContaining({
        object_attributes: expect.objectContaining({
          noteable_type: 'MergeRequest',
        }),
      }),
    );
    expect(mockHandleGitLabMergeRequest).not.toHaveBeenCalled();
  });

  it('records and routes issue webhooks', async () => {
    const payload = {
      object_kind: 'issue',
      event_type: 'issue',
      user: { id: 7, username: 'alice' },
      project: {
        id: 123,
        path_with_namespace: 'acme/backend',
        web_url: 'https://gitlab.com/acme/backend',
      },
      object_attributes: {
        action: 'open',
        iid: 9,
        title: 'Broken feature',
        description: 'Something is broken.',
        url: 'https://gitlab.com/acme/backend/-/issues/9',
        state: 'opened',
      },
      labels: [{ title: 'bug' }],
    };

    const response = await app.request('http://localhost/api/webhooks/gitlab', {
      method: 'POST',
      headers: {
        'x-gitlab-token': 'gitlab-secret',
        'x-gitlab-event': 'Issue Hook',
        'x-gitlab-webhook-uuid': 'delivery-issue-1',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(mockRecordWebhook).toHaveBeenCalledWith(
      'delivery-issue-1',
      'issue.open',
      expect.objectContaining({ object_kind: 'issue' }),
      expect.any(Function),
      { provider: 'gitlab' },
    );
    expect(mockHandleGitLabIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        object_attributes: expect.objectContaining({ iid: 9 }),
      }),
    );
    expect(mockHandleGitLabMergeRequest).not.toHaveBeenCalled();
  });

  it('rejects invalid tokens', async () => {
    const response = await app.request('http://localhost/api/webhooks/gitlab', {
      method: 'POST',
      headers: {
        'x-gitlab-token': 'wrong',
        'x-gitlab-event': 'Merge Request Hook',
      },
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(mockRecordWebhook).not.toHaveBeenCalled();
  });
});
