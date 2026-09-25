import { renderHook } from '@testing-library/react';

const { queryState, state } = vi.hoisted(() => ({
  queryState: { data: false as boolean | undefined, isPending: false },
  state: {
    queryOptions: vi.fn(),
    nightlyExperimentsEnabled: false,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => {
    state.queryOptions(options);
    return queryState;
  },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    nightlyExperimentsEnabled: state.nightlyExperimentsEnabled,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    nightlyExperiments: {
      integrationToolAutoApprovalsEnabled: {
        queryOptions: (_input: undefined, options: unknown) => ({ options }),
      },
    },
  }),
}));

import { useIntegrationToolAutoApprovalsExperiment } from './useIntegrationToolAutoApprovalsExperiment';

describe('useIntegrationToolAutoApprovalsExperiment', () => {
  beforeEach(() => {
    state.nightlyExperimentsEnabled = false;
    queryState.data = false;
    queryState.isPending = false;
  });

  it('keeps Auto off and skips runtime reads outside nightly deployments', () => {
    queryState.data = true;

    const { result } = renderHook(() =>
      useIntegrationToolAutoApprovalsExperiment(),
    );

    expect(result.current).toEqual({ enabled: false, isLoading: false });
    expect(state.queryOptions).toHaveBeenCalledWith(
      expect.objectContaining({ options: { enabled: false } }),
    );
  });

  it('uses the nightly runtime value for all signed-in viewers on opted-in deployments', () => {
    state.nightlyExperimentsEnabled = true;
    queryState.data = true;

    const { result } = renderHook(() =>
      useIntegrationToolAutoApprovalsExperiment(),
    );

    expect(result.current.enabled).toBe(true);
    expect(state.queryOptions).toHaveBeenCalledWith(
      expect.objectContaining({ options: { enabled: true } }),
    );
  });
});
