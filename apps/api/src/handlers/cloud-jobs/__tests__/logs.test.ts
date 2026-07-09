import { Hono } from 'hono';

import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { getCloudJobLogs } from '../logs';

const mockFindFirst = vi.hoisted(() => vi.fn());
const mockCreateComputeProviderClient = vi.hoisted(() => vi.fn());
const mockStreamCommandOutput = vi.hoisted(() => vi.fn());

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args) => ({ type: 'and', args })),
  eq: vi.fn((...args) => ({ type: 'eq', args })),
  cloudJobs: {
    id: 'cloudJobs.id',
  },
  db: {
    query: {
      cloudJobs: {
        findFirst: mockFindFirst,
      },
    },
  },
  resolveComputeProviderEnvValues: vi.fn().mockResolvedValue({}),
}));

vi.mock('@roomote/compute-providers', () => ({
  createComputeProviderClient: mockCreateComputeProviderClient,
}));

function createApp(authContext?: AuthTokenContext | JobTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }
    await next();
  });

  app.get('/api/cloud-jobs/:id/logs', getCloudJobLogs);

  return app;
}

describe('getCloudJobLogs', () => {
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
      'http://localhost/api/cloud-jobs/101/logs',
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Unauthorized request',
    });
  });

  it('rejects cloud job tokens for a different cloud job', async () => {
    const jobTokenContext: JobTokenContext = {
      cloudJobId: 999,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'cj',
      version: 1,
    };

    const response = await createApp(jobTokenContext).request(
      'http://localhost/api/cloud-jobs/101/logs',
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Cloud job token does not match requested cloud job',
    });
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('allows a matching cloud job token to stream logs', async () => {
    const jobTokenContext: JobTokenContext = {
      cloudJobId: 101,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'cj',
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

    const response = await createApp(jobTokenContext).request(
      'http://localhost/api/cloud-jobs/101/logs',
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

  it('streams log events and disconnect from the cloud job command output', async () => {
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
      'http://localhost/api/cloud-jobs/101/logs',
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
      'http://localhost/api/cloud-jobs/101/logs',
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
