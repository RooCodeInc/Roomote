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

it('directs Auto setup to Agent Guidance while leaving per-tool controls in Integrations', () => {
  render(<IntegrationToolApprovalsExperimentalSetting />);

  expect(
    screen.getByText(/tools dialog in Settings → Integrations offers Auto/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Set up Auto mode in Settings → Agent Guidance/),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/Set up Auto mode in Settings → Integrations/),
  ).not.toBeInTheDocument();
});
