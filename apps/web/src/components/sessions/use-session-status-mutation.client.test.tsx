import { act, renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  invalidateQueries: vi.fn(),
  error: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock('sonner', () => ({
  toast: { error: mocks.error, success: vi.fn() },
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sessions: {
      setStatus: {
        mutationOptions: (options: object) => options,
      },
      byId: { queryKey: (input: unknown) => ['sessions', 'byId', input] },
      list: { queryKey: () => ['sessions', 'list'] },
      search: { queryKey: () => ['sessions', 'search'] },
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { onError?: (error: Error) => void }) => ({
    isPending: false,
    mutate: () => options.onError?.(new Error('Status update failed')),
  }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

import { useSessionStatusMutation } from './use-session-status-mutation';

describe('useSessionStatusMutation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the server state authoritative when the mutation fails', () => {
    const { result } = renderHook(() => useSessionStatusMutation());

    act(() => {
      result.current.mutate({ sessionId: 'session-1', status: 'done' });
    });

    expect(mocks.error).toHaveBeenCalledWith('Status update failed');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
  });
});
