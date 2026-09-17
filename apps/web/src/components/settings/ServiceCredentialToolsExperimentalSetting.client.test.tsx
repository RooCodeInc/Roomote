import { fireEvent, render, screen } from '@testing-library/react';

const { setEnabledMock, state } = vi.hoisted(() => ({
  setEnabledMock: vi.fn(),
  state: {
    enabled: false,
    isLoading: false,
    isUpdating: false,
  },
}));

vi.mock('@/hooks/useServiceCredentialTools', () => ({
  useServiceCredentialTools: () => ({
    ...state,
    setEnabled: setEnabledMock,
  }),
}));

import { ServiceCredentialToolsExperimentalSetting } from './ServiceCredentialToolsExperimentalSetting';

describe('ServiceCredentialToolsExperimentalSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.enabled = false;
    state.isLoading = false;
    state.isUpdating = false;
  });

  it('is off by default and enables integration keys', () => {
    render(<ServiceCredentialToolsExperimentalSetting />);
    const toggle = screen.getByRole('switch', {
      name: 'Toggle integration keys',
    });

    expect(
      screen.getByText(
        'Let agents request and use integration keys approved in a Session.',
      ),
    ).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(setEnabledMock).toHaveBeenCalledWith(true);
  });

  it('disables the toggle while preferences load or update', () => {
    state.isUpdating = true;

    render(<ServiceCredentialToolsExperimentalSetting />);

    expect(
      screen.getByRole('switch', { name: 'Toggle integration keys' }),
    ).toBeDisabled();
  });
});
