import crypto from 'node:crypto';

import { Hono } from 'hono';

const envState = vi.hoisted(() => ({ R_MONDAY_AGENT_ENABLED: true }));
const dbState = vi.hoisted(() => ({
  installation: {
    id: 'installation-1',
    agentId: 'agent-1',
    accountId: 'account-1',
    accountName: 'Acme',
    ownerMcpConnectionId: 'connection-1',
    status: 'inactive' as 'inactive' | 'disabled',
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    agentApiToken: 'agent-token',
    signingSecret: 'signing-secret',
  },
  claimed: true,
}));
const mocks = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  insertValues: vi.fn(),
  updateSet: vi.fn(),
}));

vi.mock('@roomote/env', () => ({ Env: envState }));
vi.mock('@roomote/db/server', () => ({
  eq: vi.fn(() => 'where'),
  webhooks: { id: 'id' },
  getMondayAgentInstallationSecrets: mocks.getInstallation,
  db: {
    insert: vi.fn(() => ({
      values: mocks.insertValues,
    })),
    update: vi.fn(() => ({ set: mocks.updateSet })),
  },
}));

import { monday } from '.';

const app = new Hono().route('/api/webhooks/monday', monday);

function signedRequest(
  body: object,
  options: { timestamp?: string; signature?: string } = {},
) {
  const rawBody = JSON.stringify(body);
  const timestamp = options.timestamp ?? String(Date.now());
  const signature =
    options.signature ??
    `sha256=${crypto
      .createHmac('sha256', dbState.installation.signingSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex')}`;
  return new Request('http://localhost/api/webhooks/monday/agent', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-monday-agent-id': dbState.installation.agentId,
      'x-monday-signature': signature,
      'x-monday-timestamp': timestamp,
    },
    body: rawBody,
  });
}

const assignedTrigger = {
  event: 'agent_triggered',
  triggerType: 'assigned',
  payload: {
    text: 'Assigned',
    itemId: 123,
    boardId: 456,
    groupId: 'topics',
    updateId: null,
    replyId: null,
    updateBody: null,
    files: null,
  },
  timestamp: '2026-07-30T00:00:00.000Z',
};

describe('monday.com agent webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.R_MONDAY_AGENT_ENABLED = true;
    dbState.installation.status = 'inactive';
    dbState.claimed = true;
    mocks.getInstallation.mockResolvedValue(dbState.installation);
    mocks.insertValues.mockImplementation(() => ({
      onConflictDoNothing: () => ({
        returning: async () => (dbState.claimed ? [{ id: 'webhook-1' }] : []),
      }),
    }));
    mocks.updateSet.mockImplementation(() => ({ where: async () => [] }));
  });

  it('is unavailable without the explicit deployment opt-in', async () => {
    envState.R_MONDAY_AGENT_ENABLED = false;
    const response = await app.request(signedRequest(assignedTrigger));
    expect(response.status).toBe(404);
    expect(mocks.getInstallation).not.toHaveBeenCalled();
  });

  it('rejects stale and incorrectly signed requests before side effects', async () => {
    const stale = await app.request(
      signedRequest(assignedTrigger, {
        timestamp: String(Date.now() - 5 * 60 * 1000 - 1),
      }),
    );
    expect(stale.status).toBe(401);

    const invalid = await app.request(
      signedRequest(assignedTrigger, { signature: 'sha256=invalid' }),
    );
    expect(invalid.status).toBe(401);
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it('acknowledges inactive installations with protocol-correct SSE', async () => {
    const response = await app.request(signedRequest(assignedTrigger));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('data: [DONE]');
    expect(mocks.insertValues).toHaveBeenCalledOnce();
  });

  it('returns JSON when streaming is explicitly disabled', async () => {
    const response = await app.request(
      signedRequest({ ...assignedTrigger, stream: false }),
    );
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      message:
        'Roomote is connected, but monday.com task entry is not active yet.',
    });
  });

  it('handles signed challenges and rejects unavailable installations', async () => {
    const challenge = await app.request(
      signedRequest({ challenge: 'challenge-token' }),
    );
    await expect(challenge.json()).resolves.toEqual({
      challenge: 'challenge-token',
    });

    dbState.installation.status = 'disabled';
    const disabled = await app.request(signedRequest(assignedTrigger));
    expect(disabled.status).toBe(503);
  });

  it('rejects duplicate deliveries without claiming them twice', async () => {
    dbState.claimed = false;
    const response = await app.request(signedRequest(assignedTrigger));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'duplicate_delivery',
    });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies and unsupported event shapes', async () => {
    const oversized = new Request(
      'http://localhost/api/webhooks/monday/agent',
      {
        method: 'POST',
        headers: { 'content-length': String(1024 * 1024 + 1) },
        body: '{}',
      },
    );
    expect((await app.request(oversized)).status).toBe(413);

    const unsupported = await app.request(
      signedRequest({ ...assignedTrigger, triggerType: 'unknown' }),
    );
    expect(unsupported.status).toBe(400);
  });
});
