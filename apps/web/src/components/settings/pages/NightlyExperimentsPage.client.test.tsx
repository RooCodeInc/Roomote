import { render, screen } from '@testing-library/react';

const { useDeploymentExperimentsMock, state } = vi.hoisted(() => ({
  useDeploymentExperimentsMock: vi.fn(),
  state: {
    error: null as Error | null,
    hasLoadedExperiments: true,
    isFetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock('@/hooks/useDeploymentExperiments', () => ({
  useDeploymentExperiments: useDeploymentExperimentsMock,
}));

vi.mock('@/components/settings/SettingsShell', () => ({
  SettingsShell: ({
    adminOnly,
    children,
  }: {
    adminOnly?: boolean;
    children: React.ReactNode;
  }) => (
    <div data-testid="nightly-settings" data-admin-only={String(adminOnly)}>
      {children}
    </div>
  ),
}));

import { NightlyExperimentsPage } from './NightlyExperimentsPage';

describe('NightlyExperimentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDeploymentExperimentsMock.mockReturnValue(state);
    state.error = null;
    state.hasLoadedExperiments = true;
    state.isFetching = false;
  });

  it('uses nightly data and clearly reports when no experiment was promoted', () => {
    render(<NightlyExperimentsPage />);

    expect(useDeploymentExperimentsMock).toHaveBeenCalledWith(
      'Failed to load nightly experiments.',
      'internal-nightly',
    );
    expect(screen.getByTestId('nightly-settings')).toHaveAttribute(
      'data-admin-only',
      'true',
    );
    expect(
      screen.getByText('No internal nightly experiments'),
    ).toBeInTheDocument();
  });

  it('renders one retryable error without default-valued settings', () => {
    state.error = new Error('Failed to load');
    state.hasLoadedExperiments = false;

    render(<NightlyExperimentsPage />);

    expect(
      screen.getByText('Failed to load nightly experiments.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(
      screen.queryByText('No internal nightly experiments'),
    ).not.toBeInTheDocument();
  });
});
