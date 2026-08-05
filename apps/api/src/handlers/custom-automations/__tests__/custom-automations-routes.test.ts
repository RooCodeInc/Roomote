import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';
import { customAutomationsRouter } from '../index';

const {
  MockCustomAutomationWriteError,
  mockCreateCustomAutomationWrite,
  mockDeleteCustomAutomation,
  mockGetCustomAutomationById,
  mockListCustomAutomations,
  mockResolveActingUserIdOrNull,
  mockResolveCustomAutomationSchedule,
  mockRunCustomAutomationNow,
  mockUpdateCustomAutomationWrite,
  mockUsersFindFirst,
} = vi.hoisted(() => {
  class MockCustomAutomationWriteError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    MockCustomAutomationWriteError,
    mockCreateCustomAutomationWrite: vi.fn(),
    mockDeleteCustomAutomation: vi.fn(),
    mockGetCustomAutomationById: vi.fn(),
    mockListCustomAutomations: vi.fn(),
    mockResolveActingUserIdOrNull: vi.fn(),
    mockResolveCustomAutomationSchedule: vi.fn(),
    mockRunCustomAutomationNow: vi.fn(),
    mockUpdateCustomAutomationWrite: vi.fn(),
    mockUsersFindFirst: vi.fn(),
  };
});

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })),
  isNull: vi.fn((arg: unknown) => ({ type: 'isNull', arg })),
  users: { id: 'users.id', role: 'users.role', deletedAt: 'users.deletedAt' },
  db: { query: { users: { findFirst: mockUsersFindFirst } } },
  deleteCustomAutomation: mockDeleteCustomAutomation,
  getCustomAutomationById: mockGetCustomAutomationById,
  listCustomAutomations: mockListCustomAutomations,
}));

vi.mock('@roomote/sdk/server', () => ({
  createCustomAutomationWrite: mockCreateCustomAutomationWrite,
  CustomAutomationWriteError: MockCustomAutomationWriteError,
  DUPLICATE_CUSTOM_AUTOMATION_NAME_MESSAGE:
    'A custom automation with this name already exists.',
  resolveCustomAutomationSchedule: mockResolveCustomAutomationSchedule,
  runCustomAutomationNow: mockRunCustomAutomationNow,
  updateCustomAutomationWrite: mockUpdateCustomAutomationWrite,
}));

vi.mock('../../mcp/proxy-utils', () => ({
  resolveActingUserIdOrNull: mockResolveActingUserIdOrNull,
}));

const ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';

function createApp() {
  const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();
  const onError = vi.fn((_error: Error, c: Context) =>
    c.json({ error: 'internal_server_error' }, 500),
  );
  app.onError(onError);
  app.use('*', async (c, next) => {
    const authContext: AuthTokenContext = {
      userId: 'admin-1',
      tokenType: 'auth',
      version: 1,
    };
    c.set('mcpAuth', { userId: 'admin-1', authContext });
    await next();
  });
  app.route('/custom-automations', customAutomationsRouter);
  return { app, onError };
}

describe('custom-automations MCP write routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveActingUserIdOrNull.mockResolvedValue('admin-1');
    mockUsersFindFirst.mockResolvedValue({ id: 'admin-1' });
    mockCreateCustomAutomationWrite.mockResolvedValue({
      status: 'saved',
      automation: { id: 'automation-1' },
      resolution: null,
    });
    mockUpdateCustomAutomationWrite.mockResolvedValue({
      status: 'saved',
      automation: { id: 'automation-1' },
      resolution: null,
    });
  });

  it('adapts create input to the owning write service', async () => {
    const { app } = createApp();
    const response = await app.request('/custom-automations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Nightly report',
        prompt: 'Summarize yesterday.',
        schedule: 'daily',
        model: 'anthropic/claude-sonnet-5',
        environmentId: ENVIRONMENT_ID,
        targetProvider: 'slack',
        targetChannelId: 'C123',
      }),
    });

    expect(response.status).toBe(201);
    expect(mockCreateCustomAutomationWrite).toHaveBeenCalledWith({
      name: 'Nightly report',
      prompt: 'Summarize yesterday.',
      enabled: true,
      model: 'anthropic/claude-sonnet-5',
      environmentId: ENVIRONMENT_ID,
      schedule: { schedule: 'daily', userId: 'admin-1' },
      target: { provider: 'slack', channelId: 'C123' },
      createdByUserId: 'admin-1',
    });
  });

  it('preserves omitted update fields and explicit destination clearing', async () => {
    const { app } = createApp();
    const response = await app.request('/custom-automations/automation-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Updated prompt', targetProvider: null }),
    });

    expect(response.status).toBe(200);
    expect(mockUpdateCustomAutomationWrite).toHaveBeenCalledWith(
      'automation-1',
      expect.objectContaining({
        prompt: 'Updated prompt',
        schedule: undefined,
        target: null,
      }),
    );
  });

  it.each([
    ['invalid_input', 400],
    ['duplicate_name', 400],
    ['not_found', 404],
  ])('maps the stable %s error code to HTTP %i', async (code, status) => {
    const { app } = createApp();
    mockCreateCustomAutomationWrite.mockRejectedValue(
      new MockCustomAutomationWriteError(code, 'Expected failure.'),
    );

    const response = await app.request('/custom-automations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Nightly report',
        prompt: 'Summarize yesterday.',
        schedule: 'daily',
        environmentId: ENVIRONMENT_ID,
      }),
    });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: 'Expected failure.',
      code,
    });
  });

  it('rethrows unexpected failures to the logged 500 path', async () => {
    const { app, onError } = createApp();
    const unexpected = new Error('connection refused');
    mockCreateCustomAutomationWrite.mockRejectedValue(unexpected);

    const response = await app.request('/custom-automations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Nightly report',
        prompt: 'Summarize yesterday.',
        schedule: 'daily',
        environmentId: ENVIRONMENT_ID,
      }),
    });

    expect(response.status).toBe(500);
    expect(onError).toHaveBeenCalledWith(unexpected, expect.anything());
  });
});
