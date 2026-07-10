import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const {
  pushMock,
  cancelMutateAsyncMock,
  deleteMutateAsyncMock,
  errorToastMock,
  authState,
} = vi.hoisted(() => ({
  pushMock: vi.fn(),
  cancelMutateAsyncMock: vi.fn(),
  deleteMutateAsyncMock: vi.fn(),
  errorToastMock: vi.fn(),
  authState: {
    user: { userId: 'user-1', isAdmin: false } as {
      userId: string;
      isAdmin: boolean;
    } | null,
  },
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: errorToastMock,
  },
}));

vi.mock('@/components/system', () => ({
  Button: ({
    children,
    asChild,
    ...props
  }: {
    children: ReactNode;
    asChild?: boolean;
  } & Record<string, unknown>) =>
    asChild ? (
      children
    ) : (
      <button type="button" {...props}>
        {children}
      </button>
    ),
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    className,
    variant,
  }: {
    children: ReactNode;
    onClick?: () => void;
    className?: string;
    variant?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={className}
      data-variant={variant}
    >
      {children}
    </button>
  ),
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  MoreVertical: () => <svg aria-hidden="true" />,
  Trash2: () => <svg aria-hidden="true" />,
  Pencil: () => <svg aria-hidden="true" />,
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: vi.fn(() => ({
    isSignedIn: !!authState.user,
    user: authState.user,
  })),
}));

vi.mock('@/hooks/tasks', () => ({
  useDeleteTasks: vi.fn(() => ({
    mutateAsync: deleteMutateAsyncMock,
    isPending: false,
  })),
  useTask: vi.fn(() => ({ data: null })),
}));

vi.mock('@/hooks/cloud-jobs', () => ({
  useCancelCloudJob: vi.fn(() => ({
    mutateAsync: cancelMutateAsyncMock,
    isPending: false,
  })),
}));

vi.mock('../hooks/use-preview-urls', () => ({
  usePreviewUrls: vi.fn(() => ({ previewUrls: null })),
}));

vi.mock('@/components/layout/side-nav/SideNavItem', () => ({
  SideNavItem: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

import { OverflowMenu } from './OverflowMenu';

function createCloudJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    actingUserId: 'user-1',
    status: 'running',
    machineId: 'machine-1',
    snapshotId: null,
    snapshotRequestedAt: null,
    sleepRequestedAt: null,
    snapshotCreatedAt: null,
    snapshotFailedAt: null,
    ...overrides,
  } as never;
}

describe('OverflowMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { userId: 'user-1', isAdmin: false };
    cancelMutateAsyncMock.mockResolvedValue({ success: true });
    deleteMutateAsyncMock.mockResolvedValue(undefined);
  });

  it('does not render when auth context is unavailable', () => {
    authState.user = null;

    const { container } = render(
      <OverflowMenu taskId="task-1" cloudJob={createCloudJob()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a destructive delete action without shutdown-related entries', () => {
    render(<OverflowMenu taskId="task-1" cloudJob={createCloudJob()} />);

    const deleteButton = screen.getByRole('button', { name: 'Delete' });

    expect(deleteButton).toHaveAttribute('data-variant', 'destructive');
    expect(
      screen.queryByRole('button', { name: 'Shutdown & Delete' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /shutdown/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /snapshot/i }),
    ).not.toBeInTheDocument();
  });

  it('keeps the delete confirmation action labeled delete', () => {
    render(<OverflowMenu taskId="task-1" cloudJob={createCloudJob()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(
      screen.getByText(/This will first shut down the task's machine/i),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: 'Shutdown & Delete' }),
    ).not.toBeInTheDocument();
  });

  it('targets the current cloud job when deleting a running task', async () => {
    render(<OverflowMenu taskId="task-1" cloudJob={createCloudJob()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!);
    });

    await vi.waitFor(() => {
      expect(cancelMutateAsyncMock).toHaveBeenCalledWith({
        taskId: 'task-1',
        cloudJobId: 123,
      });
    });
  });
});
