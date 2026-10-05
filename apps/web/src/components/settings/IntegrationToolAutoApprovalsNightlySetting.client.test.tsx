import { fireEvent, render, screen } from '@testing-library/react';

const setEnabled = vi.fn();
vi.mock('@/hooks/useDeploymentExperiments', () => ({
  useDeploymentExperiment: () => ({
    enabled: false,
    isLoading: false,
    isUpdating: false,
    setEnabled,
  }),
}));

import { IntegrationToolAutoApprovalsNightlySetting } from './IntegrationToolAutoApprovalsNightlySetting';

it('offers the Auto switch on the nightly page and updates its flag', () => {
  render(<IntegrationToolAutoApprovalsNightlySetting />);

  expect(screen.getByText('Auto tool approvals')).toBeInTheDocument();
  expect(
    screen.getByText(/Jev is required for Auto to make decisions/),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('switch', { name: 'Toggle Auto tool approvals' }),
  );
  expect(setEnabled).toHaveBeenCalledWith(true);
});
