import { fireEvent, render, screen } from '@testing-library/react';

const { setEnabledMock, state } = vi.hoisted(() => ({
  setEnabledMock: vi.fn(),
  state: {
    enabled: false,
    isLoading: false,
    isUpdating: false,
  },
}));

vi.mock('@/hooks/useSessionSecretTools', () => ({
  useSessionSecretTools: () => ({
    ...state,
    setEnabled: setEnabledMock,
  }),
}));

import { SessionSecretToolsExperimentalSetting } from './SessionSecretToolsExperimentalSetting';

describe('SessionSecretToolsExperimentalSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.enabled = false;
    state.isLoading = false;
    state.isUpdating = false;
  });

  it('is off by default and enables Session secret tools', () => {
    render(<SessionSecretToolsExperimentalSetting />);
    const toggle = screen.getByRole('switch', {
      name: 'Toggle Session secret tools',
    });

    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(setEnabledMock).toHaveBeenCalledWith(true);
  });

  it('disables the toggle while preferences load or update', () => {
    state.isUpdating = true;

    render(<SessionSecretToolsExperimentalSetting />);

    expect(
      screen.getByRole('switch', { name: 'Toggle Session secret tools' }),
    ).toBeDisabled();
  });
});
