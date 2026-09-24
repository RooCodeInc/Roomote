import { renderHook } from '@testing-library/react';

const { queryState, state } = vi.hoisted(() => ({
  queryState: { data: false as boolean | undefined },
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
      dizzyEnabled: {
        queryOptions: (_input: undefined, options: unknown) => ({ options }),
      },
    },
  }),
}));

import { useDizzyExperiment } from './useDizzyExperiment';

describe('useDizzyExperiment', () => {
  beforeEach(() => {
    state.nightlyExperimentsEnabled = false;
    queryState.data = false;
  });

  it('does not enable the runtime query when the deployment has not opted in', () => {
    queryState.data = true;

    const { result } = renderHook(() => useDizzyExperiment());

    expect(result.current).toBe(false);
    expect(state.queryOptions).toHaveBeenCalledWith(
      expect.objectContaining({ options: { enabled: false } }),
    );
  });

  it('uses the server-gated runtime value on an opted-in deployment', () => {
    state.nightlyExperimentsEnabled = true;
    queryState.data = true;

    const { result } = renderHook(() => useDizzyExperiment());

    expect(result.current).toBe(true);
    expect(state.queryOptions).toHaveBeenCalledWith(
      expect.objectContaining({ options: { enabled: true } }),
    );
  });
});
