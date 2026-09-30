import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  enabled: false,
  isLoading: false,
  isUpdating: false,
  setEnabled: vi.fn(),
}));

vi.mock('@/hooks/useAutomationLaunchCriteriaExperiment', () => ({
  useAutomationLaunchCriteriaExperiment: () => state,
}));

import { AutomationLaunchCriteriaExperimentalSetting } from './AutomationLaunchCriteriaExperimentalSetting';

describe('AutomationLaunchCriteriaExperimentalSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.enabled = false;
    state.isLoading = false;
    state.isUpdating = false;
  });

  it('shows the default-off setting and persists an explicit opt-in', () => {
    render(<AutomationLaunchCriteriaExperimentalSetting />);

    const toggle = screen.getByRole('switch', {
      name: 'Toggle custom automation launch criteria',
    });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(state.setEnabled).toHaveBeenCalledWith(true);
  });

  it('disables the setting while it is loading or saving', () => {
    state.isUpdating = true;
    const { rerender } = render(
      <AutomationLaunchCriteriaExperimentalSetting />,
    );

    expect(
      screen.getByRole('switch', {
        name: 'Toggle custom automation launch criteria',
      }),
    ).toBeDisabled();

    state.isUpdating = false;
    state.isLoading = true;
    rerender(<AutomationLaunchCriteriaExperimentalSetting />);
    expect(
      screen.getByRole('switch', {
        name: 'Toggle custom automation launch criteria',
      }),
    ).toBeDisabled();
  });
});
