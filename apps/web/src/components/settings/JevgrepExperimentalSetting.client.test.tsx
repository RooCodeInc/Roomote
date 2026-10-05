import { fireEvent, render, screen } from '@testing-library/react';

const { setEnabledMock, state } = vi.hoisted(() => ({
  setEnabledMock: vi.fn(),
  state: {
    enabled: false,
    isLoading: false,
    isUpdating: false,
  },
}));

vi.mock('@/hooks/useDeploymentExperiments', () => ({
  useDeploymentExperiment: () => ({
    ...state,
    setEnabled: setEnabledMock,
  }),
}));

import { JevgrepExperimentalSetting } from './JevgrepExperimentalSetting';

describe('JevgrepExperimentalSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.enabled = false;
    state.isLoading = false;
    state.isUpdating = false;
  });

  it('saves changes through the shared experimental setting', () => {
    state.enabled = true;
    render(<JevgrepExperimentalSetting />);

    const toggle = screen.getByRole('switch', {
      name: 'Toggle Jevgrep code search',
    });
    expect(toggle).toBeChecked();
    expect(screen.queryByText(/disabled by default/i)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(setEnabledMock).toHaveBeenCalledWith(false);
  });

  it('disables the toggle while deployment settings load or update', () => {
    state.isLoading = true;
    render(<JevgrepExperimentalSetting />);

    expect(
      screen.getByRole('switch', { name: 'Toggle Jevgrep code search' }),
    ).toBeDisabled();
  });
});
