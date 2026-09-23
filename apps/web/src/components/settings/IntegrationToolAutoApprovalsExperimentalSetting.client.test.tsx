import { fireEvent, render, screen } from '@testing-library/react';

const setEnabled = vi.fn();
vi.mock('@/hooks/useIntegrationToolAutoApprovalsExperiment', () => ({
  useIntegrationToolAutoApprovalsExperiment: () => ({
    enabled: false,
    isLoading: false,
    isUpdating: false,
    setEnabled,
  }),
}));

import { IntegrationToolAutoApprovalsExperimentalSetting } from './IntegrationToolAutoApprovalsExperimentalSetting';

it('offers only Auto as experimental and points to Agent Guidance', () => {
  render(<IntegrationToolAutoApprovalsExperimentalSetting />);

  expect(screen.getByText('Auto tool approvals')).toBeInTheDocument();
  expect(
    screen.getByText(
      /Auto-approval decisions card in Settings → Agent Guidance/,
    ),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('switch', { name: 'Toggle Auto tool approvals' }),
  );
  expect(setEnabled).toHaveBeenCalledWith(true);
});
