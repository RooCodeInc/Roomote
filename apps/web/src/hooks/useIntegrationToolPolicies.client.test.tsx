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
  onError: (error: Error, input: QueuedPolicyChange) => void;
};

const { mocks, mutationOptions } = vi.hoisted(() => ({
  mutationOptions: [] as unknown[],
  mocks: {
    cancelQueries: vi.fn(),
    getQueryData: vi.fn(),
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
  beforeEach(() => {
    vi.clearAllMocks();
    mutationOptions.length = 0;
    mocks.getQueryData.mockReturnValue([existingPolicy]);
  });

  it('updates the cached mode immediately and preserves a newer choice when an older save fails', () => {
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
    mutation.onError(new Error('save failed'), queuedChange);
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
});
