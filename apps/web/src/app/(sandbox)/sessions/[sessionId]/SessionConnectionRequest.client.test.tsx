import { fireEvent, render, screen } from '@testing-library/react';
import { SessionConnectionRequest } from './SessionConnectionRequest';

const state = vi.hoisted(() => ({
  data: null as null | {
    id: string;
    url: string;
    status: string;
    reason: string;
    provider: string;
    repositoryFullName: string;
    canConnect: boolean;
    canCheck: boolean;
    canCancel: boolean;
    enabled?: boolean;
  },
  check: vi.fn(),
  cancel: vi.fn(),
  search: '',
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sourceControl: {
      connectionRequest: {
        queryOptions: (input: object) => ({
          queryKey: ['connectionRequest', input],
        }),
      },
      checkConnectionRequest: { mutationOptions: () => ({ kind: 'check' }) },
      cancelConnectionRequest: { mutationOptions: () => ({ kind: 'cancel' }) },
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: state.data,
    refetch: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useMutation: ({ kind }: { kind: string }) => ({
    mutate: kind === 'check' ? state.check : state.cancel,
    isPending: false,
  }),
}));
vi.mock('@/components/settings/SourceControl', () => ({
  SourceControl: ({
    connectionRequestId,
    connectionReturnTarget,
  }: {
    connectionRequestId: string;
    connectionReturnTarget: string;
  }) => (
    <div data-testid="trusted-config">
      {connectionRequestId} {connectionReturnTarget}
    </div>
  ),
}));

describe('Session connection request', () => {
  it('explains rollout disablement without offering a connection or check', () => {
    Object.assign(state.data!, {
      enabled: false,
      canConnect: false,
      canCheck: false,
    });
    render(<SessionConnectionRequest sessionId="session-id" />);
    expect(
      screen.getByText(/Session connection requests are disabled/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Configure source control' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Check status' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Cancel request' }),
    ).toBeInTheDocument();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    state.search = 'connectionRequest=request-id&gitlab=connected';
    state.data = {
      id: 'request-id',
      url: '/sessions/session-id?connectionRequest=request-id',
      status: 'pending',
      reason: 'repository_unavailable',
      provider: 'gitlab',
      repositoryFullName: 'org/exact-target',
      canConnect: true,
      canCheck: true,
      canCancel: true,
    };
  });
  it('does not authorize or resume from connected query parameters; checks only on explicit input', () => {
    render(<SessionConnectionRequest sessionId="session-id" />);
    expect(state.check).not.toHaveBeenCalled();
    expect(screen.getByText('org/exact-target')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    expect(state.check).toHaveBeenCalledWith({
      sessionId: 'session-id',
      requestId: 'request-id',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    expect(state.cancel).toHaveBeenCalledWith({
      sessionId: 'session-id',
      requestId: 'request-id',
    });
  });
  it('passes the stored request and canonical return into the trusted provider UI', () => {
    render(<SessionConnectionRequest sessionId="session-id" />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Configure source control' }),
    );
    expect(screen.getByTestId('trusted-config')).toHaveTextContent(
      'request-id /sessions/session-id?connectionRequest=request-id',
    );
  });
  it('does not expose admin configuration or cancellation to a transcript reader', () => {
    Object.assign(state.data!, {
      canConnect: false,
      canCancel: false,
      canCheck: false,
    });
    render(<SessionConnectionRequest sessionId="session-id" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(
      screen.getByText(/deployment admin can connect/),
    ).toBeInTheDocument();
  });
  it('reports terminal state without promising continuation', () => {
    Object.assign(state.data!, {
      status: 'superseded',
      canConnect: false,
      canCancel: false,
      canCheck: false,
    });
    render(<SessionConnectionRequest sessionId="session-id" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Connection request superseded.',
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('reports unavailable request without rendering controls', () => {
    state.data = null;
    render(<SessionConnectionRequest sessionId="session-id" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'not available in this Session',
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
