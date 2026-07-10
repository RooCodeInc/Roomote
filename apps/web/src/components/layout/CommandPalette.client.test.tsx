import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const push = vi.fn();
const setOpen = vi.fn();
const action = vi.fn();
const queryOptions = vi.fn(() => ({}));
const useUserMock = vi.fn();

function Icon() {
  return <svg aria-hidden="true" />;
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: [
      {
        id: 'task-1',
        title: 'Most recent task',
        timestamp: 1,
        lastMessageAt: 1,
        taskRun: {
          payload: {
            environmentId: undefined,
            repo: undefined,
          },
        },
      },
    ],
  }),
}));

vi.mock('@/components/system', () => ({
  CommandDialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandEmpty: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({
    heading,
    children,
  }: {
    heading: string;
    children: React.ReactNode;
  }) => (
    <section>
      <h2>{heading}</h2>
      {children}
    </section>
  ),
  CommandItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  ChartColumnIncreasing: Icon,
  GalleryVerticalEnd: Icon,
  House: Icon,
  Lightbulb: Icon,
  Rows4: Icon,
  Ghost: Icon,
  Settings: Icon,
  HelpCircle: Icon,
  Plus: Icon,
}));

vi.mock('@/components/sandbox/WorkspaceBadge', () => ({
  WorkspaceBadge: () => <span>workspace</span>,
}));

vi.mock('@/lib/formatters', () => ({
  formatDistanceToNowCompact: () => '1m',
}));

vi.mock('@/hooks/useRecentTasks', () => ({
  useRecentTasks: () => ({ recentTaskIds: ['task-1'] }),
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => useUserMock(),
  useAuthorizedUser: () => {
    const result = useUserMock();

    if (!result.isSignedIn || !result.user) {
      throw new Error(
        'Cannot call useAuthorizedUser() from a non-authenticated component',
      );
    }

    return result.user;
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    tasks: {
      search: {
        queryOptions,
      },
    },
  }),
}));

vi.mock('./CommandPaletteContext', () => ({
  useCommandPalette: () => ({
    open: true,
    setOpen,
    commands: [
      {
        id: 'preview',
        icon: Icon,
        label: 'Preview',
        group: 'Task actions',
        action,
      },
    ],
  }),
}));

import { CommandPalette } from './CommandPalette';

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUserMock.mockReturnValue({
      isSignedIn: true,
      user: {
        featureFlags: {},
      },
    });
  });

  it('does not render or query when the user is signed out', () => {
    useUserMock.mockReturnValue({ isSignedIn: false, user: null });

    const { container } = render(<CommandPalette />);

    expect(container).toBeEmptyDOMElement();
    expect(queryOptions).not.toHaveBeenCalled();
  });

  it('renders sections and queries recent tasks with expected default filters', () => {
    render(<CommandPalette />);

    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Recent Tasks', 'Task actions', 'Navigate']);

    expect(queryOptions).toHaveBeenCalledWith(
      {
        query: undefined,
        limit: 5,
        includeIds: ['task-1'],
      },
      { enabled: true },
    );
  });

  it('navigates to a recent task and closes the palette on selection', () => {
    render(<CommandPalette />);

    fireEvent.click(screen.getByRole('button', { name: /Most recent task/i }));

    expect(setOpen).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith('/task/task-1');
  });

  it('runs custom command actions and closes the palette', () => {
    render(<CommandPalette />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(setOpen).toHaveBeenCalledWith(false);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('navigates using static navigation items', () => {
    render(<CommandPalette />);

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));

    expect(setOpen).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith('/tasks');
  });

  it('lists navigation items in the expected order', () => {
    render(<CommandPalette />);

    const navItems = screen
      .getAllByRole('button')
      .map((button) => button.textContent?.trim())
      .filter((label): label is string =>
        ['New Task', 'Tasks', 'Analytics', 'Settings', 'Help'].includes(
          label ?? '',
        ),
      );

    expect(navItems).toEqual([
      'New Task',
      'Tasks',
      'Analytics',
      'Settings',
      'Help',
    ]);
  });
});
