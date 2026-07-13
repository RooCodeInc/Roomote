import { createHmac } from 'node:crypto';

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordWebhook = vi.fn(
  async (
    _deliveryId: string,
    _eventName: string,
    _payload: unknown,
    handler: () => Promise<unknown>,
  ) => handler(),
);
const handleBitbucketPullRequest = vi.fn(async () => ({
  status: 'ok' as const,
}));
const handleBitbucketComment = vi.fn(async () => ({ status: 'ok' as const }));
const resolveDeploymentEnvVar = vi.fn();

vi.mock('../../github/recordWebhook', () => ({
  recordWebhook: (
    ...args: Parameters<typeof recordWebhook>
  ): ReturnType<typeof recordWebhook> => recordWebhook(...args),
}));
vi.mock('../handlePullRequest', () => ({
  handleBitbucketPullRequest: (
    ...args: Parameters<typeof handleBitbucketPullRequest>
  ): ReturnType<typeof handleBitbucketPullRequest> =>
    handleBitbucketPullRequest(...args),
}));
vi.mock('../handleComment', () => ({
  handleBitbucketComment: (
    ...args: Parameters<typeof handleBitbucketComment>
  ): ReturnType<typeof handleBitbucketComment> =>
    handleBitbucketComment(...args),
}));
vi.mock('@roomote/db/server', () => ({
  resolveDeploymentEnvVar: (
    ...args: Parameters<typeof resolveDeploymentEnvVar>
  ): ReturnType<typeof resolveDeploymentEnvVar> =>
    resolveDeploymentEnvVar(...args),
}));

function sign(body: string): string {
  return createHmac('sha256', 'bitbucket-secret').update(body).digest('hex');
}

describe('bitbucket webhook router', () => {
  beforeEach(() => {
    vi.resetModules();
    recordWebhook.mockClear();
    handleBitbucketPullRequest.mockClear();
    handleBitbucketComment.mockClear();
    resolveDeploymentEnvVar.mockImplementation(async (name: string) =>
      name === 'R_BITBUCKET_WEBHOOK_SECRET' ? 'bitbucket-secret' : null,
    );
  });

  async function mountApp() {
    const { bitbucket } = await import('../index');
    const app = new Hono();
    app.route('/api/webhooks/bitbucket', bitbucket);
    return app;
  }

  it('routes pullrequest:created events', async () => {
    const body = JSON.stringify({
      pullrequest: {
        id: 12,
        title: 'Add feature',
        state: 'OPEN',
        source: { branch: { name: 'feature' }, commit: { hash: 'abc' } },
        destination: { branch: { name: 'main' } },
      },
      repository: { full_name: 'ws/repo', uuid: '{uuid}' },
      actor: { nickname: 'dev', account_id: 'acct-1' },
    });

    const app = await mountApp();
    const response = await app.request(
      'http://localhost/api/webhooks/bitbucket',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${sign(body)}`,
          'x-event-key': 'pullrequest:created',
          'x-request-uuid': 'delivery-1',
        },
        body,
      },
    );

    expect(response.status).toBe(200);
    expect(handleBitbucketPullRequest).toHaveBeenCalledOnce();
    expect(recordWebhook).toHaveBeenCalledWith(
      'delivery-1',
      'pullrequest:created',
      expect.any(Object),
      expect.any(Function),
      { provider: 'bitbucket' },
    );
  });

  it('routes pullrequest:comment_created events', async () => {
    const body = JSON.stringify({
      pullrequest: {
        id: 12,
        title: 'Add feature',
        state: 'OPEN',
        source: { branch: { name: 'feature' }, commit: { hash: 'abc' } },
      },
      comment: {
        id: 99,
        content: { raw: '@roomote review this' },
        user: { nickname: 'dev', account_id: 'acct-1' },
      },
      repository: { full_name: 'ws/repo', uuid: '{uuid}' },
      actor: { nickname: 'dev', account_id: 'acct-1' },
    });

    const app = await mountApp();
    const response = await app.request(
      'http://localhost/api/webhooks/bitbucket',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${sign(body)}`,
          'x-event-key': 'pullrequest:comment_created',
          'x-request-uuid': 'delivery-comment-1',
        },
        body,
      },
    );

    expect(response.status).toBe(200);
    expect(handleBitbucketComment).toHaveBeenCalledOnce();
  });

  it('rejects invalid signatures', async () => {
    const body = '{}';
    const app = await mountApp();
    const response = await app.request(
      'http://localhost/api/webhooks/bitbucket',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=wrong',
          'x-event-key': 'pullrequest:created',
        },
        body,
      },
    );

    expect(response.status).toBe(401);
  });
});
