import { fireEvent, render, screen } from '@testing-library/react';

const { refetchMock, state } = vi.hoisted(() => ({
  refetchMock: vi.fn(),
  state: {
    error: null as Error | null,
    hasLoadedExperiments: true,
    isFetching: false,
  },
}));

vi.mock('@/hooks/useDeploymentExperiments', () => ({
  useDeploymentExperiments: () => ({
    ...state,
    refetch: refetchMock,
  }),
}));

vi.mock('@/components/settings/SettingsShell', () => ({
  SettingsShell: ({
    adminOnly,
    children,
  }: {
    adminOnly?: boolean;
    children: React.ReactNode;
  }) => (
    <div
      data-testid="experimental-settings"
      data-admin-only={String(adminOnly)}
    >
      {children}
    </div>
  ),
}));

vi.mock('@/components/settings/PrivateSessionsExperimentalSetting', () => ({
  PrivateSessionsExperimentalSetting: () => <div>Private Sessions setting</div>,
}));

vi.mock(
  '@/components/settings/BrowserNotificationsExperimentalSetting',
  () => ({
    BrowserNotificationsExperimentalSetting: () => (
      <div>Browser notifications setting</div>
    ),
  }),
);

vi.mock('@/components/settings/ResultsExperimentalSetting', () => ({
  ResultsExperimentalSetting: () => <div>Results setting</div>,
}));

vi.mock(
  '@/components/settings/SlackPeerConversationsExperimentalSetting',
  () => ({
    SlackPeerConversationsExperimentalSetting: () => (
      <div>Slack peer conversations setting</div>
    ),
  }),
);

import { ExperimentalSettingsPage } from './ExperimentalSettingsPage';

describe('ExperimentalSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.error = null;
    state.hasLoadedExperiments = true;
    state.isFetching = false;
  });

  it('marks every experimental setting as admin-only', () => {
    render(<ExperimentalSettingsPage />);

    expect(screen.getByTestId('experimental-settings')).toHaveAttribute(
      'data-admin-only',
      'true',
    );
    expect(screen.getByText('Private Sessions setting')).toBeInTheDocument();
  });

  it('shows one retryable error instead of default-valued settings after an initial load failure', () => {
    state.error = new Error('Failed to load preferences');
    state.hasLoadedExperiments = false;

    const { rerender } = render(<ExperimentalSettingsPage />);

    expect(
      screen.getByText('Failed to load experimental settings.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(
      screen.queryByText('Home suggestions setting'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Results setting')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Slack peer conversations setting'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchMock).toHaveBeenCalledOnce();

    state.error = null;
    state.hasLoadedExperiments = true;
    rerender(<ExperimentalSettingsPage />);

    expect(
      screen.queryByText('Home suggestions setting'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Results setting')).toBeInTheDocument();
    expect(
      screen.getByText('Slack peer conversations setting'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load experimental settings.'),
    ).not.toBeInTheDocument();
  });

  it('keeps a repeated failure actionable after the retry settles', () => {
    state.error = new Error('Failed to load preferences');
    state.hasLoadedExperiments = false;
    state.isFetching = true;

    const { rerender } = render(<ExperimentalSettingsPage />);

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();

    state.isFetching = false;
    rerender(<ExperimentalSettingsPage />);

    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('keeps cached settings visible when a later refetch fails', () => {
    state.error = new Error('Refresh failed');

    render(<ExperimentalSettingsPage />);

    expect(
      screen.queryByText('Home suggestions setting'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Results setting')).toBeInTheDocument();
    expect(
      screen.getByText('Slack peer conversations setting'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load experimental settings.'),
    ).not.toBeInTheDocument();
  });
});
