import { renderHook } from '@testing-library/react';

const { createStandardTaskRunMock, mutationOptionsRef } = vi.hoisted(() => ({
  createStandardTaskRunMock: vi.fn(),
  mutationOptionsRef: {
    current: null as {
      mutationFn: (variables: unknown) => Promise<unknown>;
    } | null,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: {
    mutationFn: (variables: unknown) => Promise<unknown>;
  }) => {
    mutationOptionsRef.current = options;

    return {
      mutateAsync: (variables: unknown) => options.mutationFn(variables),
      mutate: (variables: unknown) => void options.mutationFn(variables),
      isPending: false,
    };
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({
    taskRuns: {
      createStandardTask: {
        mutate: createStandardTaskRunMock,
      },
    },
  }),
}));

import { useCreateStandardTaskRun } from './useCreateStandardTaskRun';

describe('useCreateStandardTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createStandardTaskRunMock.mockResolvedValue({
      success: true,
      id: 1,
      taskId: 'task_123',
    });
  });

  it('forwards the launch payload without injecting extra fields', async () => {
    const { result } = renderHook(() => useCreateStandardTaskRun());

    await result.current.mutateAsync({
      payload: {
        repo: 'owner/repo',
      },
    });

    expect(createStandardTaskRunMock).toHaveBeenCalledWith({
      payload: {
        repo: 'owner/repo',
      },
    });
  });
});
