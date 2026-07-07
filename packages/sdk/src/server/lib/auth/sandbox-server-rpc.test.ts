const { mockCreateJobToken, mockCreateTRPCProxyClient, mockHttpBatchLink } =
  vi.hoisted(() => ({
    mockCreateJobToken: vi.fn(),
    mockCreateTRPCProxyClient: vi.fn(),
    mockHttpBatchLink: vi.fn((options) => options),
  }));

vi.mock('@roomote/auth', () => ({
  createJobToken: mockCreateJobToken,
}));

vi.mock('@trpc/client', () => ({
  createTRPCProxyClient: mockCreateTRPCProxyClient,
  httpBatchLink: mockHttpBatchLink,
}));

import {
  SANDBOX_SERVER_JOB_TOKEN_TIMEOUT_MS,
  SANDBOX_SERVER_RPC_TIMEOUT_MS,
  withSandboxServerRpcClient,
} from './sandbox-server-rpc';

describe('withSandboxServerRpcClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockCreateJobToken.mockResolvedValue('job-token');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds the sandbox client with job-token auth', async () => {
    const query = vi.fn().mockResolvedValue({ currentWorkflowPhase: 'review' });

    mockCreateTRPCProxyClient.mockReturnValue({
      commands: {
        getRuntimeState: {
          query,
        },
      },
    });

    const result = await withSandboxServerRpcClient({
      cloudJobId: 42,
      userId: 'user-1',
      sandboxServerUrl: 'https://sandbox.example.com',
      call: async (client) => {
        const state = await client.commands.getRuntimeState.query();
        return { currentWorkflowPhase: state.currentWorkflowPhase };
      },
    });

    expect(result).toEqual({ currentWorkflowPhase: 'review' });
    expect(mockCreateJobToken).toHaveBeenCalledWith({
      cloudJobId: 42,
      userId: 'user-1',
      timeoutMs: SANDBOX_SERVER_JOB_TOKEN_TIMEOUT_MS,
    });
    expect(mockHttpBatchLink).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://sandbox.example.com/trpc',
      }),
    );
    expect(mockHttpBatchLink.mock.calls[0]?.[0].headers()).toEqual({
      Authorization: 'Bearer job-token',
    });
  });

  it('passes the abort signal through the shared timeout wrapper', async () => {
    vi.useFakeTimers();

    let linkOptions:
      | {
          fetch: (
            input: RequestInfo | URL,
            init?: RequestInit,
          ) => Promise<unknown>;
        }
      | undefined;

    mockHttpBatchLink.mockImplementation((options) => {
      linkOptions = options;
      return options;
    });

    mockCreateTRPCProxyClient.mockReturnValue({
      commands: {
        cancelTask: {
          mutate: () =>
            linkOptions?.fetch('https://sandbox.example.com/trpc', {
              method: 'POST',
            }),
        },
      },
    });

    const abortError = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    const sandboxFetch = vi.fn(
      (
        _input: RequestInfo | URL,
        _init: RequestInit | undefined,
        signal: AbortSignal,
      ) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(abortError), {
            once: true,
          });
        }),
    );

    const promise = withSandboxServerRpcClient({
      cloudJobId: 42,
      userId: 'user-1',
      sandboxServerUrl: 'https://sandbox.example.com',
      fetch: sandboxFetch,
      call: (client) => client.commands.cancelTask.mutate(),
    });
    const rejection = expect(promise).rejects.toMatchObject({
      name: 'AbortError',
    });

    await vi.advanceTimersByTimeAsync(SANDBOX_SERVER_RPC_TIMEOUT_MS);

    await rejection;
    expect(sandboxFetch).toHaveBeenCalled();
    expect(sandboxFetch.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect((sandboxFetch.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(true);
  });
});
