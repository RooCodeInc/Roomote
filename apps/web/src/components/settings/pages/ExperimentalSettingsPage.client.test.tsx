import { fireEvent, render, screen } from '@testing-library/react';

const { refetchMock, state } = vi.hoisted(() => ({
  refetchMock: vi.fn(),
  state: {
    error: null as Error | null,
    hasLoadedPreferences: true,
    isFetching: false,
    isAdmin: false,
  },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: state.isAdmin }),
}));

vi.mock('@/hooks/usePersonalPreferences', () => ({
  usePersonalPreferences: () => ({
    ...state,
    refetch: refetchMock,
  }),
}));

vi.mock('@/components/settings/SettingsShell', () => ({
  SettingsShell: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/settings/PrivateSessionsExperimentalSetting', () => ({
  PrivateSessionsExperimentalSetting: () => <div>Private Sessions setting</div>,
}));

vi.mock(
  '@/components/settings/HomeComposerSuggestionsExperimentalSetting',
  () => ({
    HomeComposerSuggestionsExperimentalSetting: () => (
      <div>Home suggestions setting</div>
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

vi.mock(
  '@/components/settings/ServiceCredentialToolsExperimentalSetting',
  () => ({
    ServiceCredentialToolsExperimentalSetting: () => (
      <div>Integration keys setting</div>
    ),
  }),
);

import { ExperimentalSettingsPage } from './ExperimentalSettingsPage';

describe('ExperimentalSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.error = null;
    state.hasLoadedPreferences = true;
    state.isFetching = false;
    state.isAdmin = false;
  });

  it('shows the deployment-wide Private Sessions control only to admins', () => {
    const { rerender } = render(<ExperimentalSettingsPage />);

    expect(
      screen.queryByText('Private Sessions setting'),
    ).not.toBeInTheDocument();

    state.isAdmin = true;
    rerender(<ExperimentalSettingsPage />);

    expect(screen.getByText('Private Sessions setting')).toBeInTheDocument();
  });

  it('shows one retryable error instead of default-valued settings after an initial load failure', () => {
    state.error = new Error('Failed to load preferences');
    state.hasLoadedPreferences = false;

    const { rerender } = render(<ExperimentalSettingsPage />);

    expect(
      screen.getByText('Failed to load experimental preferences.'),
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
    state.hasLoadedPreferences = true;
    rerender(<ExperimentalSettingsPage />);

    expect(screen.getByText('Home suggestions setting')).toBeInTheDocument();
    expect(screen.getByText('Results setting')).toBeInTheDocument();
    expect(
      screen.getByText('Slack peer conversations setting'),
    ).toBeInTheDocument();
    expect(screen.getByText('Integration keys setting')).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load experimental preferences.'),
    ).not.toBeInTheDocument();
  });

  it('keeps a repeated failure actionable after the retry settles', () => {
    state.error = new Error('Failed to load preferences');
    state.hasLoadedPreferences = false;
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

    expect(screen.getByText('Home suggestions setting')).toBeInTheDocument();
    expect(screen.getByText('Results setting')).toBeInTheDocument();
    expect(
      screen.getByText('Slack peer conversations setting'),
    ).toBeInTheDocument();
    expect(screen.getByText('Integration keys setting')).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load experimental preferences.'),
    ).not.toBeInTheDocument();
  });
});
