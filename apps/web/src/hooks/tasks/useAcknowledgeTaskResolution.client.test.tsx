import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { acknowledgeMock, useTRPCMock } = vi.hoisted(() => ({
  acknowledgeMock: vi.fn(),
  useTRPCMock: vi.fn(),
}));

vi.mock('@/trpc/client', () => ({ useTRPC: useTRPCMock }));

import { useAcknowledgeTaskResolution } from './useAcknowledgeTaskResolution';

describe('useAcknowledgeTaskResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acknowledgeMock.mockResolvedValue({ success: true, changed: true });
    useTRPCMock.mockReturnValue({
      tasks: {
        acknowledgeResolution: {
          mutationOptions: (options: object) => ({
            mutationFn: acknowledgeMock,
            ...options,
          }),
        },
        list: { queryKey: () => ['tasks.list'] },
        byId: {
          queryKey: ({
            taskId,
            includeArtifacts,
          }: {
            taskId: string;
            includeArtifacts?: boolean;
          }) => ['tasks.byId', taskId, includeArtifacts],
        },
      },
      sandboxSession: {
        byTaskId: {
          queryKey: ({ taskId }: { taskId: string }) => [
            'sandboxSession.byTaskId',
            taskId,
          ],
        },
      },
    });
  });

  it('refreshes board and detail queries after acknowledgement', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAcknowledgeTaskResolution(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({ taskId: 'task-1' });
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tasks.list'],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tasks.byId', 'task-1', undefined],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tasks.byId', 'task-1', true],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tasks.byId', 'task-1', false],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['sandboxSession.byTaskId', 'task-1'],
    });
  });
});
