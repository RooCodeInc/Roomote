import { fireEvent, render, screen } from '@testing-library/react';

const setEnabled = vi.fn();

vi.mock('@/hooks/usePrivateSessionsExperiment', () => ({
  usePrivateSessionsExperiment: () => ({
    enabled: false,
    isLoading: false,
    isUpdating: false,
    setEnabled,
  }),
}));

import { PrivateSessionsExperimentalSetting } from './PrivateSessionsExperimentalSetting';

describe('PrivateSessionsExperimentalSetting', () => {
  it('is disabled by default and persists an explicit opt-in', () => {
    render(<PrivateSessionsExperimentalSetting />);

    const toggle = screen.getByRole('switch', {
      name: 'Toggle Private Sessions',
    });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(setEnabled).toHaveBeenCalledWith(true);
  });
});
