import { Hono } from 'hono';

import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';

const { callBrainTool, resolveBrainConnection } = vi.hoisted(() => ({
  callBrainTool: vi.fn(),
  resolveBrainConnection: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  callBrainTool,
  resolveBrainConnection,
}));

import { saveUserMemory } from '../saveUserMemory';

function createApp(authContext: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{
    Variables: Variables & { mcpAuth: McpAuth };
  }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', {
      userId:
        'userId' in authContext ? (authContext.userId ?? undefined) : undefined,
      authContext,
    });
    await next();
  });
  app.post('/memory', saveUserMemory);
  return app;
}

const authContext = {
  userId: 'user-1',
  tokenType: 'auth',
  version: 1,
} as AuthTokenContext;

describe('saveUserMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveBrainConnection.mockResolvedValue({
      baseUrl: 'http://brain.test',
      token: 'ingest-token',
    });
    callBrainTool.mockResolvedValue([]);
  });

  it('upserts the authenticated user memory at a stable key-specific slug', async () => {
    const app = createApp(authContext);

    const first = await app.request('/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'Favorite Number',
        value: '2',
        source: { surface: 'slack' },
      }),
    });
    const second = await app.request('/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'favorite-number', value: '3' }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(resolveBrainConnection).toHaveBeenCalledWith('ingest');
    expect(callBrainTool).toHaveBeenCalledTimes(2);
    const firstCall = callBrainTool.mock.calls[0]!;
    const secondCall = callBrainTool.mock.calls[1]!;
    const firstPage = firstCall[2];
    const secondPage = secondCall[2];
    expect(firstCall.slice(0, 2)).toEqual([
      { baseUrl: 'http://brain.test', token: 'ingest-token' },
      'put_page',
    ]);
    expect(firstPage.slug).toBe(secondPage.slug);
    expect(firstPage.slug).toMatch(/^memories\/users\/dXNlci0x\/[a-f0-9]{64}$/);
    expect(firstPage.content).toContain('roomote_user_id: "user-1"');
    expect(firstPage.content).toContain('source_surface: "slack"');
    expect(firstPage.content).toContain('- Value: 2');
    expect(secondPage.content).toContain('- Value: 3');
  });

  it('redacts credential-shaped text before writing it to Brain', async () => {
    const app = createApp(authContext);

    await app.request('/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'temporary note',
        value: 'token ghp_abcdefghijklmnopqrstuvwxyz012345',
      }),
    });

    const page = callBrainTool.mock.calls[0]![2];
    expect(page.content).toContain('[REDACTED]');
    expect(page.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
  });

  it('rejects run tokens so a task cannot write a user profile', async () => {
    const response = await createApp({ runId: 42 } as RunTokenContext).request(
      '/memory',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'favorite number', value: '2' }),
      },
    );

    expect(response.status).toBe(403);
    expect(resolveBrainConnection).not.toHaveBeenCalled();
    expect(callBrainTool).not.toHaveBeenCalled();
  });

  it('fails visibly when the Brain write connection is unavailable', async () => {
    resolveBrainConnection.mockResolvedValue(null);

    const response = await createApp(authContext).request('/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'favorite number', value: '2' }),
    });

    expect(response.status).toBe(503);
    expect(callBrainTool).not.toHaveBeenCalled();
  });
});
