import { renderHook } from '@testing-library/react';

type PersonalPreferences = {
  colorTheme: 'light' | 'dark' | 'system';
  mindReaderMode: boolean;
  narrationMode: boolean;
};

type MutationContext = {
  previousPreferences: PersonalPreferences;
  optimisticPreferences: PersonalPreferences;
};

type PersonalPreferencesUpdate = Partial<PersonalPreferences>;

type MutationOptions = {
  onMutate?: (variables: PersonalPreferencesUpdate) => Promise<MutationContext>;
  onSuccess?: (
    result: PersonalPreferences,
    variables: PersonalPreferencesUpdate,
    context?: MutationContext,
  ) => void;
  onError?: (
    error: unknown,
    variables: PersonalPreferencesUpdate,
    context?: MutationContext,
  ) => void;
  onSettled?: (
    data: PersonalPreferences | undefined,
    error: unknown,
    variables: PersonalPreferencesUpdate,
    context?: MutationContext,
  ) => void;
};

const {
  mutateMock,
  mutationOptionsRef,
  preferencesQueryKey,
  queryClientMock,
  queryState,
  toastErrorMock,
} = vi.hoisted(() => ({
  mutateMock: vi.fn(),
  mutationOptionsRef: { current: null as MutationOptions | null },
  preferencesQueryKey: [['preferences', 'getPersonal']],
  queryClientMock: {
    cancelQueries: vi.fn(),
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  },
  queryState: {
    data: {
      colorTheme: 'system',
      mindReaderMode: false,
      narrationMode: false,
    } as PersonalPreferences | undefined,
    isPending: false,
  },
  toastErrorMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => queryClientMock,
  useQuery: () => queryState,
  useMutation: (options: MutationOptions) => {
    mutationOptionsRef.current = options;

    return {
      mutate: mutateMock,
      isPending: false,
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
    preferences: {
      getPersonal: {
        queryKey: () => preferencesQueryKey,
        queryOptions: (_input: unknown, options?: { enabled?: boolean }) => ({
          queryKey: preferencesQueryKey,
          enabled: options?.enabled,
        }),
      },
      updatePersonal: {
        mutationOptions: (options: MutationOptions) => options,
      },
    },
  }),
}));

import { usePersonalPreferences } from './usePersonalPreferences';

function getMutationOptions() {
  if (!mutationOptionsRef.current) {
    throw new Error('Expected mutation options to be captured');
  }

  return mutationOptionsRef.current;
}

describe('usePersonalPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.data = {
      colorTheme: 'system',
      mindReaderMode: false,
      narrationMode: false,
    };
    queryState.isPending = false;
    queryClientMock.cancelQueries.mockResolvedValue(undefined);
    queryClientMock.getQueryData.mockReturnValue({
      colorTheme: 'system',
      mindReaderMode: false,
      narrationMode: false,
    });
  });

  it('exposes the current personal preferences from the query', () => {
    queryState.data = {
      colorTheme: 'dark',
      mindReaderMode: true,
      narrationMode: true,
    };

    const { result } = renderHook(() => usePersonalPreferences());

    expect(result.current.preferences).toEqual({
      colorTheme: 'dark',
      mindReaderMode: true,
      narrationMode: true,
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('falls back to default personal preferences when the query has no saved value', () => {
    queryState.data = undefined;

    const { result } = renderHook(() => usePersonalPreferences());

    expect(result.current.preferences).toEqual({
      colorTheme: 'system',
      mindReaderMode: false,
      narrationMode: false,
    });
  });

  it('mutates only the changed preferences fields', () => {
    const { result } = renderHook(() => usePersonalPreferences());

    result.current.setPreferences({ colorTheme: 'dark' });

    expect(mutateMock).toHaveBeenCalledWith({ colorTheme: 'dark' });
  });

  it('optimistically updates and revalidates the preferences cache', async () => {
    renderHook(() => usePersonalPreferences());
    const options = getMutationOptions();
    const variables = {
      colorTheme: 'dark',
    } as const satisfies PersonalPreferencesUpdate;

    const context = await options.onMutate?.(variables);

    expect(queryClientMock.cancelQueries).toHaveBeenCalledWith({
      queryKey: preferencesQueryKey,
    });
    expect(queryClientMock.setQueryData).toHaveBeenCalledWith(
      preferencesQueryKey,
      {
        colorTheme: 'dark',
        mindReaderMode: false,
        narrationMode: false,
      },
    );

    options.onSuccess?.(
      {
        colorTheme: 'dark',
        mindReaderMode: false,
        narrationMode: false,
      },
      variables,
      context,
    );
    options.onSettled?.(
      {
        colorTheme: 'dark',
        mindReaderMode: false,
        narrationMode: false,
      },
      null,
      variables,
      context,
    );

    const updateCall = queryClientMock.setQueryData.mock.calls.at(-1);

    expect(updateCall?.[0]).toEqual(preferencesQueryKey);
    expect(updateCall?.[1]).toEqual(expect.any(Function));
    expect(
      updateCall?.[1]({
        colorTheme: 'dark',
        mindReaderMode: true,
        narrationMode: true,
      }),
    ).toEqual({
      colorTheme: 'dark',
      mindReaderMode: true,
      narrationMode: true,
    });
    expect(queryClientMock.invalidateQueries).toHaveBeenCalledWith({
      queryKey: preferencesQueryKey,
    });
  });

  it('rolls back the optimistic cache update and shows an error when the mutation fails', async () => {
    queryClientMock.getQueryData.mockReturnValue({
      colorTheme: 'light',
      mindReaderMode: true,
      narrationMode: true,
    });

    renderHook(() =>
      usePersonalPreferences({
        errorMessage: 'Failed to update preferences.',
      }),
    );
    const options = getMutationOptions();
    const variables = {
      colorTheme: 'system',
    } as const satisfies PersonalPreferencesUpdate;
    const mutationError = new Error('network');

    const context = await options.onMutate?.(variables);

    options.onError?.(mutationError, variables, context);
    options.onSettled?.(undefined, mutationError, variables, context);

    const rollbackCall = queryClientMock.setQueryData.mock.calls.at(-1);

    expect(rollbackCall?.[0]).toEqual(preferencesQueryKey);
    expect(rollbackCall?.[1]).toEqual(expect.any(Function));
    expect(
      rollbackCall?.[1]({
        colorTheme: 'system',
        mindReaderMode: false,
        narrationMode: false,
      }),
    ).toEqual({
      colorTheme: 'light',
      mindReaderMode: false,
      narrationMode: false,
    });
    expect(queryClientMock.invalidateQueries).toHaveBeenCalledWith({
      queryKey: preferencesQueryKey,
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Failed to update preferences.',
    );
  });

  it('preserves newer optimistic changes when an earlier mutation succeeds later', async () => {
    renderHook(() => usePersonalPreferences());
    const options = getMutationOptions();
    const firstUpdate = {
      colorTheme: 'dark',
    } as const satisfies PersonalPreferencesUpdate;
    const secondUpdate = {
      narrationMode: true,
    } as const satisfies PersonalPreferencesUpdate;

    await options.onMutate?.(firstUpdate);
    await options.onMutate?.(secondUpdate);

    options.onSuccess?.(
      {
        colorTheme: 'dark',
        mindReaderMode: false,
        narrationMode: false,
      },
      firstUpdate,
    );

    const successCall = queryClientMock.setQueryData.mock.calls.at(-1);

    expect(successCall?.[0]).toEqual(preferencesQueryKey);
    expect(successCall?.[1]).toEqual(expect.any(Function));
    expect(
      successCall?.[1]({
        colorTheme: 'dark',
        mindReaderMode: true,
        narrationMode: true,
      }),
    ).toEqual({
      colorTheme: 'dark',
      mindReaderMode: true,
      narrationMode: true,
    });
  });

  it('rolls back only the failed field when another optimistic update is still present', async () => {
    renderHook(() => usePersonalPreferences());
    const options = getMutationOptions();
    const firstUpdate = {
      colorTheme: 'dark',
    } as const satisfies PersonalPreferencesUpdate;
    const secondUpdate = {
      narrationMode: true,
    } as const satisfies PersonalPreferencesUpdate;

    const firstContext = await options.onMutate?.(firstUpdate);
    await options.onMutate?.(secondUpdate);

    options.onError?.(new Error('network'), firstUpdate, firstContext);

    const rollbackCall = queryClientMock.setQueryData.mock.calls.at(-1);

    expect(rollbackCall?.[0]).toEqual(preferencesQueryKey);
    expect(rollbackCall?.[1]).toEqual(expect.any(Function));
    expect(
      rollbackCall?.[1]({
        colorTheme: 'dark',
        mindReaderMode: true,
        narrationMode: true,
      }),
    ).toEqual({
      colorTheme: 'system',
      mindReaderMode: true,
      narrationMode: true,
    });
  });
});
