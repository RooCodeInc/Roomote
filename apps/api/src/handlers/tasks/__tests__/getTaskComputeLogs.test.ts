import { Hono } from 'hono';
import type { AuthTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { getTaskComputeLogs } from '../getTaskComputeLogs';

const {
  mockSelect,
  mockFindMany,
  mockCreateComputeProviderClient,
  mockGetComputeProviderCapabilities,
  mockGetCommandOutput,
  mockLogHandlerError,
  visibleTaskHistoryCondition,
  selectFromMock,
  selectWhereMock,
  selectLimitMock,
  andMock,
  eqMock,
  ascMock,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockFindMany: vi.fn(),
  mockCreateComputeProviderClient: vi.fn(),
  mockGetComputeProviderCapabilities: vi.fn(),
  mockGetCommandOutput: vi.fn(),
  mockLogHandlerError: vi.fn(),
  visibleTaskHistoryCondition: { type: 'visibleTaskHistoryCondition' },
  selectFromMock: vi.fn(),
  selectWhereMock: vi.fn(),
  selectLimitMock: vi.fn(),
  andMock: vi.fn((...args) => ({ type: 'and', args })),
  eqMock: vi.fn((...args) => ({ type: 'eq', args })),
  ascMock: vi.fn((value) => ({ type: 'asc', value })),
}));

vi.mock('../helpers', () => ({
  visibleTaskHistoryCondition,
}));

vi.mock('../../utils', () => ({
  logHandlerError: mockLogHandlerError,
}));

vi.mock('@roomote/compute-providers', () => ({
  createComputeProviderClient: mockCreateComputeProviderClient,
  getComputeProviderCapabilities: mockGetComputeProviderCapabilities,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: mockSelect,
    query: {
      taskRuns: {
        findMany: mockFindMany,
      },
    },
  },
  tasks: { id: 'tasks.id', orgId: 'tasks.orgId' },
  taskRuns: {
    id: 'taskRuns.id',
    taskId: 'taskRuns.taskId',
    createdAt: 'taskRuns.createdAt',
  },
  eq: eqMock,
  and: andMock,
  asc: ascMock,
  resolveComputeProviderEnvValues: vi.fn().mockResolvedValue({}),
}));

function createApp(authContext?: AuthTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }

    await next();
  });

  app.use('*', mcpAuthMiddleware);
  app.get('/tasks/:taskId/compute_logs', getTaskComputeLogs);

  return app;
}

describe('getTaskComputeLogs', () => {
  const authContext: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    selectFromMock.mockReturnValue({
      where: selectWhereMock,
    });
    selectWhereMock.mockReturnValue({
      limit: selectLimitMock,
    });
    selectLimitMock.mockResolvedValue([{ id: 'task-1' }]);
    mockSelect.mockReturnValue({
      from: selectFromMock,
    });
    mockGetComputeProviderCapabilities.mockImplementation((provider) => {
      switch (provider) {
        case 'modal':
          return {
            supportsCreateInstance: true,
            supportsDestroyInstance: true,
            supportsCommandExecution: true,
            supportsCommandOutputStreaming: false,
            supportsCommandOutputLookup: false,
            supportsSnapshots: true,
            supportsResume: true,
            supportsFileWrite: true,
          };
        case 'daytona':
          return {
            supportsCreateInstance: true,
            supportsDestroyInstance: true,
            supportsCommandExecution: true,
            supportsCommandOutputStreaming: true,
            supportsCommandOutputLookup: true,
            supportsSnapshots: false,
            supportsResume: false,
            supportsFileWrite: true,
          };
        default:
          throw new Error(`Unexpected provider: ${String(provider)}`);
      }
    });
    mockCreateComputeProviderClient.mockReturnValue({
      getCommandOutput: mockGetCommandOutput,
    });
  });

  afterEach(() => {});

  it('returns task cloud jobs with output, skipped reasons, and per-job errors', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 101,
        status: 'failed',
        vendor: 'daytona',
        machineId: 'sandbox-1',
        sandboxCmdId: 'cmd-1',
      },
      {
        id: 102,
        status: 'completed',
        vendor: 'daytona',
        machineId: null,
        sandboxCmdId: 'cmd-2',
      },
      {
        id: 103,
        status: 'failed',
        vendor: 'daytona',
        machineId: 'sandbox-3',
        sandboxCmdId: 'cmd-3',
      },
      {
        id: 104,
        status: 'completed',
        vendor: 'modal',
        machineId: 'modal-1',
        sandboxCmdId: 'cmd-4',
      },
      {
        id: 105,
        status: 'failed',
        vendor: 'legacy-sandbox',
        machineId: 'legacy-1',
        sandboxCmdId: 'cmd-5',
      },
    ]);
    mockGetCommandOutput
      .mockResolvedValueOnce('sandbox boot output')
      .mockRejectedValueOnce(new Error('command output unavailable'));

    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-1/compute_logs',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      taskId: 'task-1',
      returned: 5,
      cloudJobs: [
        {
          id: 101,
          status: 'failed',
          vendor: 'daytona',
          machineId: 'sandbox-1',
          sandboxCmdId: 'cmd-1',
          output: 'sandbox boot output',
          skippedReason: null,
          error: null,
        },
        {
          id: 102,
          status: 'completed',
          vendor: 'daytona',
          machineId: null,
          sandboxCmdId: 'cmd-2',
          output: null,
          skippedReason: 'missing_machine_id',
          error: null,
        },
        {
          id: 103,
          status: 'failed',
          vendor: 'daytona',
          machineId: 'sandbox-3',
          sandboxCmdId: 'cmd-3',
          output: null,
          skippedReason: null,
          error: 'command output unavailable',
        },
        {
          id: 104,
          status: 'completed',
          vendor: 'modal',
          machineId: 'modal-1',
          sandboxCmdId: 'cmd-4',
          output: null,
          skippedReason: 'unsupported_command_output_lookup:modal',
          error: null,
        },
        {
          id: 105,
          status: 'failed',
          vendor: 'legacy-sandbox',
          machineId: 'legacy-1',
          sandboxCmdId: 'cmd-5',
          output: null,
          skippedReason: 'unsupported_provider:legacy-sandbox',
          error: null,
        },
      ],
    });

    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith({
      provider: 'daytona',
      envFallback: {},
    });
    expect(mockGetCommandOutput).toHaveBeenNthCalledWith(1, {
      commandId: 'cmd-1',
      instanceId: 'sandbox-1',
      signal: expect.any(AbortSignal),
    });
    expect(mockGetCommandOutput).toHaveBeenNthCalledWith(2, {
      commandId: 'cmd-3',
      instanceId: 'sandbox-3',
      signal: expect.any(AbortSignal),
    });
  });

  it('returns 404 when the task is not visible in the org', async () => {
    selectLimitMock.mockResolvedValue([]);

    const response = await createApp(authContext).request(
      'http://localhost/tasks/task-missing/compute_logs',
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Task not found' });
  });
});
