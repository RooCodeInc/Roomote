import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useIntegrationToolApprovalsExperiment', () => ({
  useIntegrationToolApprovalsExperiment: () => ({
    enabled: true,
    isLoading: false,
    isUpdating: false,
    setEnabled: vi.fn(),
  }),
}));

import { IntegrationToolApprovalsExperimentalSetting } from './IntegrationToolApprovalsExperimentalSetting';

it('directs Auto setup to Agent Guidance while leaving per-tool controls on the Integrations page', () => {
  render(<IntegrationToolApprovalsExperimentalSetting />);

  expect(
    screen.getByText(/tools dialog on the Integrations page offers Auto/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Set up Auto mode in Settings → Agent Guidance/),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/Set up Auto mode on the Integrations page/),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/Settings → Integrations/)).not.toBeInTheDocument();
});
