import { fireEvent, render, screen } from '@testing-library/react';

const { setEnabledMock, state } = vi.hoisted(() => ({
  setEnabledMock: vi.fn(),
  state: {
    enabled: false,
    isLoading: false,
    isUpdating: false,
  },
}));

vi.mock('@/hooks/usePrivateSessionsExperiment', () => ({
  usePrivateSessionsExperiment: () => ({
    ...state,
    setEnabled: setEnabledMock,
  }),
}));

import { PrivateSessionsExperimentalSetting } from './PrivateSessionsExperimentalSetting';

describe('PrivateSessionsExperimentalSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.enabled = false;
    state.isLoading = false;
    state.isUpdating = false;
  });

  it('renders the shared deployment value without default-status copy', () => {
    state.enabled = true;
    render(<PrivateSessionsExperimentalSetting />);

    const toggle = screen.getByRole('switch', {
      name: 'Toggle Private Sessions',
    });
    expect(toggle).toBeChecked();
    expect(screen.queryByText(/disabled by default/i)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(setEnabledMock).toHaveBeenCalledWith(false);
  });

  it('disables the toggle while deployment settings load or update', () => {
    state.isLoading = true;
    render(<PrivateSessionsExperimentalSetting />);

    expect(
      screen.getByRole('switch', { name: 'Toggle Private Sessions' }),
    ).toBeDisabled();
  });
});
