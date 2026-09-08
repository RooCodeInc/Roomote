import { Hono } from 'hono';
import { TRPCError } from '@trpc/server';
import type { Context } from 'hono';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  AuthTokenContext,
  ManageCustomAutomationsInput,
  RunTokenContext,
} from '@roomote/types';
import {
  ALL_REPOSITORIES,
  FAST_EXECUTION,
  MANAGE_CUSTOM_AUTOMATIONS_TOOL,
} from '@roomote/types';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';
import { registerRoomoteCustomAutomationsTool } from '../../mcp/roomote-custom-automations-tool';
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
  mockGetDeploymentTaskModelOptions,
  mockDeleteCustomAutomation,
  mockListConnectedCommunicationProviders,
  mockResolveCustomAutomationSchedule,
  mockRunCustomAutomationNow,
  mockGetAutomationWebhook,
  mockConfigureAutomationWebhook,
  mockRemoveAutomationWebhook,
  mockRetryAutomationWebhookDelivery,
  mockCaptureActivationCustomAutomationChanged,
} = vi.hoisted(() => ({
  mockUsersFindFirst: vi.fn(),
  mockResolveActingUserIdOrNull: vi.fn(),
  mockCreateCustomAutomation: vi.fn(),
  mockUpdateCustomAutomation: vi.fn(),
  mockGetCustomAutomationById: vi.fn(),
  mockListCustomAutomations: vi.fn(),
  mockGetDeploymentTaskModelOptions: vi.fn(),
  mockDeleteCustomAutomation: vi.fn(),
  mockListConnectedCommunicationProviders: vi.fn(),
  mockResolveCustomAutomationSchedule: vi.fn(),
  mockRunCustomAutomationNow: vi.fn(),
  mockGetAutomationWebhook: vi.fn(),
  mockConfigureAutomationWebhook: vi.fn(),
  mockRemoveAutomationWebhook: vi.fn(),
  mockRetryAutomationWebhookDelivery: vi.fn(),
  mockCaptureActivationCustomAutomationChanged: vi.fn(),
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
  getDeploymentTaskModelOptions: mockGetDeploymentTaskModelOptions,
}));

vi.mock('@roomote/sdk/server', () => ({
  getAutomationWebhook: mockGetAutomationWebhook,
  configureAutomationWebhook: mockConfigureAutomationWebhook,
  removeAutomationWebhook: mockRemoveAutomationWebhook,
  retryAutomationWebhookDelivery: mockRetryAutomationWebhookDelivery,
  listConnectedCommunicationProviders: mockListConnectedCommunicationProviders,
  resolveCustomAutomationSchedule: mockResolveCustomAutomationSchedule,
  runCustomAutomationNow: mockRunCustomAutomationNow,
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureActivationCustomAutomationChanged:
    mockCaptureActivationCustomAutomationChanged,
}));

vi.mock('../../mcp/proxy-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp/proxy-utils')>()),
  resolveActingUserIdOrNull: mockResolveActingUserIdOrNull,
}));

const ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';
const ENABLED_MODELS = [
  {
    id: 'openai/gpt-5.6-luna',
    displayName: 'GPT 5.6 Luna',
    family: 'GPT',
  },
  {
    id: 'openrouter/openai/gpt-5.6-luna',
    displayName: 'GPT 5.6 Luna',
    family: 'GPT',
  },
  {
    id: 'openai/gpt-4.1',
    displayName: 'GPT 4.1',
    family: 'GPT',
    metadata: { supportsReasoning: false },
  },
];

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

function registerApiHostedTool(auth: McpAuth) {
  let handler:
    | ((params: ManageCustomAutomationsInput) => Promise<unknown>)
    | undefined;
  const registerTool = vi.fn(
    (
      _name: string,
      _config: unknown,
      toolHandler: (params: ManageCustomAutomationsInput) => Promise<unknown>,
    ) => {
      handler = toolHandler;
    },
  );

  registerRoomoteCustomAutomationsTool(
    { registerTool } as unknown as McpServer,
    auth,
  );

  expect(handler).toBeDefined();
  return { handler: handler!, registerTool };
}

describe('custom-automations MCP routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveActingUserIdOrNull.mockResolvedValue('admin-1');
    mockUsersFindFirst.mockResolvedValue({ id: 'admin-1', role: 'admin' });
    mockListConnectedCommunicationProviders.mockResolvedValue(['slack']);
    mockGetDeploymentTaskModelOptions.mockResolvedValue({
      models: ENABLED_MODELS,
      defaultModelId: 'openai/gpt-5.6-luna',
    });
  });

  describe('API-hosted Roomote MCP tool', () => {
    describe.each([
      ['GET', '/webhook', mockGetAutomationWebhook],
      ['POST', '/webhook', mockConfigureAutomationWebhook],
      ['DELETE', '/webhook', mockRemoveAutomationWebhook],
      [
        'POST',
        '/webhook/deliveries/delivery-1/retry',
        mockRetryAutomationWebhookDelivery,
      ],
    ] as const)('%s %s errors', (method, suffix, service) => {
      it.each([
        ['UNAUTHORIZED', 401],
        ['FORBIDDEN', 403],
        ['CONFLICT', 409],
        ['PRECONDITION_FAILED', 409],
        ['BAD_REQUEST', 400],
        ['NOT_FOUND', 404],
      ] as const)(
        'maps %s to %s without exposing error details',
        async (code, status) => {
          service.mockRejectedValueOnce(
            new TRPCError({
              code,
              message: 'Action cannot be completed.',
              cause: new Error('private credential and upstream trace'),
            }),
          );
          const { app, onError } = createApp();
          const response = await app.request(`/custom-automations/a${suffix}`, {
            method,
            ...(method === 'POST'
              ? {
                  headers: { 'content-type': 'application/json' },
                  body: '{}',
                }
              : {}),
          });
          expect(response.status).toBe(status);
          expect(await response.json()).toEqual({
            error: 'Action cannot be completed.',
          });
          expect(onError).not.toHaveBeenCalled();
        },
      );

      it.each([
        new Error('private database failure'),
        Object.assign(new Error('not a trusted tRPC error'), {
          code: 'FORBIDDEN',
        }),
        new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'private internal details',
        }),
        new TRPCError({
          code: 'BAD_GATEWAY',
          message: 'private upstream details',
        }),
      ])('keeps unexpected failures opaque', async (error) => {
        service.mockRejectedValueOnce(error);
        const { app, onError } = createApp();
        const response = await app.request(`/custom-automations/a${suffix}`, {
          method,
          ...(method === 'POST'
            ? {
                headers: { 'content-type': 'application/json' },
                body: '{}',
              }
            : {}),
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: 'internal_server_error',
        });
        expect(onError).toHaveBeenCalledWith(error, expect.anything());
      });
    });

    it.each([
      ['webhook_inspect', mockGetAutomationWebhook],
      ['webhook_configure', mockConfigureAutomationWebhook],
      ['webhook_remove', mockRemoveAutomationWebhook],
      ['webhook_retry', mockRetryAutomationWebhookDelivery],
    ] as const)(
      'forwards the resolved actor for %s',
      async (action, service) => {
        mockResolveActingUserIdOrNull.mockResolvedValue('actor-2');
        mockUsersFindFirst.mockResolvedValue({ id: 'actor-2', role: 'member' });
        service.mockResolvedValue({ outcome: 'queued' });
        const { handler } = registerApiHostedTool({
          userId: 'token-user',
          authContext: {
            tokenType: 'run',
            runId: 42,
            userId: 'token-user',
            principal: 'user',
            version: 1,
          },
        });
        const result = await handler({
          action,
          automationId: 'automation-1',
          deliveryId: 'delivery-1',
        });
        expect(service).toHaveBeenCalledWith(
          'actor-2',
          'automation-1',
          ...(action === 'webhook_configure'
            ? [
                {
                  events: ['note.generated', 'note.access_granted'],
                  folderIds: [],
                  scopes: ['workspace'],
                  maxRunsPerDay: 20,
                  enabled: true,
                },
              ]
            : action === 'webhook_retry'
              ? ['delivery-1']
              : action === 'webhook_remove'
                ? [undefined]
                : []),
        );
        expect(JSON.stringify(result)).toContain('queued');
      },
    );

    it('rejects invalid webhook configuration before calling the service', async () => {
      const { app } = createApp();
      const response = await app.request('/custom-automations/a/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxRunsPerDay: 0 }),
      });
      expect(response.status).toBe(400);
      expect(mockConfigureAutomationWebhook).not.toHaveBeenCalled();
    });

    it.each([undefined, false, true])(
      'forwards DELETE removal opt-in %s',
      async (forceLocalRemoval) => {
        mockRemoveAutomationWebhook.mockResolvedValue({ removed: true });
        const { app } = createApp();
        const response = await app.request('/custom-automations/a/webhook', {
          method: 'DELETE',
          ...(forceLocalRemoval === undefined
            ? {}
            : {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ forceLocalRemoval }),
              }),
        });
        expect(response.status).toBe(200);
        expect(mockRemoveAutomationWebhook).toHaveBeenCalledExactlyOnceWith(
          'admin-1',
          'a',
          forceLocalRemoval,
        );
      },
    );

    it.each([
      '{"forceLocalRemoval":"true"}',
      '{"forceLocalRemoval":null}',
      '{"forceLocalRemoval":1}',
      'null',
      '[]',
      '{',
    ])('rejects invalid DELETE body %s', async (body) => {
      const { app } = createApp();
      const response = await app.request('/custom-automations/a/webhook', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status).toBe(400);
      expect(mockRemoveAutomationWebhook).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'forwards MCP removal opt-in %s',
      async (forceLocalRemoval) => {
        mockRemoveAutomationWebhook.mockResolvedValue({ removed: true });
        const { handler } = registerApiHostedTool({
          userId: 'admin-1',
          authContext: {
            tokenType: 'run',
            runId: 42,
            userId: 'admin-1',
            principal: 'user',
            version: 1,
          },
        });
        await handler({
          action: 'webhook_remove',
          automationId: 'a',
          forceLocalRemoval,
        });
        expect(mockRemoveAutomationWebhook).toHaveBeenCalledExactlyOnceWith(
          'admin-1',
          'a',
          forceLocalRemoval,
        );
      },
    );

    it('rejects webhook requests without an authenticated actor', async () => {
      mockResolveActingUserIdOrNull.mockResolvedValue(null);
      const { app } = createApp();
      expect((await app.request('/custom-automations/a/webhook')).status).toBe(
        403,
      );
      expect(mockGetAutomationWebhook).not.toHaveBeenCalled();
    });
    it('invokes the authoritative router with run-token acting-user authorization', async () => {
      const authContext: RunTokenContext = {
        tokenType: 'run',
        runId: 42,
        userId: 'token-user',
        principal: 'user',
        version: 1,
      };
      const { handler, registerTool } = registerApiHostedTool({
        userId: 'admin-1',
        authContext,
      });
      mockListCustomAutomations.mockResolvedValue([]);

      const result = await handler({ action: 'list' });

      expect(mockResolveActingUserIdOrNull).toHaveBeenCalledWith({
        userId: 'admin-1',
        tokenType: 'run',
        runId: 42,
      });
      expect(mockUsersFindFirst).toHaveBeenCalledOnce();
      expect(mockListCustomAutomations).toHaveBeenCalledOnce();
      expect(registerTool).toHaveBeenCalledWith(
        MANAGE_CUSTOM_AUTOMATIONS_TOOL.name,
        expect.objectContaining({
          description: MANAGE_CUSTOM_AUTOMATIONS_TOOL.description,
          inputSchema: MANAGE_CUSTOM_AUTOMATIONS_TOOL.inputSchema,
        }),
        expect.any(Function),
      );
      expect(result).toMatchObject({
        structuredContent: { automations: [] },
      });
    });

    it('returns compact automation records without changing the API response', async () => {
      const authContext: AuthTokenContext = {
        userId: 'admin-1',
        tokenType: 'auth',
        version: 1,
      };
      const { handler } = registerApiHostedTool({
        userId: 'admin-1',
        authContext,
      });
      mockListCustomAutomations.mockResolvedValue([
        {
          id: 'automation-1',
          name: 'Nightly report',
          prompt: 'Large private prompt',
          enabled: true,
          scheduleMode: 'daily',
          cronExpression: null,
          model: null,
          environmentId: ENVIRONMENT_ID,
          allRepositories: false,
          executionMode: 'sandbox_task',
          target: {},
          createdByUser: { id: 'admin-1', email: 'admin@example.com' },
          lastError: 'previous failure',
        },
      ]);

      const toolResult = (await handler({ action: 'list' })) as {
        structuredContent: unknown;
      };
      expect(toolResult.structuredContent).toEqual({
        automations: [
          {
            id: 'automation-1',
            name: 'Nightly report',
            enabled: true,
            schedule: 'daily',
            model: null,
            environmentId: ENVIRONMENT_ID,
            lastError: 'previous failure',
          },
        ],
      });

      const { app } = createApp();
      const apiResult = await app.request('/custom-automations');
      expect(await apiResult.json()).toMatchObject({
        automations: [
          {
            prompt: 'Large private prompt',
            createdByUser: { email: 'admin@example.com' },
            lastError: 'previous failure',
          },
        ],
      });
    });

    it('returns one configured prompt without unrelated automation fields', async () => {
      const authContext: AuthTokenContext = {
        userId: 'admin-1',
        tokenType: 'auth',
        version: 1,
      };
      const { handler } = registerApiHostedTool({
        userId: 'admin-1',
        authContext,
      });
      mockGetCustomAutomationById.mockResolvedValue({
        id: 'automation-1',
        name: 'Nightly report',
        prompt: 'Inspect this stored prompt.',
        enabled: true,
        lastError: 'previous failure',
      });

      const result = await handler({
        action: 'inspect',
        automationId: 'automation-1',
      });

      expect(mockGetCustomAutomationById).toHaveBeenCalledWith('automation-1');
      expect(
        (result as { structuredContent: unknown }).structuredContent,
      ).toEqual({
        automation: {
          id: 'automation-1',
          name: 'Nightly report',
          prompt: 'Inspect this stored prompt.',
        },
      });
    });

    it('routes create actions through the existing custom automation domain handler', async () => {
      const authContext: AuthTokenContext = {
        userId: 'admin-1',
        tokenType: 'auth',
        version: 1,
      };
      const { handler } = registerApiHostedTool({
        userId: 'admin-1',
        authContext,
      });
      mockCreateCustomAutomation.mockResolvedValue({
        id: 'automation-1',
        environmentId: ENVIRONMENT_ID,
        allRepositories: false,
      });

      const result = await handler({
        action: 'create',
        name: 'Nightly report',
        prompt: 'Summarize yesterday.',
        schedule: 'daily',
        environmentId: ENVIRONMENT_ID,
      });

      expect(mockCreateCustomAutomation).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Nightly report',
          prompt: 'Summarize yesterday.',
          environmentId: ENVIRONMENT_ID,
          createdByUserId: 'admin-1',
        }),
      );
      expect(result).toMatchObject({
        structuredContent: {
          automation: {
            id: 'automation-1',
            environmentId: ENVIRONMENT_ID,
          },
        },
      });
    });

    it('returns a non-terminal queued result for a Fast run', async () => {
      const authContext: AuthTokenContext = {
        userId: 'admin-1',
        tokenType: 'auth',
        version: 1,
      };
      const { handler } = registerApiHostedTool({
        userId: 'admin-1',
        authContext,
      });
      mockRunCustomAutomationNow.mockResolvedValue({ outcome: 'queued' });
      mockGetCustomAutomationById.mockResolvedValue({ id: 'automation-1' });

      const result = await handler({
        action: 'run_now',
        automationId: 'automation-1',
      });

      expect(mockRunCustomAutomationNow).toHaveBeenCalledWith('automation-1');
      expect(result).toMatchObject({
        structuredContent: { outcome: 'queued' },
      });
    });

    it('returns an MCP tool error when the acting user is not active in the deployment', async () => {
      const authContext: AuthTokenContext = {
        userId: 'member-1',
        tokenType: 'auth',
        version: 1,
      };
      const { handler } = registerApiHostedTool({
        userId: 'member-1',
        authContext,
      });
      mockResolveActingUserIdOrNull.mockResolvedValue('member-1');
      mockUsersFindFirst.mockResolvedValue(null);

      const result = await handler({
        action: 'inspect',
        automationId: 'automation-1',
      });

      expect(mockListCustomAutomations).not.toHaveBeenCalled();
      expect(mockGetCustomAutomationById).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          status: 403,
          error: 'User access required',
        },
      });
    });
  });

  it('lists the deployment models available for automation overrides', async () => {
    const { app } = createApp();

    const res = await app.request('/custom-automations/models');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      models: ENABLED_MODELS,
      defaultModelId: 'openai/gpt-5.6-luna',
    });
  });

  describe('member ownership', () => {
    beforeEach(() => {
      mockResolveActingUserIdOrNull.mockResolvedValue('member-1');
      mockUsersFindFirst.mockResolvedValue({ id: 'member-1', role: 'member' });
    });

    it('lists only owned automations', async () => {
      mockListCustomAutomations.mockResolvedValue([
        { id: 'own', createdByUserId: 'member-1' },
        { id: 'other', createdByUserId: 'other' },
        { id: 'ownerless', createdByUserId: null },
      ]);
      const { app } = createApp();
      const response = await app.request('/custom-automations');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        automations: [{ id: 'own' }],
      });
    });

    it.each(['other', null])(
      'denies every ID operation for owner %s without side effects',
      async (createdByUserId) => {
        mockGetCustomAutomationById.mockResolvedValue({
          id: 'automation-1',
          createdByUserId,
        });
        const { app } = createApp();
        for (const [method, suffix] of [
          ['GET', ''],
          ['PATCH', ''],
          ['DELETE', ''],
          ['POST', '/run'],
        ]) {
          const response = await app.request(
            `/custom-automations/automation-1${suffix}`,
            {
              method,
              ...(method === 'PATCH'
                ? {
                    headers: { 'content-type': 'application/json' },
                    body: '{}',
                  }
                : {}),
            },
          );
          expect(response.status).toBe(404);
        }
        expect(mockUpdateCustomAutomation).not.toHaveBeenCalled();
        expect(mockDeleteCustomAutomation).not.toHaveBeenCalled();
        expect(mockRunCustomAutomationNow).not.toHaveBeenCalled();
      },
    );

    it('creates with the resolved actor rather than caller-supplied ownership', async () => {
      mockCreateCustomAutomation.mockResolvedValue({ id: 'own' });
      const { app } = createApp();
      const response = await postCreate(
        app,
        createBody({ createdByUserId: 'admin-1' }),
      );
      expect(response.status).toBe(201);
      expect(mockCreateCustomAutomation).toHaveBeenCalledWith(
        expect.objectContaining({ createdByUserId: 'member-1' }),
      );
    });

    it('allows owners to inspect, delete and run their automation', async () => {
      mockGetCustomAutomationById.mockResolvedValue({
        id: 'own',
        createdByUserId: 'member-1',
        target: {},
      });
      mockRunCustomAutomationNow.mockResolvedValue({ outcome: 'queued' });
      const { app } = createApp();
      expect((await app.request('/custom-automations/own')).status).toBe(200);
      expect(
        (await app.request('/custom-automations/own/run', { method: 'POST' }))
          .status,
      ).toBe(200);
      expect(
        (await app.request('/custom-automations/own', { method: 'DELETE' }))
          .status,
      ).toBe(200);
    });

    it('allows owner updates without transferring ownership from the request', async () => {
      const existing = {
        id: 'own',
        createdByUserId: 'member-1',
        name: 'Report',
        prompt: 'Summarize',
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: null,
        model: null,
        reasoningEffort: null,
        executionMode: 'fast',
        target: {},
      };
      mockGetCustomAutomationById.mockResolvedValue(existing);
      mockUpdateCustomAutomation.mockResolvedValue(existing);
      const { app } = createApp();
      const response = await app.request('/custom-automations/own', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Updated', createdByUserId: 'admin-1' }),
      });
      expect(response.status).toBe(200);
      expect(mockUpdateCustomAutomation).toHaveBeenCalledWith(
        'own',
        expect.objectContaining({ name: 'Updated' }),
      );
      expect(mockUpdateCustomAutomation.mock.calls[0]?.[1]).not.toHaveProperty(
        'createdByUserId',
      );
    });
  });

  it('rejects run-now for an ID missing from this deployment even for an admin', async () => {
    mockGetCustomAutomationById.mockResolvedValue(null);
    const { app } = createApp();
    expect(
      (await app.request('/custom-automations/missing/run', { method: 'POST' }))
        .status,
    ).toBe(404);
    expect(mockRunCustomAutomationNow).not.toHaveBeenCalled();
  });

  it('returns a bounded stored prompt record by automation ID', async () => {
    const { app } = createApp();
    mockGetCustomAutomationById.mockResolvedValue({
      id: 'automation-1',
      name: 'Nightly report',
      prompt: 'Inspect this stored prompt.',
      enabled: true,
      lastError: 'previous failure',
    });

    const res = await app.request('/custom-automations/automation-1');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      automation: {
        id: 'automation-1',
        name: 'Nightly report',
        prompt: 'Inspect this stored prompt.',
      },
    });
  });

  it('returns not found when inspecting a missing automation', async () => {
    const { app } = createApp();
    mockGetCustomAutomationById.mockResolvedValue(null);

    const res = await app.request('/custom-automations/missing');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'Custom automation was not found.',
    });
  });

  describe('POST / (create)', () => {
    it('rejects a model that is not enabled for new tasks', async () => {
      const { app } = createApp();

      const res = await postCreate(
        app,
        createBody({ model: 'requesty/openai/gpt-5.6-luna' }),
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error:
          'Model "requesty/openai/gpt-5.6-luna" is not enabled for new tasks.',
      });
      expect(mockCreateCustomAutomation).not.toHaveBeenCalled();
    });

    it.each(['openai/gpt-5.6-luna', 'openrouter/openai/gpt-5.6-luna'])(
      'accepts the exact enabled model ID %s',
      async (model) => {
        const { app } = createApp();
        mockResolveCustomAutomationSchedule.mockResolvedValue({
          status: 'resolved',
          scheduleMode: 'daily',
          cronExpression: null,
          resolution: null,
        });
        mockCreateCustomAutomation.mockResolvedValue({ id: 'automation-1' });

        const res = await postCreate(app, createBody({ model }));

        expect(res.status).toBe(201);
        expect(mockCreateCustomAutomation).toHaveBeenCalledWith(
          expect.objectContaining({ model }),
        );
      },
    );

    it('persists a supported reasoning effort with the selected model', async () => {
      const { app } = createApp();
      mockResolveCustomAutomationSchedule.mockResolvedValue({
        status: 'resolved',
        scheduleMode: 'daily',
        cronExpression: null,
        resolution: null,
      });
      mockCreateCustomAutomation.mockResolvedValue({ id: 'automation-1' });

      const res = await postCreate(
        app,
        createBody({
          model: 'openai/gpt-5.6-luna',
          reasoningEffort: 'high',
        }),
      );

      expect(res.status).toBe(201);
      expect(mockCreateCustomAutomation).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'openai/gpt-5.6-luna',
          reasoningEffort: 'high',
        }),
      );
    });

    it('rejects reasoning effort without a selected model', async () => {
      const { app } = createApp();

      const res = await postCreate(
        app,
        createBody({ reasoningEffort: 'high' }),
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'Reasoning effort requires a model override.',
      });
      expect(mockCreateCustomAutomation).not.toHaveBeenCalled();
    });

    it('rejects reasoning effort for a model without reasoning support', async () => {
      const { app } = createApp();

      const res = await postCreate(
        app,
        createBody({ model: 'openai/gpt-4.1', reasoningEffort: 'high' }),
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error:
          'Model "openai/gpt-4.1" does not support configurable reasoning effort.',
      });
      expect(mockCreateCustomAutomation).not.toHaveBeenCalled();
    });

    it('accepts the all-repositories workspace target', async () => {
      const { app } = createApp();
      mockResolveCustomAutomationSchedule.mockResolvedValue({
        status: 'resolved',
        scheduleMode: 'daily',
        cronExpression: null,
        resolution: null,
      });
      mockCreateCustomAutomation.mockResolvedValue({
        id: 'automation-1',
        environmentId: null,
        allRepositories: true,
      });

      const res = await postCreate(
        app,
        createBody({ environmentId: ALL_REPOSITORIES }),
      );

      expect(res.status).toBe(201);
      expect(mockCreateCustomAutomation).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: ALL_REPOSITORIES }),
      );
      await expect(res.json()).resolves.toMatchObject({
        automation: { environmentId: ALL_REPOSITORIES },
      });
    });

    it('accepts Fast from the environment target contract', async () => {
      const { app } = createApp();
      mockResolveCustomAutomationSchedule.mockResolvedValue({
        status: 'resolved',
        scheduleMode: 'daily',
        cronExpression: null,
        resolution: null,
      });
      mockCreateCustomAutomation.mockResolvedValue({
        id: 'automation-fast',
        environmentId: null,
        allRepositories: false,
        executionMode: 'fast',
      });

      const res = await postCreate(
        app,
        createBody({ environmentId: FAST_EXECUTION }),
      );

      expect(res.status).toBe(201);
      expect(mockCreateCustomAutomation).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: FAST_EXECUTION }),
      );
      await expect(res.json()).resolves.toMatchObject({
        automation: { environmentId: FAST_EXECUTION, executionMode: 'fast' },
      });
    });

    it('tracks creation with only the destination provider', async () => {
      const { app } = createApp();
      mockResolveCustomAutomationSchedule.mockResolvedValue({
        status: 'resolved',
        scheduleMode: 'daily',
        cronExpression: null,
        resolution: null,
      });
      mockCreateCustomAutomation.mockResolvedValue({ id: 'automation-1' });

      const res = await postCreate(
        app,
        createBody({
          targetProvider: 'slack',
          targetChannelId: 'private-channel-id',
        }),
      );

      expect(res.status).toBe(201);
      expect(mockCaptureActivationCustomAutomationChanged).toHaveBeenCalledWith(
        'created',
        'slack',
      );
    });

    it('stores DM me as a logical Slack user target', async () => {
      const { app } = createApp();
      mockResolveCustomAutomationSchedule.mockResolvedValue({
        status: 'resolved',
        scheduleMode: 'daily',
        cronExpression: null,
        resolution: null,
      });
      mockCreateCustomAutomation.mockResolvedValue({ id: 'automation-1' });

      const res = await postCreate(
        app,
        createBody({
          targetProvider: 'slack',
          targetMode: 'direct_message',
        }),
      );

      expect(res.status).toBe(201);
      expect(mockCreateCustomAutomation).toHaveBeenCalledWith(
        expect.objectContaining({
          createdByUserId: 'admin-1',
          target: {
            provider: 'slack',
            targetKind: 'slack_user',
            externalRef: 'admin-1',
          },
        }),
      );
    });

    it.each([
      ['discord', 'discord_user'],
      ['teams', 'teams_user'],
      ['telegram', 'telegram_user'],
    ] as const)(
      'stores %s DM me as a logical user target',
      async (provider, targetKind) => {
        const { app } = createApp();
        mockListConnectedCommunicationProviders.mockResolvedValue([provider]);
        mockResolveCustomAutomationSchedule.mockResolvedValue({
          status: 'resolved',
          scheduleMode: 'daily',
          cronExpression: null,
          resolution: null,
        });
        mockCreateCustomAutomation.mockResolvedValue({ id: 'automation-1' });

        const res = await postCreate(
          app,
          createBody({
            targetProvider: provider,
            targetMode: 'direct_message',
          }),
        );

        expect(res.status).toBe(201);
        expect(mockCreateCustomAutomation).toHaveBeenCalledWith(
          expect.objectContaining({
            createdByUserId: 'admin-1',
            target: {
              provider,
              targetKind,
              externalRef: 'admin-1',
            },
          }),
        );
      },
    );

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

  describe('DELETE /:id', () => {
    it.each([
      [
        'Remove the automation webhook subscription before deleting this automation.',
        409,
      ],
      [
        'Remove the automation webhook subscription before deleting this automation. private details',
        500,
      ],
      ['private database failure', 500],
    ])('handles deletion failure with status %s', async (message, status) => {
      mockGetCustomAutomationById.mockResolvedValue({
        id: 'automation-1',
        target: {},
      });
      const error = new Error(message);
      mockDeleteCustomAutomation.mockRejectedValueOnce(error);
      const { app, onError } = createApp();
      const response = await app.request('/custom-automations/automation-1', {
        method: 'DELETE',
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: status === 409 ? message : 'internal_server_error',
      });
      expect(
        mockCaptureActivationCustomAutomationChanged,
      ).not.toHaveBeenCalled();
      if (status === 409) expect(onError).not.toHaveBeenCalled();
      else expect(onError).toHaveBeenCalledWith(error, expect.anything());
    });

    it('tracks deletion with only the persisted destination provider', async () => {
      const { app } = createApp();
      mockGetCustomAutomationById.mockResolvedValue({
        id: 'automation-1',
        name: 'Private automation name',
        target: { provider: 'discord' },
      });

      const res = await app.request('/custom-automations/automation-1', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      expect(mockCaptureActivationCustomAutomationChanged).toHaveBeenCalledWith(
        'deleted',
        'discord',
      );
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
      model: null,
      reasoningEffort: null,
      environmentId: ENVIRONMENT_ID,
      target: {},
    };

    it('rejects an unavailable model before updating', async () => {
      const { app } = createApp();
      mockGetCustomAutomationById.mockResolvedValue(existing);

      const res = await app.request('/custom-automations/automation-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'requesty/openai/gpt-5.6-luna' }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error:
          'Model "requesty/openai/gpt-5.6-luna" is not enabled for new tasks.',
      });
      expect(mockUpdateCustomAutomation).not.toHaveBeenCalled();
    });

    it('clears reasoning effort without clearing the model', async () => {
      const { app } = createApp();
      mockGetCustomAutomationById.mockResolvedValue({
        ...existing,
        model: 'openai/gpt-5.6-luna',
        reasoningEffort: 'high',
      });
      mockUpdateCustomAutomation.mockResolvedValue({ id: 'automation-1' });

      const res = await app.request('/custom-automations/automation-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reasoningEffort: null }),
      });

      expect(res.status).toBe(200);
      expect(mockUpdateCustomAutomation).toHaveBeenCalledWith(
        'automation-1',
        expect.objectContaining({
          model: 'openai/gpt-5.6-luna',
          reasoningEffort: null,
        }),
      );
    });

    it('clears reasoning effort when the model is cleared', async () => {
      const { app } = createApp();
      mockGetCustomAutomationById.mockResolvedValue({
        ...existing,
        model: 'openai/gpt-5.6-luna',
        reasoningEffort: 'high',
      });
      mockUpdateCustomAutomation.mockResolvedValue({ id: 'automation-1' });

      const res = await app.request('/custom-automations/automation-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: null }),
      });

      expect(res.status).toBe(200);
      expect(mockUpdateCustomAutomation).toHaveBeenCalledWith(
        'automation-1',
        expect.objectContaining({
          model: null,
          reasoningEffort: null,
        }),
      );
    });

    it('switches an existing automation to all repositories', async () => {
      const { app } = createApp();
      mockGetCustomAutomationById.mockResolvedValue(existing);
      mockUpdateCustomAutomation.mockResolvedValue({
        ...existing,
        environmentId: null,
        allRepositories: true,
      });

      const res = await app.request('/custom-automations/automation-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ environmentId: ALL_REPOSITORIES }),
      });

      expect(res.status).toBe(200);
      expect(mockUpdateCustomAutomation).toHaveBeenCalledWith(
        'automation-1',
        expect.objectContaining({ environmentId: ALL_REPOSITORIES }),
      );
      await expect(res.json()).resolves.toMatchObject({
        automation: { environmentId: ALL_REPOSITORIES },
      });
    });

    it('preserves a DM-me target without treating its user reference as a channel', async () => {
      const { app } = createApp();
      mockGetCustomAutomationById.mockResolvedValue({
        ...existing,
        createdByUserId: 'admin-1',
        target: {
          provider: 'telegram',
          targetKind: 'telegram_user',
          externalRef: 'admin-1',
        },
      });
      mockUpdateCustomAutomation.mockResolvedValue({ id: 'automation-1' });

      const res = await app.request('/custom-automations/automation-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(200);
      expect(mockUpdateCustomAutomation).toHaveBeenCalledWith(
        'automation-1',
        expect.objectContaining({
          target: {
            provider: 'telegram',
            targetKind: 'telegram_user',
            externalRef: 'admin-1',
          },
        }),
      );
    });

    it('rejects switching a DM target to channel mode without a channel', async () => {
      const { app } = createApp();
      mockGetCustomAutomationById.mockResolvedValue({
        ...existing,
        createdByUserId: 'admin-1',
        target: {
          provider: 'slack',
          targetKind: 'slack_user',
          externalRef: 'admin-1',
        },
      });

      const res = await app.request('/custom-automations/automation-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetMode: 'channel' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'targetChannelId is required when targetProvider is set.',
      });
      expect(mockUpdateCustomAutomation).not.toHaveBeenCalled();
    });

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
