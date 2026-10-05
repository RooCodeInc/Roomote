import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  enabled: false,
  isLoading: false,
  requestedId: null as string | null,
}));

vi.mock('./useDeploymentExperiments', () => ({
  useDeploymentExperimentRuntime: (id: string) => {
    state.requestedId = id;
    return { enabled: state.enabled, isLoading: state.isLoading };
  },
}));

import { useIntegrationToolAutoApprovalsExperiment } from './useIntegrationToolAutoApprovalsExperiment';

describe('useIntegrationToolAutoApprovalsExperiment', () => {
  beforeEach(() => {
    state.enabled = false;
    state.isLoading = false;
    state.requestedId = null;
  });

  it('reads Auto through the shared runtime contract', () => {
    const { result } = renderHook(() =>
      useIntegrationToolAutoApprovalsExperiment(),
    );

    expect(result.current).toEqual({ enabled: false, isLoading: false });
    expect(state.requestedId).toBe('integrationToolAutoApprovals');
  });

  it('returns the shared runtime value when enabled', () => {
    state.enabled = true;

    const { result } = renderHook(() =>
      useIntegrationToolAutoApprovalsExperiment(),
    );

    expect(result.current.enabled).toBe(true);
  });
});
