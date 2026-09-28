import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  stop: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  setStatus: vi.fn(),
  invalidateQueries: vi.fn(),
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
      setStatus: {
        mutationOptions: (options: object) => ({ ...options, kind: 'status' }),
      },
      byId: { queryKey: (input: unknown) => ['sessions', 'byId', input] },
      list: { queryKey: () => ['sessions', 'list'] },
      search: { queryKey: () => ['sessions', 'search'] },
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: {
    kind: 'stop' | 'archive' | 'delete' | 'status';
    onSuccess: (result: unknown, variables?: unknown) => void;
  }) => ({
    isPending: false,
    mutate: (input: unknown) => {
      if (options.kind === 'status') {
        mocks.setStatus(input);
      } else {
        mocks[options.kind === 'delete' ? 'remove' : options.kind](input);
      }
      options.onSuccess(
        options.kind === 'stop'
          ? { success: true, stoppedCount: 2 }
          : options.kind === 'archive'
            ? { id: 'session-1' }
            : options.kind === 'delete'
              ? { deleted: true }
              : {
                  id: 'session-1',
                  cachedStatus: (input as { status: string }).status,
                },
        input,
      );
    },
  }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock('@/components/layout/side-nav/SideNavItem', () => ({
  SideNavItem: ({ children }: { children: ReactNode }) => (
    <button type="button" aria-label="More actions">
      {children}
    </button>
  ),
}));
vi.mock('@/components/system', () => ({
  Activity: () => <svg data-icon="activity" />,
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
  DropdownMenuSub: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="session-status-submenu">{children}</div>
  ),
  DropdownMenuRadioGroup: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange?: (value: string) => void;
  }) => (
    <div>
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child, { onValueChange } as never)
          : child,
      )}
    </div>
  ),
  DropdownMenuRadioItem: ({
    children,
    disabled,
    onValueChange,
    value,
    ...props
  }: {
    children: ReactNode;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
    value: string;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onValueChange?.(value)}
      {...props}
    >
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

  it('gates the status submenu and keeps canonical order with the current status selected', () => {
    const { rerender } = render(
      <SessionActions sessionId="session-1" status="blocked" />,
    );
    expect(screen.queryByText('Mark session as...')).not.toBeInTheDocument();

    rerender(
      <SessionActions
        sessionId="session-1"
        status="blocked"
        sessionStatusExperimentEnabled
      />,
    );

    const submenu = screen.getByTestId('session-status-submenu');
    expect(
      Array.from(submenu.querySelectorAll('button')).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(['active', 'needs input', 'blocked', 'ready']);
    expect(screen.getByRole('button', { name: 'blocked' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    expect(mocks.setStatus).toHaveBeenCalledWith({
      sessionId: 'session-1',
      status: 'active',
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['sessions', 'byId', { sessionId: 'session-1' }],
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['sessions', 'list'],
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['sessions', 'search'],
    });
    expect(mocks.refresh).toHaveBeenCalled();
  });
});
