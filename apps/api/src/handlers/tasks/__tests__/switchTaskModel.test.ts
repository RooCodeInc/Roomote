import { Hono } from 'hono';
import { TRPCClientError } from '@trpc/client';
import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { switchTaskModel } from '../switchTaskModel';

const {
  mockFindLatestTaskRun,
  mockGetDeploymentTaskModelOptions,
  mockWithSandboxServerRpcClient,
  mockLogHandlerError,
} = vi.hoisted(() => ({
  mockFindLatestTaskRun: vi.fn(),
  mockGetDeploymentTaskModelOptions: vi.fn(),
  mockWithSandboxServerRpcClient: vi.fn(),
  mockLogHandlerError: vi.fn(),
}));

vi.mock('../helpers', () => ({
  findLatestTaskRun: mockFindLatestTaskRun,
}));

vi.mock('../../utils', () => ({
  logHandlerError: mockLogHandlerError,
}));

vi.mock('@roomote/db/server', () => ({
  getDeploymentTaskModelOptions: mockGetDeploymentTaskModelOptions,
}));

vi.mock('@roomote/sdk/server', () => ({
  withSandboxServerRpcClient: mockWithSandboxServerRpcClient,
}));

const ENABLED_MODEL = 'anthropic/claude-opus-5';
const DISABLED_MODEL = 'openai/gpt-5.6-terra';

function createApp(authContext?: AuthTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }

    await next();
  });

  app.use('*', mcpAuthMiddleware);
  app.post('/tasks/:taskId/switch_model', switchTaskModel);

  return app;
}

async function post(
  app: ReturnType<typeof createApp>,
  body: unknown,
): Promise<Response> {
  return app.request('/tasks/task-1/switch_model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('switchTaskModel', () => {
  const authContext: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetDeploymentTaskModelOptions.mockResolvedValue({
      models: [{ id: ENABLED_MODEL, displayName: 'Opus', family: 'Opus' }],
      defaultModelId: ENABLED_MODEL,
    });
    mockFindLatestTaskRun.mockResolvedValue({
      id: 42,
      status: 'running',
      sandboxServerUrl: 'https://sandbox.example.com',
      actingUserId: 'user-1',
    });
    mockWithSandboxServerRpcClient.mockResolvedValue({
      success: true,
      activeModel: ENABLED_MODEL,
      changed: true,
    });
  });

  it('switches the model on the running sandbox', async () => {
    const response = await post(createApp(authContext), {
      model: ENABLED_MODEL,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      activeModel: ENABLED_MODEL,
      changed: true,
    });
    expect(mockWithSandboxServerRpcClient).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 42,
        sandboxServerUrl: 'https://sandbox.example.com',
      }),
    );
  });

  it('rejects a model that is not enabled for the deployment', async () => {
    const response = await post(createApp(authContext), {
      model: DISABLED_MODEL,
    });

    expect(response.status).toBe(400);
    // The launch API accepts arbitrary model strings; this path must not.
    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
  });

  it('requires a model', async () => {
    const response = await post(createApp(authContext), { model: '   ' });

    expect(response.status).toBe(400);
    expect(mockGetDeploymentTaskModelOptions).not.toHaveBeenCalled();
  });

  it('rejects a task that has already exited', async () => {
    mockFindLatestTaskRun.mockResolvedValue({
      id: 42,
      status: 'completed',
      sandboxServerUrl: 'https://sandbox.example.com',
      actingUserId: 'user-1',
    });

    const response = await post(createApp(authContext), {
      model: ENABLED_MODEL,
    });

    expect(response.status).toBe(409);
    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
  });

  it('rejects a task with no active sandbox', async () => {
    mockFindLatestTaskRun.mockResolvedValue({
      id: 42,
      status: 'running',
      sandboxServerUrl: null,
      actingUserId: 'user-1',
    });

    const response = await post(createApp(authContext), {
      model: ENABLED_MODEL,
    });

    expect(response.status).toBe(409);
    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
  });

  it('returns 404 when the task does not exist', async () => {
    mockFindLatestTaskRun.mockResolvedValue(undefined);

    const response = await post(createApp(authContext), {
      model: ENABLED_MODEL,
    });

    expect(response.status).toBe(404);
  });

  it('reports a sandbox capability rejection as a client error', async () => {
    const rejection = new TRPCClientError(
      'Model "anthropic/claude-opus-5" is not available to this task run.',
    );
    Object.assign(rejection, { data: { code: 'PRECONDITION_FAILED' } });
    mockWithSandboxServerRpcClient.mockRejectedValue(rejection);

    const response = await post(createApp(authContext), {
      model: ENABLED_MODEL,
    });

    // A model this run cannot resolve is a capability answer, not an
    // infrastructure fault, so it must not surface as a bad gateway.
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('not available to this task run'),
    });
  });

  it('reports an unexpected sandbox failure as a bad gateway', async () => {
    const failure = new TRPCClientError('socket hang up');
    Object.assign(failure, { data: { code: 'INTERNAL_SERVER_ERROR' } });
    mockWithSandboxServerRpcClient.mockRejectedValue(failure);

    const response = await post(createApp(authContext), {
      model: ENABLED_MODEL,
    });

    expect(response.status).toBe(502);
  });

  it('rejects an unauthenticated request before touching task state', async () => {
    const response = await post(createApp(), { model: ENABLED_MODEL });

    // The shared auth middleware answers first; the handler's own user-context
    // guard covers principal tokens that authenticate without a user.
    expect(response.status).toBe(401);
    expect(mockFindLatestTaskRun).not.toHaveBeenCalled();
  });
});
