import { Hono } from 'hono';

import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { getTaskRunLogs } from '../logs';

const mockFindFirst = vi.hoisted(() => vi.fn());
const mockCreateComputeProviderClient = vi.hoisted(() => vi.fn());
const mockStreamCommandOutput = vi.hoisted(() => vi.fn());

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args) => ({ type: 'and', args })),
  eq: vi.fn((...args) => ({ type: 'eq', args })),
  taskRuns: {
    id: 'taskRuns.id',
  },
  db: {
    query: {
      taskRuns: {
        findFirst: mockFindFirst,
      },
    },
  },
  resolveComputeProviderEnvValues: vi.fn().mockResolvedValue({}),
}));

vi.mock('@roomote/compute-providers', () => ({
  createComputeProviderClient: mockCreateComputeProviderClient,
}));

function createApp(authContext?: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }
    await next();
  });

  app.get('/api/task-runs/:id/logs', getTaskRunLogs);

  return app;
}

describe('getTaskRunLogs', () => {
  const authContext: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateComputeProviderClient.mockReturnValue({
      capabilities: {
        supportsCommandOutputStreaming: true,
        supportsCommandOutputLookup: true,
      },
      getCommandOutput: vi.fn(),
      streamCommandOutput: mockStreamCommandOutput,
    });
  });

  it('returns 401 when auth context is missing', async () => {
    const response = await createApp().request(
      'http://localhost/api/task-runs/101/logs',
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Unauthorized request',
    });
  });

  it('rejects task run tokens for a different task run', async () => {
    const runTokenContext: RunTokenContext = {
      runId: 999,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    };

    const response = await createApp(runTokenContext).request(
      'http://localhost/api/task-runs/101/logs',
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Task run token does not match requested task run',
    });
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('allows a matching task run token to stream logs', async () => {
    const runTokenContext: RunTokenContext = {
      runId: 101,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    };

    mockFindFirst.mockResolvedValueOnce({
      id: 101,
      status: 'running',
      vendor: 'modal',
      machineId: 'machine-1',
      sandboxCmdId: 'cmd-1',
    });
    mockStreamCommandOutput.mockImplementation(async function* () {
      yield { stream: 'stdout', data: 'Installing tools' };
    });

    const response = await createApp(runTokenContext).request(
      'http://localhost/api/task-runs/101/logs',
      {
        headers: {
          accept: 'text/event-stream',
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const body = await response.text();
    expect(body).toContain('event: log');
    expect(body).toContain('"data":"Installing tools"');
    expect(mockFindFirst).toHaveBeenCalled();
    expect(mockStreamCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'machine-1',
        commandId: 'cmd-1',
      }),
    );
  });

  it('streams log events and disconnect from the task run command output', async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 101,
      status: 'running',
      vendor: 'modal',
      machineId: 'machine-1',
      sandboxCmdId: 'cmd-1',
    });
    mockStreamCommandOutput.mockImplementation(async function* () {
      yield { stream: 'stdout', data: 'Installing tools' };
      yield { stream: 'stderr', data: 'A warning' };
    });

    const response = await createApp(authContext).request(
      'http://localhost/api/task-runs/101/logs',
      {
        headers: {
          accept: 'text/event-stream',
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const body = await response.text();
    expect(body).toContain('event: log');
    expect(body).toContain('"stream":"stdout"');
    expect(body).toContain('"data":"Installing tools"');
    expect(body).toContain('"stream":"stderr"');
    expect(body).toContain('"data":"A warning"');
    expect(body).toContain('event: disconnect');
    expect(mockStreamCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'machine-1',
        commandId: 'cmd-1',
      }),
    );
  });

  it('emits a single structured error event when startup log polling fails', async () => {
    mockFindFirst
      .mockResolvedValueOnce({
        id: 101,
        status: 'running',
        vendor: 'modal',
        machineId: null,
        sandboxCmdId: null,
      })
      .mockRejectedValueOnce(new Error('poll failed'));

    const response = await createApp(authContext).request(
      'http://localhost/api/task-runs/101/logs',
      {
        headers: {
          accept: 'text/event-stream',
        },
      },
    );

    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('event: error');
    expect(body).toContain('"error":"poll failed"');
    expect(body).toContain('event: disconnect');
    expect(body.match(/event: error/g)).toHaveLength(1);
  });
});
