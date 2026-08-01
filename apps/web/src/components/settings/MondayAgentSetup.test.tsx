import { render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  data: {
    featureEnabled: false,
    installation: null,
  } as
    | { featureEnabled: false; installation: null }
    | {
        featureEnabled: true;
        callbackUrl: string;
        installation: null | {
          id: string;
          accountName: string | null;
          agentId: string;
          status: 'inactive' | 'error';
          error: string | null;
        };
      },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(() => ({ data: state.data, isPending: false })),
  useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    mondayAgent: {
      installation: {
        queryOptions: vi.fn(() => ({})),
        queryKey: vi.fn(() => ['mondayAgent', 'installation']),
      },
      install: { mutationOptions: vi.fn(() => ({})) },
      rotateCredentials: { mutationOptions: vi.fn(() => ({})) },
      uninstall: { mutationOptions: vi.fn(() => ({})) },
    },
  }),
}));

import { MondayAgentSetup } from './MondayAgentSetup';

describe('MondayAgentSetup', () => {
  it('renders nothing when the deployment beta is disabled', () => {
    state.data = { featureEnabled: false, installation: null };
    const { container } = render(<MondayAgentSetup />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows setup without exposing credentials when enabled', () => {
    state.data = {
      featureEnabled: true,
      callbackUrl: 'https://roomote.example/api/webhooks/monday/agent',
      installation: null,
    };
    render(<MondayAgentSetup />);

    expect(
      screen.getByText('monday.com external agent beta'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('https://roomote.example/api/webhooks/monday/agent'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Install external agent' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/signing-secret|agent-token/)).toBeNull();
  });
});
