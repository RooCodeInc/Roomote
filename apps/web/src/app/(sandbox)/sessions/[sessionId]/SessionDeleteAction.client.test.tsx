import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  stop: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sessions: {
      stopTasks: {
        mutationOptions: (options: object) => ({ ...options, kind: 'stop' }),
      },
      archive: {
        mutationOptions: (options: object) => ({ ...options, kind: 'archive' }),
      },
      delete: {
        mutationOptions: (options: object) => ({ ...options, kind: 'delete' }),
      },
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: {
    kind: 'stop' | 'archive' | 'delete';
    onSuccess: (result: unknown) => void;
  }) => ({
    isPending: false,
    mutate: (input: unknown) => {
      mocks[options.kind === 'delete' ? 'remove' : options.kind](input);
      options.onSuccess(
        options.kind === 'stop'
          ? { success: true, stoppedCount: 2 }
          : options.kind === 'archive'
            ? { id: 'session-1' }
            : { deleted: true },
      );
    },
  }),
}));
vi.mock('@/components/layout/side-nav/SideNavItem', () => ({
  SideNavItem: ({ children }: { children: ReactNode }) => (
    <button type="button" aria-label="More actions">
      {children}
    </button>
  ),
}));
vi.mock('@/components/system', () => ({
  Archive: () => <svg data-icon="archive" />,
  Square: () => <svg data-icon="square" />,
  Trash2: () => <svg data-icon="trash" />,
  MoreVertical: () => <svg />,
  Button: ({
    children,
    asChild: _asChild,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children: ReactNode;
    asChild?: boolean;
    variant?: string;
    size?: string;
  }) => (
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
    variant,
    ...props
  }: {
    children: ReactNode;
    variant?: string;
  }) => (
    <button type="button" data-variant={variant} {...props}>
      {children}
    </button>
  ),
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
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
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

import {
  SESSION_DELETION_DESCRIPTION,
  SessionActions,
} from './SessionDeleteAction';

describe('SessionActions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('orders stop and archive above destructive delete and runs them without confirmation', () => {
    render(<SessionActions sessionId="session-1" />);

    const labels = screen
      .getAllByRole('button')
      .map((button) => button.textContent?.trim())
      .filter(Boolean);
    expect(labels).toEqual(['Stop tasks', 'Archive session', 'Delete session']);
    expect(screen.getByText('Stop tasks').closest('button')).toContainElement(
      document.querySelector('[data-icon="square"]'),
    );
    expect(
      screen.getByText('Archive session').closest('button'),
    ).toContainElement(document.querySelector('[data-icon="archive"]'));
    expect(
      screen.getByText('Delete session').closest('button'),
    ).toHaveAttribute('data-variant', 'destructive');

    fireEvent.click(screen.getByText('Stop tasks'));
    expect(mocks.stop).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Archive session'));
    expect(mocks.archive).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(mocks.push).toHaveBeenCalledWith('/sessions');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('keeps the delete confirmation and isolates the list-row trigger', () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <SessionActions sessionId="session-1" listRow />
      </div>,
    );

    const trigger = screen.getByRole('button', {
      name: 'More session actions',
    });
    expect(fireEvent.pointerDown(trigger)).toBe(true);
    fireEvent.click(trigger);
    expect(parentClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Delete session'));
    expect(screen.getByRole('heading')).toHaveTextContent(
      'Delete this session?',
    );
    expect(screen.getByText(SESSION_DELETION_DESCRIPTION)).toBeInTheDocument();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
