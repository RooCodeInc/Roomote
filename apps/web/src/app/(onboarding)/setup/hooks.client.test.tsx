import { renderHook, waitFor } from '@testing-library/react';

const { queryState, replaceMock, pushMock } = vi.hoisted(() => ({
  queryState: { current: null as Record<string, unknown> | null },
  replaceMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      status: {
        queryOptions: () => ({ queryKey: ['setupNew.status'] }),
      },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: queryState.current,
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

import { useSetupFlow } from './hooks';

function buildStatus() {
  return {
    authSetup: { setupSatisfiedByRuntimeEnv: false },
    modelSetup: {
      setupSatisfied: false,
      setupSatisfiedByRuntimeEnv: false,
      runtimeRoomoteModelSatisfied: false,
      persistedRoomoteModel: null,
      providers: [
        {
          id: 'roomote',
          savedApiKeySatisfied: true,
          runtimeApiKeySatisfied: false,
        },
      ],
    },
    setupNewState: {
      authProvider: null,
      modelProvider: null,
    },
  };
}

describe('useSetupFlow', () => {
  beforeEach(() => {
    queryState.current = buildStatus();
    replaceMock.mockClear();
    pushMock.mockClear();
    window.history.replaceState({}, '', '/setup');
    window.sessionStorage.clear();
  });

  it('starts with the bootstrap welcome when there is no progress', async () => {
    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => expect(result.current.step).toBe('welcome'));
    expect(replaceMock).toHaveBeenCalledWith('/setup?step=welcome');
  });

  it('moves directly to inference after the welcome was already shown', async () => {
    window.sessionStorage.setItem('roomote-setup-welcome-seen', 'true');
    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => expect(result.current.step).toBe('inference'));
  });

  it('keeps repository and sandbox steps out of the bootstrap URL flow', async () => {
    queryState.current = {
      ...buildStatus(),
      setupNewState: {
        authProvider: null,
        modelProvider: 'openrouter',
      },
    };
    window.history.replaceState({}, '', '/setup?step=source-control-config');
    const { result } = renderHook(() => useSetupFlow());

    await waitFor(() => expect(result.current.step).toBe('env-vars'));
    expect(replaceMock).toHaveBeenCalledWith('/setup?step=env-vars');
  });
});
