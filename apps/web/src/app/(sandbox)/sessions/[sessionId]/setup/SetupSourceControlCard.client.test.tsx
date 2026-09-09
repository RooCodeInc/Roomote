import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const { state } = vi.hoisted(() => ({
  state: { optionalSourceControlEnabled: true, repositoryCount: 0 },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      status: { queryOptions: () => ({}), queryKey: () => ['setup-status'] },
      saveSourceControlProviderChoice: { mutationOptions: () => ({}) },
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      optionalSourceControlEnabled: state.optionalSourceControlEnabled,
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
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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
