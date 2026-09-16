import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({ data: false, isPending: false }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => state,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    miscSettings: {
      privateSessionsExperiment: {
        queryOptions: () => ({}),
      },
    },
  }),
}));

import { usePrivateSessionsExperiment } from './usePrivateSessionsExperiment';

describe('usePrivateSessionsExperiment', () => {
  it('reads the deployment experiment without exposing a personal setter', () => {
    state.data = true;
    const { result } = renderHook(() => usePrivateSessionsExperiment());

    expect(result.current).toEqual({ enabled: true, isLoading: false });
    expect(result.current).not.toHaveProperty('setEnabled');
  });
});
