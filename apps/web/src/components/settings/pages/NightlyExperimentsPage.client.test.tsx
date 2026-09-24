import { render, screen } from '@testing-library/react';

const { useDeploymentExperimentMock, useDeploymentExperimentsMock, state } =
  vi.hoisted(() => ({
    useDeploymentExperimentMock: vi.fn(() => ({
      enabled: false,
      isLoading: false,
      isUpdating: false,
      setEnabled: vi.fn(),
    })),
    useDeploymentExperimentsMock: vi.fn(),
    state: {
      error: null as Error | null,
      hasLoadedExperiments: true,
      isFetching: false,
      refetch: vi.fn(),
    },
  }));

vi.mock('@/hooks/useDeploymentExperiments', () => ({
  useDeploymentExperiment: useDeploymentExperimentMock,
  useDeploymentExperiments: useDeploymentExperimentsMock,
}));

vi.mock('@/components/settings/SettingsShell', () => ({
  SettingsShell: ({
    adminOnly,
    standalone,
    titleOverride,
    descriptionOverride,
    children,
  }: {
    adminOnly?: boolean;
    standalone?: boolean;
    titleOverride?: string;
    descriptionOverride?: string;
    children: React.ReactNode;
  }) => (
    <div
      data-testid="nightly-settings"
      data-admin-only={String(adminOnly)}
      data-standalone={String(standalone)}
    >
      <h1>{titleOverride}</h1>
      <p>{descriptionOverride}</p>
      {children}
    </div>
  ),
}));

vi.mock(
  '@/components/settings/IntegrationToolAutoApprovalsNightlySetting',
  () => ({
    IntegrationToolAutoApprovalsNightlySetting: () => (
      <div>Auto tool approvals setting</div>
    ),
  }),
);

import { NightlyExperimentsPage } from './NightlyExperimentsPage';

describe('NightlyExperimentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDeploymentExperimentsMock.mockReturnValue(state);
    state.error = null;
    state.hasLoadedExperiments = true;
    state.isFetching = false;
  });

  it('uses nightly data and renders the available control as a standalone page', () => {
    render(<NightlyExperimentsPage />);

    expect(useDeploymentExperimentsMock).toHaveBeenCalledWith(
      'Failed to load nightly experiments.',
      'internal-nightly',
    );
    expect(screen.getByTestId('nightly-settings')).toHaveAttribute(
      'data-admin-only',
      'true',
    );
    expect(screen.getByTestId('nightly-settings')).toHaveAttribute(
      'data-standalone',
      'true',
    );
    expect(
      screen.getByRole('heading', { name: 'Nightly Experiments' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Internal experiment switches. You really shouldn't mess with these.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Dizzy')).toBeInTheDocument();
    expect(screen.getByText('Auto tool approvals setting')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Continuously spin the Roomote logo mark in the collapsed sidebar and mobile header.',
      ),
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
    expect(screen.queryByText('Dizzy')).not.toBeInTheDocument();
  });
});
