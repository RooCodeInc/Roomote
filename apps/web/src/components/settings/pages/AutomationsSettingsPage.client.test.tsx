import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({ isAdmin: false }));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => state,
}));

vi.mock('@/components/settings/automations', () => ({
  AutomationsSettings: ({ toolbarLeading }: { toolbarLeading?: ReactNode }) => (
    <>
      {toolbarLeading}
      <div>Full automation settings</div>
    </>
  ),
}));

vi.mock('@/components/settings/automations/CustomAutomationsSection', () => ({
  CustomAutomationsSection: ({
    toolbarLeading,
  }: {
    toolbarLeading?: ReactNode;
  }) => (
    <>
      {toolbarLeading}
      <div>Custom automation management</div>
    </>
  ),
}));

vi.mock('@/components/settings/DeploymentTimeZoneSetting', () => ({
  DeploymentTimeZoneSetting: () => <div>Deployment timezone controls</div>,
}));

vi.mock(
  '@/components/settings/automations/AutomationDefaultDestinationSetting',
  () => ({
    AutomationDefaultDestinationSetting: () => (
      <div>Automation default destination controls</div>
    ),
  }),
);

import AutomationsPage from '@/app/(authenticated)/automations/page';

describe('Automations page access', () => {
  it('renders only custom automation management for members', () => {
    state.isAdmin = false;
    render(<AutomationsPage />);

    expect(
      screen.getByRole('heading', { name: 'Automations' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Custom automation management'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Full automation settings'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Deployment timezone controls'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Automation default destination controls'),
    ).toBeInTheDocument();
  });

  it('preserves the full view and deployment timezone controls for admins', () => {
    state.isAdmin = true;
    render(<AutomationsPage />);

    expect(screen.getByText('Full automation settings')).toBeInTheDocument();
    expect(
      screen.getByText('Deployment timezone controls'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Automation default destination controls'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Custom automation management'),
    ).not.toBeInTheDocument();
  });
});
