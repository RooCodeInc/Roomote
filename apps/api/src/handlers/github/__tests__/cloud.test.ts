import { createHmac } from 'node:crypto';

import { Hono } from 'hono';

const {
  mockLogApiError,
  mockCompleteRoomoteCloudGitHubInstallation,
  mockProcessGitHubDelivery,
  mockResolveDeploymentEnvVar,
} = vi.hoisted(() => ({
  mockLogApiError: vi.fn(),
  mockCompleteRoomoteCloudGitHubInstallation: vi.fn(),
  mockProcessGitHubDelivery: vi.fn(),
  mockResolveDeploymentEnvVar: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
}));

vi.mock('@roomote/github', () => ({
  completeRoomoteCloudGitHubInstallation:
    mockCompleteRoomoteCloudGitHubInstallation,
}));

vi.mock('../../../logging', () => ({
  logApiError: mockLogApiError,
}));

vi.mock('../index', () => ({
  processGitHubDelivery: mockProcessGitHubDelivery,
}));

import { cloudGitHub, verifyRoomoteCloudDelivery } from '../cloud';

function cloudSignature(input: {
  deliveryId: string;
  payload: string;
  secret: string;
  timestamp: string;
}): string {
  return `v1=${createHmac('sha256', input.secret)
    .update(`${input.timestamp}.${input.deliveryId}.${input.payload}`)
    .digest('hex')}`;
}

describe('Roomote Cloud GitHub webhook ingress', () => {
  const secret = 'tenant-specific-secret';
  const payload = JSON.stringify({ installation: { id: 1234 } });

  beforeEach(() => {
    vi.stubEnv('ROOMOTE_CLOUD_ENABLED', 'true');
    mockLogApiError.mockReset();
    mockCompleteRoomoteCloudGitHubInstallation.mockReset();
    mockProcessGitHubDelivery.mockReset();
    mockResolveDeploymentEnvVar.mockReset();
    mockResolveDeploymentEnvVar.mockResolvedValue(secret);
    mockProcessGitHubDelivery.mockResolvedValue(undefined);
    mockCompleteRoomoteCloudGitHubInstallation.mockResolvedValue({
      githubInstallation: { installationId: 1234 },
      repositories: [{ id: 'repo-1' }],
      success: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns not found while the managed integration is disabled', async () => {
    vi.stubEnv('ROOMOTE_CLOUD_ENABLED', 'false');
    const app = new Hono();
    app.route('/api/webhooks/cloud/github', cloudGitHub);

    const response = await app.request(
      'http://localhost/api/webhooks/cloud/github',
      { method: 'POST' },
    );

    expect(response.status).toBe(404);
    expect(mockResolveDeploymentEnvVar).not.toHaveBeenCalled();
  });

  it('verifies a fresh tenant-scoped signature', () => {
    const timestamp = '1000';
    expect(
      verifyRoomoteCloudDelivery({
        deliveryId: 'delivery-1',
        payload,
        secret,
        signature: cloudSignature({
          deliveryId: 'delivery-1',
          payload,
          secret,
          timestamp,
        }),
        timestamp,
        nowSeconds: 1000,
      }),
    ).toBe(true);
  });

  it('rejects tampered and stale deliveries', () => {
    const timestamp = '1000';
    const signature = cloudSignature({
      deliveryId: 'delivery-1',
      payload,
      secret,
      timestamp,
    });

    expect(
      verifyRoomoteCloudDelivery({
        deliveryId: 'delivery-1',
        payload: `${payload} `,
        secret,
        signature,
        timestamp,
        nowSeconds: 1000,
      }),
    ).toBe(false);
    expect(
      verifyRoomoteCloudDelivery({
        deliveryId: 'delivery-1',
        payload,
        secret,
        signature,
        timestamp,
        nowSeconds: 1301,
      }),
    ).toBe(false);
  });

  it('authenticates the Cloud hop before dispatching through GitHub handlers', async () => {
    const app = new Hono();
    app.route('/api/webhooks/cloud/github', cloudGitHub);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const response = await app.request(
      'http://localhost/api/webhooks/cloud/github',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-roomote-cloud-provider': 'github',
          'x-roomote-cloud-delivery': 'delivery-2',
          'x-roomote-cloud-event': 'push',
          'x-roomote-cloud-timestamp': timestamp,
          'x-roomote-cloud-signature': cloudSignature({
            deliveryId: 'delivery-2',
            payload,
            secret,
            timestamp,
          }),
        },
        body: payload,
      },
    );

    expect(response.status).toBe(200);
    expect(mockResolveDeploymentEnvVar).toHaveBeenCalledWith(
      'ROOMOTE_CLOUD_INTEGRATION_SECRET',
    );
    expect(mockProcessGitHubDelivery).toHaveBeenCalledWith({
      id: 'delivery-2',
      name: 'push',
      payload,
      secret,
      signature: `sha256=${createHmac('sha256', secret)
        .update(payload)
        .digest('hex')}`,
    });
  });

  it('rejects an invalid signature without dispatching', async () => {
    const app = new Hono();
    app.route('/api/webhooks/cloud/github', cloudGitHub);

    const response = await app.request(
      'http://localhost/api/webhooks/cloud/github',
      {
        method: 'POST',
        headers: {
          'x-roomote-cloud-provider': 'github',
          'x-roomote-cloud-delivery': 'delivery-3',
          'x-roomote-cloud-event': 'push',
          'x-roomote-cloud-timestamp': Math.floor(Date.now() / 1000).toString(),
          'x-roomote-cloud-signature': 'v1=bad',
        },
        body: payload,
      },
    );

    expect(response.status).toBe(401);
    expect(mockProcessGitHubDelivery).not.toHaveBeenCalled();
  });

  it('synchronizes a proved installation without tenant GitHub App keys', async () => {
    const app = new Hono();
    app.route('/api/webhooks/cloud/github', cloudGitHub);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const setupPayload = JSON.stringify({
      installationId: '1234',
      appId: 99,
      accountLogin: 'example-org',
      accountType: 'Organization',
      permissions: { contents: 'write', issues: 'write' },
    });

    const response = await app.request(
      'http://localhost/api/webhooks/cloud/github/setup',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-roomote-cloud-provider': 'github',
          'x-roomote-cloud-delivery': 'setup-1234',
          'x-roomote-cloud-event': 'installation.setup',
          'x-roomote-cloud-timestamp': timestamp,
          'x-roomote-cloud-signature': cloudSignature({
            deliveryId: 'setup-1234',
            payload: setupPayload,
            secret,
            timestamp,
          }),
        },
        body: setupPayload,
      },
    );

    expect(response.status).toBe(200);
    expect(mockCompleteRoomoteCloudGitHubInstallation).toHaveBeenCalledWith({
      installationId: 1234,
      appId: 99,
      accountLogin: 'example-org',
      accountType: 'Organization',
      permissions: { contents: 'write', issues: 'write' },
    });
  });
});
