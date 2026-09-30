import { render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({ isAdmin: true, enabled: true }));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: state.isAdmin }),
}));
vi.mock('@/hooks/useIntegrationToolAutoApprovalsExperiment', () => ({
  useIntegrationToolAutoApprovalsExperiment: () => ({ enabled: state.enabled }),
}));
vi.mock('./IntegrationToolAutoModeSetting', () => ({
  IntegrationToolAutoModeSetting: () => <div data-testid="auto-mode-setting" />,
}));

import { IntegrationToolAutoModeSection } from './IntegrationToolAutoModeSection';

describe('IntegrationToolAutoModeSection', () => {
  beforeEach(() => {
    state.isAdmin = true;
    state.enabled = true;
  });

  it('shows the section to an admin while the experiment is on', () => {
    render(<IntegrationToolAutoModeSection />);
    expect(screen.getByText('Auto-approval decisions')).toBeInTheDocument();
    expect(screen.getByTestId('auto-mode-setting')).toBeInTheDocument();
  });

  it('renders nothing for a member, or with the experiment off', () => {
    state.isAdmin = false;
    expect(render(<IntegrationToolAutoModeSection />).container.innerHTML).toBe(
      '',
    );
    state.isAdmin = true;
    state.enabled = false;
    expect(render(<IntegrationToolAutoModeSection />).container.innerHTML).toBe(
      '',
    );
  });
});
