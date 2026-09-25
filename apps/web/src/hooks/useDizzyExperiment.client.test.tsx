import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  enabled: false,
  requestedId: null as string | null,
}));

vi.mock('./useDeploymentExperiments', () => ({
  useDeploymentExperimentRuntime: (id: string) => {
    state.requestedId = id;
    return { enabled: state.enabled, isLoading: false };
  },
}));

import { useDizzyExperiment } from './useDizzyExperiment';

describe('useDizzyExperiment', () => {
  beforeEach(() => {
    state.enabled = false;
    state.requestedId = null;
  });

  it('reads the shared runtime contract for Dizzy', () => {
    const { result } = renderHook(() => useDizzyExperiment());

    expect(result.current).toBe(false);
    expect(state.requestedId).toBe('dizzy');
  });

  it('returns the shared runtime value when enabled', () => {
    state.enabled = true;

    const { result } = renderHook(() => useDizzyExperiment());

    expect(result.current).toBe(true);
  });
});
