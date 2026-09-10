import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const { state } = vi.hoisted(() => ({
  state: {
    optionalSourceControlEnabled: true,
    repositoryCount: 0,
    sourceControlSkipped: false,
    skipFails: false,
    invalidateQueries: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      status: { queryOptions: () => ({}), queryKey: () => ['setup-status'] },
      saveSourceControlProviderChoice: { mutationOptions: () => ({}) },
    },
    setup: {
      skipSourceControl: {
        mutationOptions: (options: object) => ({ ...options, skip: true }),
      },
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      optionalSourceControlEnabled: state.optionalSourceControlEnabled,
      sourceControlSkipped: state.sourceControlSkipped,
      setupNewState: { sourceControlProvider: null },
      sourceControlSetup: {
        preselectedProvider: 'github',
        providers: [
          {
            provider: 'github',
            label: 'GitHub',
            connected: state.repositoryCount > 0,
            repositoryCount: state.repositoryCount,
          },
        ],
      },
    },
  }),
  useMutation: (options: {
    skip?: boolean;
    onSuccess?: () => void;
    onError?: (error: Error) => void;
  }) => ({
    mutate: () => {
      if (!options.skip) return;
      if (state.skipFails) {
        options.onError?.(new Error('Skip failed'));
      } else {
        state.sourceControlSkipped = true;
        options.onSuccess?.();
      }
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: state.invalidateQueries }),
}));
vi.mock('./source-control-card-stage', () => ({
  getInitialSourceControlCardStage: () => 'provider',
}));
vi.mock('./SourceControlProviderPicker', () => ({
  SourceControlProviderPicker: () => <div>Provider picker</div>,
}));
vi.mock('./SourceControlConfiguration', () => ({
  SourceControlConfiguration: () => null,
}));
vi.mock('./SourceControlConnection', () => ({
  SourceControlConnection: () => null,
}));
vi.mock('./SetupSessionActionCard', () => ({
  SetupSessionActionCardActions: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SetupSessionActionCard: ({
    title,
    intro,
    children,
  }: {
    title: string;
    intro: string;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{intro}</p>
      {children}
    </section>
  ),
}));

import { SetupSessionSourceControlCard } from './SetupSourceControlCard';

describe('SetupSessionSourceControlCard', () => {
  beforeEach(() => {
    state.optionalSourceControlEnabled = true;
    state.repositoryCount = 0;
    state.sourceControlSkipped = false;
    state.skipFails = false;
    state.invalidateQueries.mockReset();
  });

  it('offers to skip source-control setup by default', () => {
    render(<SetupSessionSourceControlCard sessionId="setup-session" />);
    expect(
      screen.getByText('Where do you keep your code?'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Connect to your source control provider for me to work on your code. You can also do that later in Settings → Source control.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Provider picker')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Skip for now' }),
    ).toBeInTheDocument();
  });

  it('hides the card when source-control setup is skipped', () => {
    render(<SetupSessionSourceControlCard sessionId="setup-session" />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.queryByText('Provider picker')).not.toBeInTheDocument();
  });

  it('keeps the card hidden after a successful skip and a fresh mount', async () => {
    const view = render(
      <SetupSessionSourceControlCard sessionId="setup-session" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() =>
      expect(state.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['setup-status'],
      }),
    );
    view.unmount();
    render(<SetupSessionSourceControlCard sessionId="setup-session" />);
    expect(screen.queryByText('Provider picker')).not.toBeInTheDocument();
  });

  it('does not show the card on a later visit with persisted skipped status', () => {
    state.sourceControlSkipped = true;
    render(<SetupSessionSourceControlCard sessionId="setup-session" />);
    expect(screen.queryByText('Provider picker')).not.toBeInTheDocument();
  });

  it('keeps the card available when saving the skip fails', () => {
    state.skipFails = true;
    render(<SetupSessionSourceControlCard sessionId="setup-session" />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.getByText('Provider picker')).toBeInTheDocument();
  });

  it('keeps required setup visible when optional source control is disabled', () => {
    state.optionalSourceControlEnabled = false;
    state.sourceControlSkipped = true;
    render(<SetupSessionSourceControlCard sessionId="setup-session" />);
    expect(screen.getByText('Provider picker')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Skip for now' }),
    ).not.toBeInTheDocument();
  });

  it('offers connection as optional without claiming repository access', () => {
    render(<SetupSessionSourceControlCard sessionId="setup-session" />);
    expect(
      screen.getByText(
        'Connect to your source control provider for me to work on your code. You can also do that later in Settings → Source control.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Provider picker')).toBeInTheDocument();
  });

  it('hides the action once a connected provider has synchronized repositories', () => {
    state.optionalSourceControlEnabled = true;
    state.repositoryCount = 1;
    render(<SetupSessionSourceControlCard sessionId="setup-session" />);
    expect(screen.queryByText('Provider picker')).not.toBeInTheDocument();
  });
});
