import { renderHook } from '@testing-library/react';

const { createStandardTaskCloudJobMock, mutationOptionsRef } = vi.hoisted(
  () => ({
    createStandardTaskCloudJobMock: vi.fn(),
    mutationOptionsRef: {
      current: null as {
        mutationFn: (variables: unknown) => Promise<unknown>;
      } | null,
    },
  }),
);

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
    cloudJobs: {
      createStandardTask: {
        mutate: createStandardTaskCloudJobMock,
      },
    },
  }),
}));

import { useCreateStandardTaskCloudJob } from './useCreateStandardTaskCloudJob';

describe('useCreateStandardTaskCloudJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createStandardTaskCloudJobMock.mockResolvedValue({
      success: true,
      id: 1,
      taskId: 'task_123',
    });
  });

  it('forwards the launch payload without injecting extra fields', async () => {
    const { result } = renderHook(() => useCreateStandardTaskCloudJob());

    await result.current.mutateAsync({
      payload: {
        repo: 'owner/repo',
      },
    });

    expect(createStandardTaskCloudJobMock).toHaveBeenCalledWith({
      payload: {
        repo: 'owner/repo',
      },
    });
  });
});
