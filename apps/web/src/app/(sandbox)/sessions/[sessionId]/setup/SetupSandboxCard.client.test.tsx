import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const { state, fetchQueryMock } = vi.hoisted(() => ({
  state: { computeReady: false },
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
      setupNewState: { setupSession: { starterTaskSelection: null } },
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
  });

  it('offers sandbox setup before optional starter work is selected', () => {
    render(<SetupSandboxCard />);

    expect(
      screen.getByRole('heading', { name: 'I need a sandbox to run tasks' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Sandbox provider picker')).toBeInTheDocument();
  });

  it('stays hidden once compute setup is ready', () => {
    state.computeReady = true;

    render(<SetupSandboxCard />);

    expect(screen.queryByText('Sandbox provider picker')).toBeNull();
    expect(fetchQueryMock).toHaveBeenCalledOnce();
  });
});
