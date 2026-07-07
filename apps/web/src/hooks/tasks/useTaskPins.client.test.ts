import { renderHook } from '@testing-library/react';

type PinnedTask = { taskId: string; updatedAt: Date };
type SetPinnedVariables = { taskId: string; pinned: boolean };
type SetPinnedResult =
  | { success: true; pinned: boolean }
  | { success: false; error: 'pin_limit_reached' | 'task_not_found' };
type MutationContext = { previousPinnedTasks: PinnedTask[] };
type MutationOptions = {
  onMutate?: (variables: SetPinnedVariables) => Promise<MutationContext>;
  onSuccess?: (
    result: SetPinnedResult,
    variables: SetPinnedVariables,
    context?: MutationContext,
  ) => void;
  onError?: (
    error: unknown,
    variables: SetPinnedVariables,
    context?: MutationContext,
  ) => void;
  onSettled?: (
    data: SetPinnedResult | undefined,
    error: unknown,
    variables: SetPinnedVariables,
    context?: MutationContext,
  ) => void;
};

const { mutationOptionsRef, queryClientMock, toastErrorMock, pinsQueryKey } =
  vi.hoisted(() => ({
    mutationOptionsRef: { current: null as MutationOptions | null },
    queryClientMock: {
      cancelQueries: vi.fn(),
      getQueryData: vi.fn(),
      setQueryData: vi.fn(),
      invalidateQueries: vi.fn(),
    },
    toastErrorMock: vi.fn(),
    pinsQueryKey: [['tasks', 'pins']],
  }));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => queryClientMock,
  useQuery: () => ({ data: [] }),
  useMutation: (options: MutationOptions) => {
    mutationOptionsRef.current = options;

    return {
      mutate: vi.fn(),
      isPending: false,
      variables: undefined,
    };
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    tasks: {
      pins: {
        queryKey: () => pinsQueryKey,
        queryOptions: () => ({ queryKey: pinsQueryKey }),
      },
      setPinned: {
        mutationOptions: (options: MutationOptions) => options,
      },
    },
  }),
}));

import { useTaskPins } from './useTaskPins';

function getMutationOptions() {
  if (!mutationOptionsRef.current) {
    throw new Error('Expected mutation options to be captured');
  }

  return mutationOptionsRef.current;
}

describe('useTaskPins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClientMock.cancelQueries.mockResolvedValue(undefined);
    queryClientMock.getQueryData.mockReturnValue([]);
  });

  it('revalidates pins after rollback when mutation returns a failure result', async () => {
    const previousPinnedTasks = [
      {
        taskId: 'task-existing',
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    ];
    queryClientMock.getQueryData.mockReturnValue(previousPinnedTasks);

    renderHook(() => useTaskPins());
    const options = getMutationOptions();
    const variables = { taskId: 'task-overflow', pinned: true };

    const context = await options.onMutate?.(variables);

    options.onSuccess?.(
      { success: false, error: 'pin_limit_reached' },
      variables,
      context,
    );
    options.onSettled?.(
      { success: false, error: 'pin_limit_reached' },
      null,
      variables,
      context,
    );

    expect(queryClientMock.setQueryData).toHaveBeenLastCalledWith(
      pinsQueryKey,
      previousPinnedTasks,
    );
    expect(queryClientMock.invalidateQueries).toHaveBeenCalledWith({
      queryKey: pinsQueryKey,
    });
    expect(toastErrorMock).toHaveBeenCalledWith('You can pin up to 5 tasks.');
  });

  it('revalidates pins after rollback when mutation throws', async () => {
    const previousPinnedTasks = [
      {
        taskId: 'task-existing',
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    ];
    queryClientMock.getQueryData.mockReturnValue(previousPinnedTasks);

    renderHook(() => useTaskPins());
    const options = getMutationOptions();
    const variables = { taskId: 'task-1', pinned: false };
    const mutationError = new Error('network');

    const context = await options.onMutate?.(variables);

    options.onError?.(mutationError, variables, context);
    options.onSettled?.(undefined, mutationError, variables, context);

    expect(queryClientMock.setQueryData).toHaveBeenLastCalledWith(
      pinsQueryKey,
      previousPinnedTasks,
    );
    expect(queryClientMock.invalidateQueries).toHaveBeenCalledWith({
      queryKey: pinsQueryKey,
    });
    expect(toastErrorMock).toHaveBeenCalledWith('Failed to update task pin.');
  });
});
