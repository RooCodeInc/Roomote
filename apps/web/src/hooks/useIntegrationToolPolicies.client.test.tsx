import { act, renderHook } from '@testing-library/react';

import type {
  IntegrationToolPolicyMetadata,
  IntegrationToolPolicyMode,
} from '@roomote/types';

type PolicyChange = {
  integrationId: string;
  toolNames: string[];
  mode: IntegrationToolPolicyMode;
};

type QueuedPolicyChange = {
  change: PolicyChange;
  previous?: IntegrationToolPolicyMetadata[];
  revisions: Map<string, number>;
};

type SaveMutationOptions = {
  onError: (error: Error, input: QueuedPolicyChange) => Promise<void>;
  onSuccess: (
    result: IntegrationToolPolicyMetadata[],
    input: QueuedPolicyChange,
  ) => void;
};

const { mocks, mutationOptions } = vi.hoisted(() => ({
  mutationOptions: [] as unknown[],
  mocks: {
    cancelQueries: vi.fn(),
    getQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    toastError: vi.fn(),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [], isLoading: false }),
  useMutation: (options: unknown) => {
    mutationOptions.push(options);
    return {
      isPending: false,
      mutate: mocks.mutate,
      mutateAsync: mocks.mutateAsync,
    };
  },
  useQueryClient: () => ({
    cancelQueries: mocks.cancelQueries,
    getQueryData: mocks.getQueryData,
    invalidateQueries: mocks.invalidateQueries,
    setQueryData: mocks.setQueryData,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: mocks.toastError },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    integrationToolPolicies: {
      list: {
        queryKey: () => ['integration-tool-policies'],
        queryOptions: () => ({}),
      },
      listPersonal: {
        queryKey: () => ['personal-integration-tool-policies'],
        queryOptions: () => ({}),
      },
      setMany: { mutationOptions: (options: unknown) => options },
      setManyPersonal: { mutationOptions: (options: unknown) => options },
    },
  }),
}));

import { useIntegrationToolPolicies } from './useIntegrationToolPolicies';

const existingPolicy: IntegrationToolPolicyMetadata = {
  policyId: 'policy-1',
  integrationId: 'resend',
  toolName: 'send_email',
  mode: 'allow',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('useIntegrationToolPolicies', () => {
  let cache: IntegrationToolPolicyMetadata[];

  beforeEach(() => {
    vi.clearAllMocks();
    mutationOptions.length = 0;
    cache = [existingPolicy];
    mocks.getQueryData.mockImplementation(() => cache);
    mocks.setQueryData.mockImplementation(
      (
        _queryKey: unknown,
        updater:
          | IntegrationToolPolicyMetadata[]
          | ((
              current: IntegrationToolPolicyMetadata[],
            ) => IntegrationToolPolicyMetadata[]),
      ) => {
        cache = typeof updater === 'function' ? updater(cache) : updater;
      },
    );
    mocks.invalidateQueries.mockImplementation(async () => {
      cache = [existingPolicy];
    });
  });

  it('updates the cached mode immediately and preserves a newer choice when an older save fails', async () => {
    const { result } = renderHook(() => useIntegrationToolPolicies());

    act(() => result.current.setMode('resend', 'send_email', 'ask'));
    const optimisticUpdater = mocks.setQueryData.mock.calls[0]?.[1] as (
      current: IntegrationToolPolicyMetadata[],
    ) => IntegrationToolPolicyMetadata[];
    const optimistic = optimisticUpdater([existingPolicy]);

    expect(optimistic).toEqual([
      expect.objectContaining({
        integrationId: 'resend',
        toolName: 'send_email',
        mode: 'ask',
      }),
    ]);

    const queuedChange = mocks.mutate.mock.calls[0]?.[0] as QueuedPolicyChange;
    const mutation = mutationOptions[1] as SaveMutationOptions;
    await act(async () => {
      await mutation.onError(new Error('save failed'), queuedChange);
    });
    const rollbackUpdater = mocks.setQueryData.mock.calls[1]?.[1] as (
      current: IntegrationToolPolicyMetadata[],
    ) => IntegrationToolPolicyMetadata[];
    const newerChoice = [{ ...optimistic[0]!, mode: 'reject' as const }];

    expect(rollbackUpdater(newerChoice)).toEqual(newerChoice);
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to update the tool approval policy.',
    );
  });

  it('queues a group change as one bulk mutation', () => {
    const { result } = renderHook(() => useIntegrationToolPolicies());

    act(() =>
      result.current.setModes(
        'resend',
        ['send_email', 'delete_email'],
        'reject',
      ),
    );

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        change: {
          integrationId: 'resend',
          toolNames: ['send_email', 'delete_email'],
          mode: 'reject',
        },
      }),
    );
    const optimisticUpdater = mocks.setQueryData.mock.calls[0]?.[1] as (
      current: IntegrationToolPolicyMetadata[],
    ) => IntegrationToolPolicyMetadata[];
    expect(
      optimisticUpdater([existingPolicy]).map((policy) => [
        policy.toolName,
        policy.mode,
      ]),
    ).toEqual([
      ['send_email', 'reject'],
      ['delete_email', 'reject'],
    ]);
  });

  it('keeps a newer optimistic mode visible until its own save settles', async () => {
    const { result } = renderHook(() => useIntegrationToolPolicies());

    act(() => result.current.setMode('resend', 'send_email', 'ask'));
    act(() => result.current.setMode('resend', 'send_email', 'reject'));

    const queuedChanges = mocks.mutate.mock.calls.map(
      ([input]) => input as QueuedPolicyChange,
    );
    const mutation = mutationOptions[1] as SaveMutationOptions;

    await act(async () => {
      await mutation.onError(new Error('first save failed'), queuedChanges[0]!);
    });

    expect(cache).toEqual([
      expect.objectContaining({ toolName: 'send_email', mode: 'reject' }),
    ]);
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();

    act(() =>
      mutation.onSuccess(
        [{ ...existingPolicy, policyId: 'saved-reject', mode: 'reject' }],
        queuedChanges[1]!,
      ),
    );

    expect(cache).toEqual([
      expect.objectContaining({
        policyId: 'saved-reject',
        toolName: 'send_email',
        mode: 'reject',
      }),
    ]);
  });

  it('refetches server truth after two consecutive queued failures', async () => {
    const { result } = renderHook(() => useIntegrationToolPolicies());

    act(() => result.current.setMode('resend', 'send_email', 'ask'));
    act(() => result.current.setMode('resend', 'send_email', 'reject'));

    const queuedChanges = mocks.mutate.mock.calls.map(
      ([input]) => input as QueuedPolicyChange,
    );
    const mutation = mutationOptions[1] as SaveMutationOptions;

    await act(async () => {
      await mutation.onError(new Error('first save failed'), queuedChanges[0]!);
      await mutation.onError(
        new Error('second save failed'),
        queuedChanges[1]!,
      );
    });

    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(cache).toEqual([existingPolicy]);
  });

  it('reapplies a new selection made while failure refetch is in flight', async () => {
    const { result } = renderHook(() => useIntegrationToolPolicies());
    let releaseRefetch = () => {};
    let signalRefetch!: () => void;
    const refetchStarted = new Promise<void>((resolve) => {
      signalRefetch = resolve;
    });

    mocks.invalidateQueries.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          signalRefetch();
          releaseRefetch = () => {
            cache = [existingPolicy];
            resolve();
          };
        }),
    );

    act(() => result.current.setMode('resend', 'send_email', 'ask'));
    const mutation = mutationOptions[1] as SaveMutationOptions;
    const firstChange = mocks.mutate.mock.calls[0]?.[0] as QueuedPolicyChange;
    const firstFailure = mutation.onError(
      new Error('first save failed'),
      firstChange,
    );

    await refetchStarted;
    act(() => result.current.setMode('resend', 'send_email', 'reject'));
    const secondChange = mocks.mutate.mock.calls[1]?.[0] as QueuedPolicyChange;
    releaseRefetch();

    await act(async () => {
      await firstFailure;
      mutation.onSuccess(
        [{ ...existingPolicy, policyId: 'saved-reject', mode: 'reject' }],
        secondChange,
      );
    });

    expect(cache).toEqual([
      expect.objectContaining({
        policyId: 'saved-reject',
        toolName: 'send_email',
        mode: 'reject',
      }),
    ]);
  });
});
