import { renderHook } from '@testing-library/react';

const useDeploymentExperimentMock = vi.hoisted(() => vi.fn());

vi.mock('./useDeploymentExperiments', () => ({
  useDeploymentExperiment: useDeploymentExperimentMock,
}));

import { usePrivateSessionsExperiment } from './usePrivateSessionsExperiment';

describe('usePrivateSessionsExperiment', () => {
  it('uses the shared deployment experiment hook', () => {
    const state = {
      enabled: true,
      isLoading: false,
      isUpdating: false,
      setEnabled: vi.fn(),
    };
    useDeploymentExperimentMock.mockReturnValue(state);

    const { result } = renderHook(() => usePrivateSessionsExperiment());

    expect(result.current).toBe(state);
    expect(useDeploymentExperimentMock).toHaveBeenCalledWith(
      'privateSessions',
      'Failed to update Private Sessions.',
    );
  });
});
