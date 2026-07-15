import { createHmac } from 'node:crypto';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handleSlackInteractivePayloadMock,
  insertMock,
  insertOnConflictDoUpdateMock,
  insertValuesMock,
  resolveDeploymentEnvVarMock,
  resolveSlackSigningSecretMock,
  redisSetMock,
  returningMock,
  slackInstallationFindFirstMock,
  transactionMock,
  userFindFirstMock,
  verifySlackRequestMock,
} = vi.hoisted(() => ({
  handleSlackInteractivePayloadMock: vi.fn(),
  insertMock: vi.fn(),
  insertOnConflictDoUpdateMock: vi.fn(),
  insertValuesMock: vi.fn(),
  resolveDeploymentEnvVarMock: vi.fn(),
  resolveSlackSigningSecretMock: vi.fn(),
  redisSetMock: vi.fn(),
  returningMock: vi.fn(),
  slackInstallationFindFirstMock: vi.fn(),
  transactionMock: vi.fn(),
  userFindFirstMock: vi.fn(),
  verifySlackRequestMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({ set: redisSetMock })),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  db: {
    insert: insertMock,
    query: {
      slackInstallations: { findFirst: slackInstallationFindFirstMock },
      users: { findFirst: userFindFirstMock },
    },
    transaction: transactionMock,
  },
  eq: vi.fn(),
  isNull: vi.fn(),
  resolveDeploymentEnvVar: resolveDeploymentEnvVarMock,
  resolveSlackSigningSecret: resolveSlackSigningSecretMock,
  slackInstallations: { teamId: 'teamId' },
  slackUserMappings: {
    slackTeamId: 'slackTeamId',
    slackUserId: 'slackUserId',
  },
  users: { createdAt: 'createdAt', deletedAt: 'deletedAt', role: 'role' },
}));

vi.mock('../../../logging.js', () => ({
  apiLogger: { debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('../context.js', () => ({
  createSlackWebhookContext: vi.fn(),
}));

vi.mock('../dispatch/events.js', () => ({
  dispatchSlackEvent: vi.fn(),
}));

vi.mock('../dispatch/interactive.js', () => ({
  handleSlackInteractivePayload: handleSlackInteractivePayloadMock,
}));

vi.mock('../helpers/event-normalization.js', () => ({
  getSlackWebhookEventLogDetails: vi.fn(),
  isAppAuthoredSlackEvent: vi.fn(),
  isRoomoteAuthoredSlackEvent: vi.fn(),
  isRoutableAutomatedSlackAppMention: vi.fn(),
  isSlackFunctionExecutedEvent: vi.fn(),
}));

vi.mock('../verifySlackRequest.js', () => ({
  verifySlackRequest: verifySlackRequestMock,
}));

import { slack } from '../index.js';

function createApp() {
  const app = new Hono();
  app.route('/api/webhooks/slack', slack);
  app.route('/api/webhooks/cloud/slack', slack);
  return app;
}

function cloudHeaders(input: {
  payload: string;
  secret: string;
  eventName?: string;
}) {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const deliveryId = 'slack-delivery-1';
  const eventName = input.eventName ?? 'url_verification';
  return {
    'content-type': 'application/json',
    'x-roomote-cloud-delivery': deliveryId,
    'x-roomote-cloud-event': eventName,
    'x-roomote-cloud-provider': 'slack',
    'x-roomote-cloud-timestamp': timestamp,
    'x-roomote-cloud-signature': `v2=${createHmac('sha256', input.secret)
      .update(`${timestamp}.${deliveryId}.slack.${eventName}.${input.payload}`)
      .digest('hex')}`,
  };
}

describe('Roomote Cloud Slack ingress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveDeploymentEnvVarMock.mockResolvedValue('tenant-cloud-secret');
    resolveSlackSigningSecretMock.mockResolvedValue('direct-slack-secret');
    redisSetMock.mockResolvedValue('OK');
    handleSlackInteractivePayloadMock.mockResolvedValue(undefined);
    slackInstallationFindFirstMock.mockResolvedValue(null);
    userFindFirstMock.mockResolvedValue(null);
    insertMock.mockReturnValue({ values: insertValuesMock });
    insertValuesMock.mockReturnValue({
      onConflictDoUpdate: insertOnConflictDoUpdateMock,
    });
    insertOnConflictDoUpdateMock.mockReturnValue({ returning: returningMock });
    returningMock.mockResolvedValue([]);
    transactionMock.mockImplementation(
      async (operation: (tx: { insert: typeof insertMock }) => unknown) =>
        operation({ insert: insertMock }),
    );
    verifySlackRequestMock.mockReturnValue({
      isValid: false,
      error: 'invalid_signature',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a signed Cloud challenge only on the Cloud route', async () => {
    vi.stubEnv('ROOMOTE_CLOUD_ENABLED', 'true');
    const payload = JSON.stringify({
      type: 'url_verification',
      challenge: 'cloud-challenge',
    });
    const headers = cloudHeaders({
      payload,
      secret: 'tenant-cloud-secret',
    });

    const response = await createApp().request('/api/webhooks/cloud/slack', {
      method: 'POST',
      headers,
      body: payload,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      challenge: 'cloud-challenge',
    });
    expect(resolveDeploymentEnvVarMock).toHaveBeenCalledWith(
      'ROOMOTE_CLOUD_INTEGRATION_SECRET',
    );
    expect(verifySlackRequestMock).not.toHaveBeenCalled();

    resolveDeploymentEnvVarMock.mockClear();
    const direct = await createApp().request('/api/webhooks/slack', {
      method: 'POST',
      headers,
      body: payload,
    });
    expect(direct.status).toBe(401);
    expect(resolveDeploymentEnvVarMock).not.toHaveBeenCalled();
    expect(verifySlackRequestMock).toHaveBeenCalled();
  });

  it('never falls back to direct Slack authentication on the Cloud route', async () => {
    vi.stubEnv('ROOMOTE_CLOUD_ENABLED', 'true');
    verifySlackRequestMock.mockReturnValue({ isValid: true });
    const response = await createApp().request('/api/webhooks/cloud/slack', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': '1',
        'x-slack-signature': 'v0=valid-direct-signature',
      },
      body: JSON.stringify({
        type: 'url_verification',
        challenge: 'direct-challenge',
      }),
    });

    expect(response.status).toBe(400);
    expect(verifySlackRequestMock).not.toHaveBeenCalled();
  });

  it('deduplicates retried Cloud interactive deliveries', async () => {
    vi.stubEnv('ROOMOTE_CLOUD_ENABLED', 'true');
    const interactive = JSON.stringify({
      type: 'block_actions',
      team: { id: 'T_ACME' },
      actions: [{ action_id: 'launch' }],
    });
    const payload = new URLSearchParams({ payload: interactive }).toString();
    const headers = {
      ...cloudHeaders({
        payload,
        secret: 'tenant-cloud-secret',
        eventName: 'block_actions',
      }),
      'content-type': 'application/x-www-form-urlencoded',
    };
    redisSetMock.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    const first = await createApp().request('/api/webhooks/cloud/slack', {
      method: 'POST',
      headers,
      body: payload,
    });
    const replay = await createApp().request('/api/webhooks/cloud/slack', {
      method: 'POST',
      headers,
      body: payload,
    });

    expect(first.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ ok: true, duplicate: true });
    expect(handleSlackInteractivePayloadMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock).toHaveBeenCalledWith(
      'slack:event:cloud:slack-delivery-1',
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
  });

  it('keeps the Cloud route hidden while managed mode is disabled', async () => {
    vi.stubEnv('ROOMOTE_CLOUD_ENABLED', 'false');
    const response = await createApp().request('/api/webhooks/cloud/slack', {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(404);
    expect(resolveDeploymentEnvVarMock).not.toHaveBeenCalled();
  });

  it('persists a signed managed Slack setup for the founding admin', async () => {
    vi.stubEnv('ROOMOTE_CLOUD_ENABLED', 'true');
    userFindFirstMock.mockResolvedValueOnce({ id: 'admin-user-1' });
    returningMock.mockResolvedValueOnce([
      { teamId: 'T_ACME', installedByUserId: 'admin-user-1' },
    ]);
    const payload = JSON.stringify({
      teamId: 'T_ACME',
      teamName: 'Acme Slack',
      appId: 'A_ROOMOTE',
      botUserId: 'U_BOT',
      botAccessToken: 'xoxb-tenant-token',
      scopes: ['app_mentions:read', 'chat:write'],
      tokenType: 'bot',
      authedUserId: 'U_INSTALLER',
    });
    const headers = cloudHeaders({
      payload,
      secret: 'tenant-cloud-secret',
      eventName: 'installation.setup',
    });

    const response = await createApp().request(
      '/api/webhooks/cloud/slack/setup',
      { method: 'POST', headers, body: payload },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      teamId: 'T_ACME',
      synchronized: true,
    });
    expect(insertValuesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        teamId: 'T_ACME',
        botAccessToken: 'xoxb-tenant-token',
        installedByUserId: 'admin-user-1',
        isActive: true,
      }),
    );
    expect(insertValuesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        slackTeamId: 'T_ACME',
        slackUserId: 'U_INSTALLER',
        userId: 'admin-user-1',
      }),
    );
    expect(verifySlackRequestMock).not.toHaveBeenCalled();
  });
});
