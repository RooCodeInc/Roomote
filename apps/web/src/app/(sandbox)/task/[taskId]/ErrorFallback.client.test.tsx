import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const {
  invalidateQueriesMock,
  queryKeyMock,
  useQueryClientMock,
  useSandboxConnectionStatusMock,
  useTRPCMock,
} = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn(),
  queryKeyMock: vi.fn((input) => ['sandboxSession.byTaskId', input]),
  useQueryClientMock: vi.fn(),
  useSandboxConnectionStatusMock: vi.fn(),
  useTRPCMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: useQueryClientMock,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: useTRPCMock,
}));

vi.mock('@/components/system', () => ({
  AlertCircle: () => <svg aria-hidden="true" />,
  RefreshCw: () => <svg aria-hidden="true" />,
  Button: ({
    children,
    ...props
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock('./hooks', () => ({
  useSandboxConnectionStatus: useSandboxConnectionStatusMock,
}));

import { ConnectionStatusBanner } from './ErrorFallback';

describe('ConnectionStatusBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useQueryClientMock.mockReturnValue({
      invalidateQueries: invalidateQueriesMock,
    });

    useTRPCMock.mockReturnValue({
      sandboxSession: {
        byTaskId: {
          queryKey: queryKeyMock,
        },
      },
    });

    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: false,
      connectionError: false,
      connectionFailureCategory: null,
      reconnecting: false,
      reconnect: vi.fn(),
    });
  });

  it('invalidates only the current task session query when the connection errors', async () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: true,
      connectionError: true,
      reconnecting: false,
      reconnect: vi.fn(),
    });

    render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: vi.fn(),
          } as never
        }
      />,
    );

    await waitFor(() => {
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: ['sandboxSession.byTaskId', { taskId: 'task-123' }],
      });
    });
  });

  it('still invalidates the current task session query when the initial connection exhausts retries', async () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: false,
      connectionError: true,
      reconnecting: false,
      reconnect: vi.fn(),
    });

    render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: vi.fn(),
          } as never
        }
      />,
    );

    await waitFor(() => {
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: ['sandboxSession.byTaskId', { taskId: 'task-123' }],
      });
    });
  });

  it('stays hidden while transport is still pending without an error', () => {
    const { container } = render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: vi.fn(),
          } as never
        }
      />,
    );

    expect(
      screen.queryByText('Connecting to the live task...'),
    ).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a neutral reconnecting banner before surfacing an error', () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: true,
      connectionError: false,
      reconnecting: true,
      reconnect: vi.fn(),
    });

    render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: vi.fn(),
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Reconnecting to the live task...'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Lost connection to the live task'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Reconnect' }),
    ).not.toBeInTheDocument();
  });

  it('shows a startup connection banner while the first live attach is still retrying', () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: false,
      connectionError: false,
      reconnecting: true,
      reconnect: vi.fn(),
    });

    render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: vi.fn(),
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Connecting to the live task...'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Reconnecting to the live task...'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Lost connection to the live task'),
    ).not.toBeInTheDocument();
  });

  it('shows a backend-unavailable message when the initial connection retry budget is exhausted', () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: false,
      connectionError: true,
      connectionFailureCategory: 'backend_unavailable',
      reconnecting: false,
      reconnect: vi.fn(),
    });

    render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: vi.fn(),
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Could not reach the live task'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Lost connection to the live task'),
    ).not.toBeInTheDocument();
  });

  it('suppresses the lost-connection error while the sleep snapshot is in progress', () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: true,
      connectionError: true,
      reconnecting: false,
      reconnect: vi.fn(),
    });

    const { container } = render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: vi.fn(),
            cloudJob: {
              sleepRequestedAt: new Date(),
              snapshotRequestedAt: new Date(),
              snapshotCreatedAt: null,
              snapshotFailedAt: null,
              snapshotId: null,
            },
          } as never
        }
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('suppresses the lost-connection error once the job has a snapshot', () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: true,
      connectionError: true,
      reconnecting: false,
      reconnect: vi.fn(),
    });

    const { container } = render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: vi.fn(),
            cloudJob: {
              sleepRequestedAt: null,
              snapshotRequestedAt: new Date(),
              snapshotCreatedAt: new Date(),
              snapshotFailedAt: null,
              snapshotId: 'snap-1',
            },
          } as never
        }
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the lost-connection error when only sleepRequestedAt is set', () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: true,
      connectionError: true,
      reconnecting: false,
      reconnect: vi.fn(),
    });

    render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: vi.fn(),
            cloudJob: {
              sleepRequestedAt: new Date(),
              snapshotRequestedAt: null,
              snapshotCreatedAt: null,
              snapshotFailedAt: null,
              snapshotId: null,
            },
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Lost connection to the live task'),
    ).toBeInTheDocument();
  });

  it('suppresses the reconnecting banner while a snapshot is in progress', () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: true,
      connectionError: false,
      reconnecting: true,
      reconnect: vi.fn(),
    });

    const { container } = render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: vi.fn(),
            cloudJob: {
              sleepRequestedAt: null,
              snapshotRequestedAt: new Date(),
              snapshotCreatedAt: null,
              snapshotFailedAt: null,
              snapshotId: null,
            },
          } as never
        }
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('still shows the lost-connection error when the sleep snapshot fails', () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: true,
      connectionError: true,
      reconnecting: false,
      reconnect: vi.fn(),
    });

    render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: vi.fn(),
            cloudJob: {
              sleepRequestedAt: new Date(),
              snapshotRequestedAt: new Date(),
              snapshotCreatedAt: null,
              snapshotFailedAt: new Date(),
              snapshotId: null,
            },
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Lost connection to the live task'),
    ).toBeInTheDocument();
  });

  it('passes the refreshed sandbox connection target into reconnect', async () => {
    const reconnectMock = vi.fn();
    const refreshConnectionMock = vi.fn().mockResolvedValue({
      url: 'http://sandbox-refreshed.test',
      token: 'token-refreshed',
    });

    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: true,
      connectionError: true,
      connectionFailureCategory: null,
      reconnecting: false,
      reconnect: reconnectMock,
    });

    render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            refreshConnection: refreshConnectionMock,
          } as never
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    await waitFor(() => {
      expect(refreshConnectionMock).toHaveBeenCalledTimes(1);
      expect(reconnectMock).toHaveBeenCalledWith({
        url: 'http://sandbox-refreshed.test',
        token: 'token-refreshed',
      });
    });
  });

  it('shows an auth-specific message when reconnect auth refresh fails', () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: true,
      connectionError: true,
      connectionFailureCategory: 'auth_error',
      reconnecting: false,
      reconnect: vi.fn(),
    });

    render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            transportErrorCategory: null,
            refreshConnection: vi.fn(),
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Could not refresh access to the live task'),
    ).toBeInTheDocument();
  });

  it('shows a reconnect-specific message when the live reconnect budget is exhausted', () => {
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      hasConnectedOnce: true,
      connectionError: true,
      connectionFailureCategory: 'client_reconnect_failed',
      reconnecting: false,
      reconnect: vi.fn(),
    });

    render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: false,
            transportErrorCategory: null,
            refreshConnection: vi.fn(),
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Could not restore the live task connection'),
    ).toBeInTheDocument();
  });

  it('shows an auth-specific initial message for token/bootstrap failures', () => {
    render(
      <ConnectionStatusBanner
        session={
          {
            taskId: 'task-123',
            hasTransportError: true,
            transportErrorCategory: 'auth_error',
            refreshConnection: vi.fn(),
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Could not verify access to the live task'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
  });
});
