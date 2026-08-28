import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const {
  openCommandPaletteMock,
  queryOptionsMock,
  sessionsQueryOptionsMock,
  setSideNavExpandedMock,
  setTaskPinnedMock,
  useLiveTaskStatusMock,
  useQueryMock,
  state,
} = vi.hoisted(() => ({
  openCommandPaletteMock: vi.fn(),
  queryOptionsMock: vi.fn((input, options) => ({
    queryKind: 'tasksSearch',
    input,
    options,
  })),
  sessionsQueryOptionsMock: vi.fn((input, options) => ({
    queryKind: 'sessionsList',
    input,
    options,
  })),
  setSideNavExpandedMock: vi.fn(),
  setTaskPinnedMock: vi.fn(),
  useLiveTaskStatusMock: vi.fn<
    (taskId: string | null) => {
      phase: string | null;
      lastErrorMessage: string | undefined;
    } | null
  >(() => null),
  useQueryMock: vi.fn(),
  state: {
    pathname: '/tasks',
    user: { isAdmin: true },
    isSideNavExpanded: false,
    recentSessionIds: ['session-2', 'session-1'],
    pinnedTaskIds: ['task-3', 'task-1'],
    tasks: [
      { id: 'task-1', title: 'Task 1' },
      { id: 'task-2', title: 'Task 2' },
      { id: 'task-3', title: 'Task 3' },
    ],
    sessions: [
      { id: 'session-1', title: 'Session 1' },
      { id: 'session-2', title: 'Session 2' },
    ],
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
}));

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (previousData: unknown) => previousData,
  useQuery: (...args: unknown[]) => {
    useQueryMock(...args);
    const queryOptions = args[0] as { queryKind?: string } | undefined;

    if (queryOptions?.queryKind === 'sessionsList') {
      return { data: { sessions: state.sessions, nextCursor: null } };
    }

    return { data: state.tasks };
  },
}));

vi.mock('@/components/system', () => ({
  Button: ({
    children,
    className,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children: ReactNode;
    className?: string;
    onClick?: () => void;
    'aria-label'?: string;
  }) => (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {children}
    </button>
  ),
  ChartColumnIncreasing: () => <svg aria-hidden="true" />,
  ChevronDown: () => <svg aria-hidden="true" />,
  Container: () => <svg aria-hidden="true" />,
  GalleryVerticalEnd: () => <svg aria-hidden="true" />,
  House: () => <svg aria-hidden="true" />,
  Lightbulb: () => <svg aria-hidden="true" />,
  ListChevronsUpDown: () => <svg aria-hidden="true" />,
  MessageCircleQuestionMark: () => <svg aria-hidden="true" />,
  MessageSquarePlus: () => <svg aria-hidden="true" />,
  PanelLeftClose: () => <svg aria-hidden="true" />,
  PanelLeftOpen: () => <svg aria-hidden="true" />,
  Plus: () => <svg aria-hidden="true" />,
  Rows4: () => <svg aria-hidden="true" />,
  Search: () => <svg aria-hidden="true" />,
  Settings: () => <svg aria-hidden="true" />,
  Zap: () => <svg aria-hidden="true" />,
}));

vi.mock('@/components/layout', () => ({
  RoomoteWordmark: ({ 'aria-label': ariaLabel }: { 'aria-label'?: string }) => (
    <div role="img" aria-label={ariaLabel}>
      wordmark
    </div>
  ),
  UserMenu: () => <div data-testid="user-menu">user</div>,
  useChatWidgetButton: () => ({ isVisible: false, show: vi.fn() }),
}));

vi.mock('@/components/layout/ChatWidgetButton', () => ({
  ChatWidgetSideNavItem: () => null,
}));

vi.mock('@/components/layout/release-notices', () => ({
  ReleaseNoticeSideNavItem: () => null,
}));

vi.mock('@/components/layout/CommandPaletteContext', () => ({
  useCommandPalette: () => ({ setOpen: openCommandPaletteMock }),
}));

vi.mock('@/components/tasks/NewTaskDialog', () => ({
  NewTaskDialog: ({ open }: { open: boolean }) => (
    <div data-testid="new-task-dialog" data-open={String(open)} />
  ),
}));

vi.mock('@/hooks/useLayoutOptions', () => ({
  useHydrateLayoutStore: () => undefined,
  useLayoutStore: (
    selector: (layoutState: {
      hasHydrated: boolean;
      isSideNavExpanded: boolean;
      setSideNavExpanded: (expanded: boolean) => void;
    }) => unknown,
  ) =>
    selector({
      hasHydrated: true,
      isSideNavExpanded: state.isSideNavExpanded,
      setSideNavExpanded: setSideNavExpandedMock,
    }),
}));

vi.mock('@/hooks/useRecentSessions', () => ({
  useRecentSessions: () => ({ recentSessionIds: state.recentSessionIds }),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => state.user,
}));

vi.mock('@/hooks/tasks', () => ({
  useLiveTaskStatus: (taskId: string | null) => useLiveTaskStatusMock(taskId),
  useTaskPins: () => ({
    pinnedTaskIds: state.pinnedTaskIds,
    setTaskPinned: setTaskPinnedMock,
    isTaskPinMutationPending: () => false,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sessions: {
      list: { queryOptions: sessionsQueryOptionsMock },
    },
    tasks: {
      search: { queryOptions: queryOptionsMock },
    },
  }),
}));

vi.mock('./SideNavItem', () => ({
  SideNavItem: ({
    href,
    onClick,
    tooltip,
    expanded,
  }: {
    href?: string;
    onClick?: () => void;
    tooltip: string;
    expanded?: boolean;
  }) =>
    href ? (
      <div data-testid={`nav-${href}`} data-expanded={String(expanded)} />
    ) : (
      <button
        type="button"
        data-testid={`nav-action-${tooltip}`}
        data-expanded={String(expanded)}
        onClick={onClick}
      >
        {tooltip}
      </button>
    ),
}));

vi.mock('./SideNavTaskItem', () => ({
  SideNavTaskItem: ({
    task,
    liveStatus,
    isActive,
    isPinned,
    expanded,
    onTogglePin,
  }: {
    task: { id: string };
    liveStatus?: { phase: string | null; lastErrorMessage?: string };
    isActive: boolean;
    isPinned: boolean;
    expanded?: boolean;
    onTogglePin: (nextPinned: boolean) => void;
  }) => (
    <button
      type="button"
      data-testid={`task-item-${task.id}`}
      data-active={String(isActive)}
      data-expanded={String(expanded)}
      data-live-phase={liveStatus?.phase ?? ''}
      onClick={() => onTogglePin(!isPinned)}
    >
      {task.id}
    </button>
  ),
}));

vi.mock('./SideNavSessionItem', () => ({
  SideNavSessionItem: ({
    session,
    isActive,
  }: {
    session: { id: string };
    isActive: boolean;
  }) => (
    <a
      href={`/sessions/${session.id}`}
      data-testid={`session-item-${session.id}`}
      data-active={String(isActive)}
    >
      {session.id}
    </a>
  ),
}));

import {
  SideNav,
  getSessionIdFromPathname,
  getTaskIdFromPathname,
} from './SideNav';

describe('SideNav recent sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.pathname = '/tasks';
    state.user.isAdmin = true;
    state.isSideNavExpanded = false;
    state.recentSessionIds = ['session-2', 'session-1'];
    state.pinnedTaskIds = ['task-3', 'task-1'];
    state.tasks = [
      { id: 'task-1', title: 'Task 1' },
      { id: 'task-2', title: 'Task 2' },
      { id: 'task-3', title: 'Task 3' },
    ];
    state.sessions = [
      { id: 'session-1', title: 'Session 1' },
      { id: 'session-2', title: 'Session 2' },
    ];
    useLiveTaskStatusMock.mockReturnValue(null);
  });

  it('extracts task and session ids only from detail routes', () => {
    expect(getTaskIdFromPathname('/task/task-123/artifacts/file')).toBe(
      'task-123',
    );
    expect(getTaskIdFromPathname('/tasks')).toBeNull();
    expect(getSessionIdFromPathname('/sessions/session-123/details')).toBe(
      'session-123',
    );
    expect(getSessionIdFromPathname('/sessions')).toBeNull();
  });

  it('renders pinned tasks and recent sessions when expanded', () => {
    state.isSideNavExpanded = true;

    render(<SideNav />);

    expect(
      screen.getAllByTestId(/^task-item-/).map((item) => item.textContent),
    ).toEqual(['task-3', 'task-1']);
    expect(
      screen.getAllByTestId(/^session-item-/).map((item) => item.textContent),
    ).toEqual(['session-2', 'session-1']);
    expect(screen.getByText('Pinned tasks')).toBeInTheDocument();
    expect(screen.getByText('Recent sessions')).toBeInTheDocument();
    expect(screen.queryByText('Recent tasks')).not.toBeInTheDocument();
    expect(queryOptionsMock).toHaveBeenCalledWith(
      { limit: 2, includeIds: ['task-3', 'task-1'] },
      expect.objectContaining({ enabled: true }),
    );
    expect(sessionsQueryOptionsMock).toHaveBeenCalledWith(
      { ids: ['session-2', 'session-1'], limit: 20 },
      expect.objectContaining({ enabled: true }),
    );
  });

  it('keeps recent sessions in visit order and omits unavailable ids', () => {
    state.isSideNavExpanded = true;
    state.recentSessionIds = ['session-2', 'missing-session', 'session-1'];

    render(<SideNav />);

    const sessionItems = screen.getAllByTestId(/^session-item-/);
    expect(sessionItems.map((item) => item.textContent)).toEqual([
      'session-2',
      'session-1',
    ]);
    expect(sessionItems[0]).toHaveAttribute('href', '/sessions/session-2');
    expect(sessionItems[1]).toHaveAttribute('href', '/sessions/session-1');
  });

  it('marks the active session and active pinned task on detail subroutes', () => {
    state.isSideNavExpanded = true;
    state.pathname = '/sessions/session-2/details';
    const view = render(<SideNav />);

    expect(screen.getByTestId('session-item-session-2')).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(screen.getByTestId('session-item-session-1')).toHaveAttribute(
      'data-active',
      'false',
    );

    state.pathname = '/task/task-3/artifacts/file';
    view.rerender(<SideNav />);
    expect(screen.getByTestId('task-item-task-3')).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('keeps the recent items in the established scroll region', () => {
    state.isSideNavExpanded = true;

    render(<SideNav />);

    const scrollRegion = screen
      .getByTestId('session-item-session-2')
      .closest('.overflow-y-auto');
    expect(scrollRegion).toHaveClass('overflow-y-auto', 'scroll-thin');
    expect(scrollRegion?.parentElement?.parentElement).toHaveClass(
      'overflow-clip',
    );
  });

  it('does not query or render recent items while collapsed', () => {
    render(<SideNav />);

    expect(screen.queryByTestId(/^task-item-/)).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^session-item-/)).not.toBeInTheDocument();
    expect(queryOptionsMock).toHaveBeenCalledWith(
      { limit: 2, includeIds: ['task-3', 'task-1'] },
      expect.objectContaining({ enabled: false }),
    );
    expect(sessionsQueryOptionsMock).toHaveBeenCalledWith(
      { ids: ['session-2', 'session-1'], limit: 20 },
      expect.objectContaining({ enabled: false }),
    );
  });

  it('keeps the desktop-only responsive rail behavior', () => {
    render(<SideNav />);

    expect(screen.getByRole('navigation')).toHaveClass('hidden', 'md:flex');
  });

  it('preserves collapsed and expanded sidebar controls', () => {
    const view = render(<SideNav />);

    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    expect(setSideNavExpandedMock).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId('nav-action-Expand sidebar'));
    expect(setSideNavExpandedMock).toHaveBeenCalledWith(true);

    state.isSideNavExpanded = true;
    view.rerender(<SideNav />);
    fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
    expect(setSideNavExpandedMock).toHaveBeenCalledWith(false);
    expect(
      screen.queryByTestId('nav-action-Expand sidebar'),
    ).not.toBeInTheDocument();
  });

  it('keeps primary nav actions working', () => {
    render(<SideNav />);

    fireEvent.click(screen.getByTestId('nav-action-Search (⌘K)'));
    expect(openCommandPaletteMock).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByTestId('nav-action-New Session'));
    expect(screen.getByTestId('new-task-dialog')).toHaveAttribute(
      'data-open',
      'true',
    );
  });

  it('keeps the new session action above Home', () => {
    render(<SideNav />);

    const newSessionItem = screen.getByTestId('nav-action-New Session');
    const homeItem = screen.getByTestId('nav-/');
    expect(newSessionItem.compareDocumentPosition(homeItem)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('keeps analytics visible and Sessions before automations for admins', () => {
    render(<SideNav />);

    expect(screen.getByTestId('nav-/analytics')).toBeInTheDocument();
    const automations = screen.getByTestId('nav-/automations');
    const sessions = screen.getByTestId('nav-/sessions');
    expect(automations.compareDocumentPosition(sessions)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
  });

  it('preserves pinned-task actions and live status', () => {
    state.isSideNavExpanded = true;
    state.pathname = '/task/task-3';
    useLiveTaskStatusMock.mockReturnValue({
      phase: 'waiting_for_prompt',
      lastErrorMessage: undefined,
    });

    render(<SideNav />);

    expect(screen.getByTestId('task-item-task-3')).toHaveAttribute(
      'data-live-phase',
      'waiting_for_prompt',
    );
    expect(screen.getByTestId('task-item-task-1')).toHaveAttribute(
      'data-live-phase',
      '',
    );
    fireEvent.click(screen.getByTestId('task-item-task-3'));
    expect(setTaskPinnedMock).toHaveBeenCalledWith('task-3', false);
  });

  it('renders expanded navigation rows with their established expanded state', () => {
    state.isSideNavExpanded = true;

    render(<SideNav />);

    expect(screen.getByTestId('nav-/')).toHaveAttribute(
      'data-expanded',
      'true',
    );
    expect(screen.getByTestId('nav-action-Search (⌘K)')).toHaveAttribute(
      'data-expanded',
      'true',
    );
    expect(screen.getByTestId('task-item-task-3')).toHaveAttribute(
      'data-expanded',
      'true',
    );
  });

  it('keeps settings visible for members and automations admin-only', () => {
    state.user.isAdmin = false;

    render(<SideNav />);

    expect(screen.getByTestId('nav-/settings')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-/automations')).not.toBeInTheDocument();
  });
});
