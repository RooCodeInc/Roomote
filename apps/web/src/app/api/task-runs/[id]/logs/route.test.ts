import { NextRequest } from 'next/server';

const findFirstMock = vi.fn();
const createResponseMock = vi.fn();
const authorizeUserTokenMock = vi.fn();
const createComputeProviderClientMock = vi.fn();
const getComputeProviderCapabilitiesMock = vi.fn();
const streamCommandOutputMock = vi.fn();

let lastSession:
  | {
      isConnected: boolean;
      lastId: string;
      on: (event: string, handler: () => void) => void;
      push: ReturnType<typeof vi.fn>;
      handlers: Map<string, () => void>;
    }
  | undefined;

vi.mock('better-sse', () => ({
  createResponse: (...args: unknown[]) => createResponseMock(...args),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: (...args: unknown[]) => findFirstMock(...args),
      },
    },
  },
  taskRuns: { id: 'id' },
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock('@roomote/compute-providers/factory', () => ({
  createComputeProviderClient: (...args: unknown[]) =>
    createComputeProviderClientMock(...args),
  getComputeProviderCapabilities: (...args: unknown[]) =>
    getComputeProviderCapabilitiesMock(...args),
}));

vi.mock('@/lib/server', () => ({
  authorizeUserToken: (...args: unknown[]) => authorizeUserTokenMock(...args),
}));

describe('GET /api/task-runs/[id]/logs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    lastSession = undefined;

    authorizeUserTokenMock.mockResolvedValue({
      success: true,
    });
    getComputeProviderCapabilitiesMock.mockReturnValue({
      supportsCommandOutputStreaming: false,
      supportsCommandOutputLookup: false,
    });
    createComputeProviderClientMock.mockReturnValue({
      capabilities: {
        supportsCommandOutputStreaming: false,
        supportsCommandOutputLookup: false,
      },
      getCommandOutput: vi.fn(),
      streamCommandOutput: streamCommandOutputMock,
    });
    createResponseMock.mockImplementation(async (request, handler) => {
      const handlers = new Map<string, () => void>();
      lastSession = {
        isConnected: true,
        lastId: request.headers.get('last-event-id') ?? '',
        handlers,
        on: (event: string, cb: () => void) => {
          handlers.set(event, cb);
        },
        push: vi.fn(async (data, event, id) => {
          if (typeof id === 'string') {
            lastSession!.lastId = id;
          }
          if (event === 'disconnect') {
            lastSession!.isConnected = false;
          }
          return { data, event, id };
        }),
      };

      await handler(lastSession);
      return new Response('ok');
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('waits for command output streaming metadata before attaching to sandbox logs', async () => {
    getComputeProviderCapabilitiesMock.mockReturnValue({
      supportsCommandOutputStreaming: true,
      supportsCommandOutputLookup: true,
    });
    createComputeProviderClientMock.mockReturnValue({
      capabilities: {
        supportsCommandOutputStreaming: true,
        supportsCommandOutputLookup: true,
      },
      getCommandOutput: vi.fn(),
      streamCommandOutput: streamCommandOutputMock,
    });
    streamCommandOutputMock.mockImplementation(async function* () {
      yield { stream: 'stdout', data: 'booting\n' };
    });

    let pollCount = 0;
    findFirstMock.mockImplementation(async () => {
      pollCount += 1;

      if (pollCount === 1) {
        return {
          id: 1,
          machineId: null,
          sandboxCmdId: null,
          vendor: 'sandbox',
          status: 'running',
        };
      }

      return {
        machineId: 'sb-123',
        sandboxCmdId: 'cmd-123',
        vendor: 'sandbox',
        status: 'running',
      };
    });

    const { GET } = await import('./route');
    const responsePromise = GET(new NextRequest('https://example.com'), {
      params: Promise.resolve({ id: '1' }),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await responsePromise;

    const logEvents =
      lastSession?.push.mock.calls.filter(([, event]) => event === 'log') ?? [];
    const disconnectEvents =
      lastSession?.push.mock.calls.filter(
        ([, event]) => event === 'disconnect',
      ) ?? [];

    expect(response.status).toBe(200);
    expect(streamCommandOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'sb-123',
        commandId: 'cmd-123',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(logEvents).toHaveLength(1);
    expect(logEvents[0]?.[0]).toEqual({ stream: 'stdout', data: 'booting\n' });
    expect(disconnectEvents).toHaveLength(1);
  });

  it('emits a readable error when live log streaming is unavailable', async () => {
    findFirstMock.mockResolvedValue({
      id: 1,
      machineId: 'modal-123',
      sandboxCmdId: null,
      vendor: 'modal',
      status: 'running',
    });

    const { GET } = await import('./route');
    const response = await GET(new NextRequest('https://example.com'), {
      params: Promise.resolve({ id: '1' }),
    });

    const errorEvents =
      lastSession?.push.mock.calls.filter(([, event]) => event === 'error') ??
      [];
    const disconnectEvents =
      lastSession?.push.mock.calls.filter(
        ([, event]) => event === 'disconnect',
      ) ?? [];

    expect(response.status).toBe(200);
    expect(streamCommandOutputMock).not.toHaveBeenCalled();
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.[0]).toEqual({
      error: 'Live log streaming is unavailable for this sandbox provider.',
    });
    expect(disconnectEvents).toHaveLength(1);
  });

  it('ends readiness polling without a custom disconnect event when the wait max is hit', async () => {
    getComputeProviderCapabilitiesMock.mockReturnValue({
      supportsCommandOutputStreaming: true,
      supportsCommandOutputLookup: true,
    });
    createComputeProviderClientMock.mockReturnValue({
      capabilities: {
        supportsCommandOutputStreaming: true,
        supportsCommandOutputLookup: true,
      },
      getCommandOutput: vi.fn(),
      streamCommandOutput: streamCommandOutputMock,
    });

    let pollCount = 0;
    findFirstMock.mockImplementation(async () => {
      pollCount += 1;

      if (pollCount === 1) {
        return {
          id: 1,
          machineId: null,
          sandboxCmdId: null,
          vendor: 'sandbox',
          status: 'running',
        };
      }

      return {
        machineId: null,
        sandboxCmdId: null,
        vendor: 'sandbox',
        status: 'running',
      };
    });

    const { GET } = await import('./route');
    const responsePromise = GET(new NextRequest('https://example.com'), {
      params: Promise.resolve({ id: '1' }),
    });

    await vi.advanceTimersByTimeAsync(15 * 60_000 + 5_000);
    await responsePromise;

    const disconnectEvents =
      lastSession?.push.mock.calls.filter(
        ([, event]) => event === 'disconnect',
      ) ?? [];

    expect(streamCommandOutputMock).not.toHaveBeenCalled();
    expect(disconnectEvents).toHaveLength(0);
  });

  it('disconnects local direct jobs that exit before hosted log metadata is available', async () => {
    getComputeProviderCapabilitiesMock.mockReturnValue({
      supportsCommandOutputStreaming: true,
      supportsCommandOutputLookup: true,
    });

    findFirstMock.mockResolvedValue({
      id: 1,
      machineId: null,
      sandboxCmdId: null,
      vendor: 'sandbox',
      status: 'completed',
    });

    const { GET } = await import('./route');
    const response = await GET(new NextRequest('https://example.com'), {
      params: Promise.resolve({ id: '1' }),
    });

    const disconnectEvents =
      lastSession?.push.mock.calls.filter(
        ([, event]) => event === 'disconnect',
      ) ?? [];

    expect(response.status).toBe(200);
    expect(createComputeProviderClientMock).not.toHaveBeenCalled();
    expect(streamCommandOutputMock).not.toHaveBeenCalled();
    expect(disconnectEvents).toHaveLength(1);
  });
});
