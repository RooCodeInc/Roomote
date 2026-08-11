import { Hono } from 'hono';

import type { Variables } from '../../types';

const {
  mockValidateRunToken,
  mockValidateMcpAccessToken,
  mockValidateAuthToken,
  mockFindDeployment,
} = vi.hoisted(() => ({
  mockValidateRunToken: vi.fn(),
  mockValidateMcpAccessToken: vi.fn(),
  mockValidateAuthToken: vi.fn(),
  mockFindDeployment: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  validateRunToken: mockValidateRunToken,
  validateMcpAccessToken: mockValidateMcpAccessToken,
  validateAuthToken: mockValidateAuthToken,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      deploymentSettings: { findFirst: mockFindDeployment },
      users: {
        findFirst: vi.fn(async () => ({ id: 'user-1', deletedAt: null })),
      },
    },
  },
  deploymentSettings: { id: 'id' },
  users: { id: 'id', deletedAt: 'deletedAt' },
  eq: vi.fn(),
}));

import { tokenAuthMiddleware } from '../tokenAuthMiddleware';

const RUN_TOKEN_CONTEXT = {
  runId: 42,
  userId: null,
  principal: 'deployment',
  tokenType: 'run',
  version: 1,
};

function createApp() {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', tokenAuthMiddleware());
  app.all('*', (c) => c.json({ authContext: c.get('authContext') ?? null }));

  return app;
}

async function requestAuthContext(
  path: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await createApp().request(path, { headers });
  const body = (await response.json()) as { authContext: unknown };

  return body.authContext;
}

describe('tokenAuthMiddleware token extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindDeployment.mockResolvedValue({ metadata: null });
    mockValidateRunToken.mockImplementation(async (token: string) => {
      if (token !== 'valid-run-token') {
        throw new Error('invalid token');
      }

      return RUN_TOKEN_CONTEXT;
    });
    mockValidateAuthToken.mockRejectedValue(new Error('invalid token'));
    mockValidateMcpAccessToken.mockRejectedValue(new Error('invalid token'));
  });

  it('accepts a bearer token on any path', async () => {
    const authContext = await requestAuthContext('/api/task-runs/1', {
      authorization: 'Bearer valid-run-token',
    });

    expect(authContext).toEqual(RUN_TOKEN_CONTEXT);
  });

  it('attaches a browser-issued MCP token for route-level authorization', async () => {
    const mcpContext = {
      tokenType: 'mcp',
      userId: 'user-1',
      resource: 'https://api.example.com/api/mcp-routing/roomote',
      scopes: ['mcp:roomote'],
      version: 1,
    };
    mockValidateMcpAccessToken.mockResolvedValue(mcpContext);

    const authContext = await requestAuthContext('/api/mcp-routing/roomote', {
      authorization: 'Bearer valid-mcp-token',
    });

    expect(authContext).toEqual(mcpContext);
    expect(mockValidateAuthToken).not.toHaveBeenCalled();
  });

  it('accepts the run token from x-api-key on the inference gateway', async () => {
    const authContext = await requestAuthContext(
      '/api/inference/anthropic/v1/messages',
      { 'x-api-key': 'valid-run-token' },
    );

    expect(authContext).toEqual(RUN_TOKEN_CONTEXT);
  });

  it('accepts the run token from x-goog-api-key on the inference gateway', async () => {
    const authContext = await requestAuthContext(
      '/api/inference/google/v1beta/models/gemini-2.5-pro:generateContent',
      { 'x-goog-api-key': 'valid-run-token' },
    );

    expect(authContext).toEqual(RUN_TOKEN_CONTEXT);
  });

  it('prefers the Authorization header over provider key headers', async () => {
    const authContext = await requestAuthContext(
      '/api/inference/anthropic/v1/messages',
      {
        authorization: 'Bearer valid-run-token',
        'x-api-key': 'some-other-value',
      },
    );

    expect(authContext).toEqual(RUN_TOKEN_CONTEXT);
  });

  it('ignores provider key headers outside the inference gateway', async () => {
    const authContext = await requestAuthContext('/api/task-runs/1', {
      'x-api-key': 'valid-run-token',
    });

    expect(authContext).toBeNull();
    expect(mockValidateRunToken).not.toHaveBeenCalled();
  });

  it('does not authenticate an invalid token from provider key headers', async () => {
    const authContext = await requestAuthContext(
      '/api/inference/anthropic/v1/messages',
      { 'x-api-key': 'not-a-token' },
    );

    expect(authContext).toBeNull();
  });
});
