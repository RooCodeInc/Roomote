import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const { state, fetchQueryMock } = vi.hoisted(() => ({
  state: {
    computeReady: false,
    repositoryCount: 1,
    starterTaskIds: [] as string[],
  },
  fetchQueryMock: vi.fn(),
}));

vi.mock('@/components/system', () => ({
  Container: () => <svg aria-hidden="true" />,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setup: {
      sessionStatus: { queryOptions: () => ({ query: 'session-status' }) },
    },
    setupNew: {
      status: {
        queryKey: () => ['setup-new-status'],
        queryOptions: () => ({ query: 'setup-new-status' }),
      },
      saveComputeProviderChoice: { mutationOptions: () => ({}) },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: () => ({
    data: {
      computeSetup: {
        setupSatisfied: state.computeReady,
        selectedProvider: null,
      },
      setupNewState: {
        setupSession: {
          starterTaskSelection: { taskIds: state.starterTaskIds },
        },
      },
      sourceControlSetup: {
        providers: [
          { connected: true, repositoryCount: state.repositoryCount },
        ],
      },
    },
  }),
  useQueryClient: () => ({
    fetchQuery: fetchQueryMock,
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock('./SandboxConfiguration', () => ({
  SandboxConfiguration: () => <div>Sandbox configuration</div>,
}));

vi.mock('./SandboxProviderPicker', () => ({
  SandboxProviderPicker: () => <div>Sandbox provider picker</div>,
}));

vi.mock('./SetupSessionActionCard', () => ({
  SetupSessionActionCard: ({
    title,
    children,
  }: {
    title: string;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

import { SetupSandboxCard } from './SetupSandboxCard';

describe('SetupSandboxCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.computeReady = false;
    state.repositoryCount = 1;
    state.starterTaskIds = [];
  });

  it('stays hidden before starter work is selected', () => {
    render(<SetupSandboxCard />);

    expect(screen.queryByText('Sandbox provider picker')).toBeNull();
  });

  it('offers sandbox setup after coding work is selected', () => {
    state.starterTaskIds = ['speed-up-ci'];

    render(<SetupSandboxCard />);

    expect(screen.getByText('Sandbox provider picker')).toBeInTheDocument();
  });

  it('stays hidden without synchronized repositories', () => {
    state.starterTaskIds = ['speed-up-ci'];
    state.repositoryCount = 0;

    render(<SetupSandboxCard />);

    expect(screen.queryByText('Sandbox provider picker')).toBeNull();
  });

  it('stays hidden once compute setup is ready', () => {
    state.computeReady = true;
    state.starterTaskIds = ['speed-up-ci'];

    render(<SetupSandboxCard />);

    expect(screen.queryByText('Sandbox provider picker')).toBeNull();
    expect(fetchQueryMock).toHaveBeenCalledOnce();
  });
});
