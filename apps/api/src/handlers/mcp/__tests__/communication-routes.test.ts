const { listCommunicationChannelsMock, loadTaskRunMock } = vi.hoisted(() => ({
  listCommunicationChannelsMock: vi.fn(),
  loadTaskRunMock: vi.fn(),
}));

vi.mock('../communication-channel-discovery', () => ({
  listCommunicationChannels: listCommunicationChannelsMock,
}));

vi.mock('../communication-lookup-run-context', () => ({
  loadCommunicationLookupTaskRun: loadTaskRunMock,
}));

import { Hono } from 'hono';
import type { McpAuth } from '../middleware';

import { communicationMcp } from '../communication';

function createApp(authContext: McpAuth['authContext']) {
  const app = new Hono<{ Variables: { mcpAuth: McpAuth } }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', { userId: undefined, authContext });
    await next();
  });
  app.route('/communication', communicationMcp);
  return app;
}

describe('communication MCP channel routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects channel discovery for non-run tokens', async () => {
    const response = await createApp({
      tokenType: 'auth',
      userId: 'user-1',
      version: 1,
    }).request('/communication/channels', { method: 'POST' });

    expect(response.status).toBe(403);
    expect(listCommunicationChannelsMock).not.toHaveBeenCalled();
  });

  it('passes the task run acting user into channel discovery', async () => {
    loadTaskRunMock.mockResolvedValue({
      actingUserId: 'user-1',
      payload: {},
    });
    listCommunicationChannelsMock.mockResolvedValue({
      channelCount: 0,
      platforms: [],
    });

    const response = await createApp({
      tokenType: 'run',
      runId: 42,
      userId: 'user-1',
      principal: 'user',
      version: 1,
    }).request('/communication/channels', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(loadTaskRunMock).toHaveBeenCalledWith(42);
    expect(listCommunicationChannelsMock).toHaveBeenCalledWith({
      actingUserId: 'user-1',
    });
  });
});
