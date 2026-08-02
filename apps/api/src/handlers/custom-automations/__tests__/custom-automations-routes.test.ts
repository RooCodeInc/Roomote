import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';
import {
  customAutomationsRouter,
  DUPLICATE_AUTOMATION_NAME_ERROR,
} from '../index';

const {
  mockUsersFindFirst,
  mockResolveActingUserIdOrNull,
  mockCreateCustomAutomation,
  mockUpdateCustomAutomation,
  mockGetCustomAutomationById,
  mockListCustomAutomations,
  mockDeleteCustomAutomation,
  mockListConnectedCommunicationProviders,
  mockResolveCustomAutomationSchedule,
  mockRunCustomAutomationNow,
} = vi.hoisted(() => ({
  mockUsersFindFirst: vi.fn(),
  mockResolveActingUserIdOrNull: vi.fn(),
  mockCreateCustomAutomation: vi.fn(),
  mockUpdateCustomAutomation: vi.fn(),
  mockGetCustomAutomationById: vi.fn(),
  mockListCustomAutomations: vi.fn(),
  mockDeleteCustomAutomation: vi.fn(),
  mockListConnectedCommunicationProviders: vi.fn(),
  mockResolveCustomAutomationSchedule: vi.fn(),
  mockRunCustomAutomationNow: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })),
  isNull: vi.fn((arg: unknown) => ({ type: 'isNull', arg })),
  users: { id: 'users.id', role: 'users.role', deletedAt: 'users.deletedAt' },
  db: { query: { users: { findFirst: mockUsersFindFirst } } },
  createCustomAutomation: mockCreateCustomAutomation,
  updateCustomAutomation: mockUpdateCustomAutomation,
  deleteCustomAutomation: mockDeleteCustomAutomation,
  getCustomAutomationById: mockGetCustomAutomationById,
  listCustomAutomations: mockListCustomAutomations,
}));

vi.mock('@roomote/sdk/server', () => ({
  listConnectedCommunicationProviders: mockListConnectedCommunicationProviders,
  resolveCustomAutomationSchedule: mockResolveCustomAutomationSchedule,
  runCustomAutomationNow: mockRunCustomAutomationNow,
}));

vi.mock('../../mcp/proxy-utils', () => ({
  resolveActingUserIdOrNull: mockResolveActingUserIdOrNull,
}));

const ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';

function createApp() {
  const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();

  // Mirrors the generic-error branch of `app.onError` in
  // apps/api/src/server.ts: routes rethrow unexpected errors so the app-level
  // handler logs them and returns an opaque 500.
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

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Nightly report',
    prompt: 'Summarize yesterday.',
    schedule: 'daily',
    environmentId: ENVIRONMENT_ID,
    ...overrides,
  };
}

function postCreate(
  app: ReturnType<typeof createApp>['app'],
  body: Record<string, unknown>,
) {
  return app.request('/custom-automations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('custom-automations MCP routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveActingUserIdOrNull.mockResolvedValue('admin-1');
    mockUsersFindFirst.mockResolvedValue({ id: 'admin-1' });
    mockListConnectedCommunicationProviders.mockResolvedValue(['slack']);
  });

  describe('POST / (create)', () => {
    it('returns 400 with the message when the environment does not exist', async () => {
      const { app } = createApp();
      mockCreateCustomAutomation.mockRejectedValue(
        new Error('Selected environment was not found.'),
      );

      const res = await postCreate(app, createBody());

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Selected environment was not found.',
      });
    });

    it('returns 400 with a friendly message for a duplicate name', async () => {
      const { app } = createApp();
      const dbError = Object.assign(
        new Error(
          'duplicate key value violates unique constraint "custom_automations_name_unique_idx"',
        ),
        { code: '23505', constraint: 'custom_automations_name_unique_idx' },
      );
      mockCreateCustomAutomation.mockRejectedValue(dbError);

      const res = await postCreate(app, createBody());

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: DUPLICATE_AUTOMATION_NAME_ERROR,
      });
    });

    it('detects a duplicate name when drizzle wraps the driver error', async () => {
      const { app } = createApp();
      const wrapped = new Error('Failed query: insert into custom_automations');
      (wrapped as { cause?: unknown }).cause = Object.assign(
        new Error('duplicate key value violates unique constraint'),
        { code: '23505', constraint: 'custom_automations_name_unique_idx' },
      );
      mockCreateCustomAutomation.mockRejectedValue(wrapped);

      const res = await postCreate(app, createBody());

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: DUPLICATE_AUTOMATION_NAME_ERROR,
      });
    });

    it('rethrows a 23505 on an unrelated constraint instead of mislabeling it as a duplicate name', async () => {
      const { app, onError } = createApp();
      const unrelatedUniqueViolation = Object.assign(
        new Error(
          'duplicate key value violates unique constraint "environments_name_unique"',
        ),
        { code: '23505', constraint: 'environments_name_unique' },
      );
      mockCreateCustomAutomation.mockRejectedValue(unrelatedUniqueViolation);

      const res = await postCreate(app, createBody());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_server_error' });
      expect(onError).toHaveBeenCalledWith(
        unrelatedUniqueViolation,
        expect.anything(),
      );
    });

    it('returns 400 with the message when the automation cap is reached', async () => {
      const { app } = createApp();
      mockCreateCustomAutomation.mockRejectedValue(
        new Error('You can create at most 25 custom automations.'),
      );

      const res = await postCreate(app, createBody());

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'You can create at most 25 custom automations.',
      });
    });

    it('rethrows unexpected errors so the app-level handler returns 500', async () => {
      const { app, onError } = createApp();
      const unexpected = new Error('connection refused');
      mockCreateCustomAutomation.mockRejectedValue(unexpected);

      const res = await postCreate(app, createBody());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_server_error' });
      expect(onError).toHaveBeenCalledWith(unexpected, expect.anything());
    });
  });

  describe('PATCH /:id (update)', () => {
    const existing = {
      id: 'automation-1',
      name: 'Nightly report',
      prompt: 'Summarize yesterday.',
      enabled: true,
      scheduleMode: 'daily',
      cronExpression: null,
      environmentId: ENVIRONMENT_ID,
      target: {},
    };

    it('returns 400 with the message for a known validation failure', async () => {
      const { app } = createApp();
      mockGetCustomAutomationById.mockResolvedValue(existing);
      mockUpdateCustomAutomation.mockRejectedValue(
        new Error('Selected environment was not found.'),
      );

      const res = await app.request('/custom-automations/automation-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ environmentId: ENVIRONMENT_ID }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Selected environment was not found.',
      });
    });

    it('returns 400 with a friendly message for a duplicate name', async () => {
      const { app } = createApp();
      mockGetCustomAutomationById.mockResolvedValue(existing);
      mockUpdateCustomAutomation.mockRejectedValue(
        Object.assign(new Error('duplicate key value'), {
          code: '23505',
          constraint: 'custom_automations_name_unique_idx',
        }),
      );

      const res = await app.request('/custom-automations/automation-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Taken name' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: DUPLICATE_AUTOMATION_NAME_ERROR,
      });
    });

    it('rethrows unexpected errors so the app-level handler returns 500', async () => {
      const { app, onError } = createApp();
      mockGetCustomAutomationById.mockResolvedValue(existing);
      const unexpected = new Error('connection refused');
      mockUpdateCustomAutomation.mockRejectedValue(unexpected);

      const res = await app.request('/custom-automations/automation-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_server_error' });
      expect(onError).toHaveBeenCalledWith(unexpected, expect.anything());
    });
  });

  describe('POST /resolve-schedule', () => {
    it('returns 400 with the message for a known schedule validation failure', async () => {
      const { app } = createApp();
      mockResolveCustomAutomationSchedule.mockRejectedValue(
        new Error('Use a standard five-field cron expression.'),
      );

      const res = await app.request('/custom-automations/resolve-schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schedule: 'every day at noon' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Use a standard five-field cron expression.',
      });
    });

    it('rethrows unexpected resolution failures so the app-level handler returns 500', async () => {
      const { app, onError } = createApp();
      const unexpected = new Error('LLM request failed');
      mockResolveCustomAutomationSchedule.mockRejectedValue(unexpected);

      const res = await app.request('/custom-automations/resolve-schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schedule: 'every day at noon' }),
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_server_error' });
      expect(onError).toHaveBeenCalledWith(unexpected, expect.anything());
    });
  });
});
