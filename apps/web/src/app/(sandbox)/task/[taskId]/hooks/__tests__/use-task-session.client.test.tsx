import { act, renderHook } from '@testing-library/react';

const {
  fetchQueryMock,
  sessionQueryOptionsMock,
  sessionRefetchMock,
  tokenQueryOptionsMock,
  useQueryClientMock,
  useQueryMock,
  useTRPCMock,
} = vi.hoisted(() => ({
  fetchQueryMock: vi.fn(),
  sessionQueryOptionsMock: vi.fn(),
  sessionRefetchMock: vi.fn(),
  tokenQueryOptionsMock: vi.fn(),
  useQueryClientMock: vi.fn(),
  useQueryMock: vi.fn(),
  useTRPCMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: useQueryMock,
  useQueryClient: useQueryClientMock,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: useTRPCMock,
}));

import { useTaskSession } from '../use-task-session';

describe('useTaskSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    let queryCallCount = 0;

    useQueryClientMock.mockReturnValue({
      fetchQuery: fetchQueryMock,
    });

    sessionQueryOptionsMock.mockImplementation((input, options) => ({
      queryKey: ['sandboxSession.byTaskId', input],
      ...options,
    }));
    tokenQueryOptionsMock.mockImplementation((input, options) => ({
      queryKey: ['auth.sandboxToken', input],
      ...options,
    }));

    useTRPCMock.mockReturnValue({
      sandboxSession: {
        byTaskId: {
          queryOptions: sessionQueryOptionsMock,
        },
      },
      auth: {
        sandboxToken: {
          queryOptions: tokenQueryOptionsMock,
        },
      },
    });

    useQueryMock.mockImplementation(() => {
      queryCallCount += 1;

      if (queryCallCount === 1) {
        return {
          data: {
            sessionState: 'interactive',
            taskRun: {
              id: 'job-old',
              harness: 'opencode-server',
              payload: {},
              draftPrompt: null,
            },
            task: null,
            artifacts: [],
            prompt: null,
          },
          isLoading: false,
          refetch: sessionRefetchMock,
        };
      }

      return {
        data: 'token-old',
        isLoading: false,
      };
    });
  });

  it('refreshes the session before fetching a token for the latest task run id', async () => {
    fetchQueryMock.mockResolvedValue('token-new');
    sessionRefetchMock.mockResolvedValue({
      data: {
        sessionState: 'interactive',
        taskRun: {
          id: 'job-new',
          sandboxServerUrl: 'http://sandbox-new.test',
        },
      },
    });

    const { result } = renderHook(() => useTaskSession('task-1'));

    let refreshedConnection;

    await act(async () => {
      refreshedConnection = await result.current.refreshConnection();
    });

    expect(sessionRefetchMock).toHaveBeenCalledTimes(1);
    expect(fetchQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['auth.sandboxToken', { runId: 'job-new' }],
        staleTime: 0,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
      }),
    );
    expect(refreshedConnection).toEqual({
      url: 'http://sandbox-new.test',
      token: 'token-new',
    });
  });

  it('splits session loading from token loading for interactive tasks', () => {
    useQueryMock.mockReset();
    useQueryMock
      .mockImplementationOnce(() => ({
        data: {
          sessionState: 'interactive',
          taskRun: {
            id: 'job-pending-token',
            harness: 'opencode-server',
            payload: {},
            draftPrompt: null,
          },
          task: null,
          artifacts: [],
          prompt: null,
        },
        isLoading: false,
        refetch: sessionRefetchMock,
      }))
      .mockImplementationOnce(() => ({
        data: undefined,
        isLoading: true,
        isError: false,
      }));

    const { result } = renderHook(() => useTaskSession('task-1'));

    expect(result.current.isSessionLoading).toBe(false);
    expect(result.current.isTokenLoading).toBe(true);
    expect(result.current.hasTransportError).toBe(false);
    expect(result.current.transportErrorCategory).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it('does not fetch a sandbox token when the refreshed session is no longer interactive', async () => {
    sessionRefetchMock.mockResolvedValue({
      data: {
        sessionState: 'historical',
        taskRun: {
          id: 'job-new',
          sandboxServerUrl: 'http://sandbox-new.test',
        },
      },
    });

    const { result } = renderHook(() => useTaskSession('task-1'));

    let refreshedConnection;

    await act(async () => {
      refreshedConnection = await result.current.refreshConnection();
    });

    expect(sessionRefetchMock).toHaveBeenCalledTimes(1);
    expect(fetchQueryMock).not.toHaveBeenCalled();
    expect(refreshedConnection).toBeNull();
  });

  it('marks transport setup as errored when the token query fails', () => {
    useQueryMock.mockReset();
    useQueryMock
      .mockImplementationOnce(() => ({
        data: {
          sessionState: 'interactive',
          taskRun: {
            id: 'run-token-error',
            harness: 'opencode-server',
            payload: {},
            draftPrompt: null,
          },
          task: null,
          artifacts: [],
          prompt: null,
        },
        isLoading: false,
        refetch: sessionRefetchMock,
      }))
      .mockImplementationOnce(() => ({
        data: undefined,
        isLoading: false,
        isError: true,
        error: new Error('401 unauthorized'),
      }));

    const { result } = renderHook(() => useTaskSession('task-1'));

    expect(result.current.isSessionLoading).toBe(false);
    expect(result.current.isTokenLoading).toBe(false);
    expect(result.current.hasTransportError).toBe(true);
    expect(result.current.transportErrorCategory).toBe('auth_error');
  });

  it('keeps refreshConnection stable across rerenders', () => {
    useQueryMock.mockReset();

    const sessionRefetch = vi.fn().mockResolvedValue({
      data: {
        sessionState: 'interactive',
        taskRun: { id: 'job-stable' },
      },
    });

    let queryCallCount = 0;
    useQueryMock.mockImplementation(() => {
      queryCallCount += 1;

      if (queryCallCount % 2 === 1) {
        return {
          data: {
            sessionState: 'interactive',
            taskRun: {
              id: 'job-stable',
              harness: 'opencode-server',
              payload: {},
              draftPrompt: null,
            },
            task: null,
            artifacts: [],
            prompt: null,
          },
          isLoading: false,
          refetch: sessionRefetch,
        };
      }

      return {
        data: 'token-stable',
        isLoading: false,
        isError: false,
      };
    });

    const { result, rerender } = renderHook(() => useTaskSession('task-1'));
    const initialRefreshConnection = result.current.refreshConnection;

    rerender();

    expect(result.current.refreshConnection).toBe(initialRefreshConnection);
  });
});
