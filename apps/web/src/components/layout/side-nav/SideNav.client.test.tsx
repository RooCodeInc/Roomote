import { fireEvent, render, screen, within } from '@testing-library/react';
import { createContext, useContext, useState, type ReactNode } from 'react';

const CollapsibleContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

const {
  queryOptionsMock,
  environmentNamesQueryOptionsMock,
  setTaskPinnedMock,
  setSideNavExpandedMock,
  openCommandPaletteMock,
  useQueryMock,
  useLiveTaskStatusMock,
  isTaskPinMutationPendingMock,
  makeSearchTasks,
  state,
} = vi.hoisted(() => {
  const makeSearchTasks = (
    overrides: Record<
      string,
      Partial<{
        title: string;
        timestamp: number;
        lastMessageAt: number;
        taskRun: {
          payload: { environmentId: string; repo: string };
        };
      }>
    > = {},
  ) =>
    [
      {
        id: 'task-1',
        title: 'Task 1',
        timestamp: 6,
        lastMessageAt: 6,
        taskRun: { payload: { environmentId: 'env-1', repo: 'org/repo-1' } },
      },
      {
        id: 'task-2',
        title: 'Task 2',
        timestamp: 5,
        lastMessageAt: 5,
        taskRun: { payload: { environmentId: 'env-2', repo: 'org/repo-2' } },
      },
      {
        id: 'task-3',
        title: 'Task 3',
        timestamp: 4,
        lastMessageAt: 4,
        taskRun: { payload: { environmentId: 'env-3', repo: 'org/repo-3' } },
      },
      {
        id: 'task-4',
        title: 'Task 4',
        timestamp: 3,
        lastMessageAt: 3,
        taskRun: { payload: { environmentId: 'env-4', repo: 'org/repo-4' } },
      },
      {
        id: 'task-5',
        title: 'Task 5',
        timestamp: 2,
        lastMessageAt: 2,
        taskRun: { payload: { environmentId: 'env-5', repo: 'org/repo-5' } },
      },
      {
        id: 'task-6',
        title: 'Task 6',
        timestamp: 1,
        lastMessageAt: 1,
        taskRun: { payload: { environmentId: 'env-6', repo: 'org/repo-6' } },
      },
    ].map((task) => ({ ...task, ...(overrides[task.id] ?? {}) }));

  return {
    queryOptionsMock: vi.fn((input, options) => ({
      queryKind: 'tasksSearch',
      input,
      options,
    })),
    environmentNamesQueryOptionsMock: vi.fn((input, options) => ({
      queryKind: 'environmentNames',
      input,
      options,
    })),
    setTaskPinnedMock: vi.fn(),
    setSideNavExpandedMock: vi.fn(),
    openCommandPaletteMock: vi.fn(),
    useQueryMock: vi.fn(),
    useLiveTaskStatusMock: vi.fn<
      (taskId: string | null) => {
        phase: string | null;
        lastErrorMessage: string | undefined;
      } | null
    >(() => null),
    isTaskPinMutationPendingMock: vi.fn(() => false),
    makeSearchTasks,
    state: {
      pathname: '/tasks',
      user: {
        isAdmin: true,
        featureFlags: {},
      },
      isSideNavExpanded: false,
      recentTaskIds: ['task-2', 'task-3', 'task-4', 'task-5'],
      pinnedTaskIds: ['task-3', 'task-1'],
      environments: [
        { id: 'env-1', name: 'Environment 1' },
        { id: 'env-2', name: 'Environment 2' },
        { id: 'env-3', name: 'Environment 3' },
        { id: 'env-4', name: 'Environment 4' },
        { id: 'env-5', name: 'Environment 5' },
        { id: 'env-6', name: 'Environment 6' },
      ],
      searchTasks: makeSearchTasks(),
    },
  };
});

vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => state.user,
}));

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (previousData: unknown) => previousData,
  useQuery: (...args: unknown[]) => {
    useQueryMock(...args);
    const queryOptions = args[0] as
      | { queryKind?: string; input?: { ids?: string[] } }
      | undefined;

    if (queryOptions?.queryKind === 'environmentNames') {
      const ids = new Set(queryOptions.input?.ids ?? []);

      return {
        data: state.environments.filter((environment) =>
          ids.has(environment.id),
        ),
      };
    }

    return { data: state.searchTasks };
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
  Collapsible: ({
    children,
    defaultOpen,
  }: {
    children: ReactNode;
    defaultOpen?: boolean;
  }) => {
    const [open, setOpen] = useState(Boolean(defaultOpen));

    return (
      <CollapsibleContext.Provider value={{ open, setOpen }}>
        <div data-state={open ? 'open' : 'closed'}>{children}</div>
      </CollapsibleContext.Provider>
    );
  },
  CollapsibleContent: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => {
    const context = useContext(CollapsibleContext);

    if (!context?.open) {
      return null;
    }

    return <div className={className}>{children}</div>;
  },
  CollapsibleTrigger: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => {
    const context = useContext(CollapsibleContext);

    if (!context) {
      return null;
    }

    return (
      <button
        type="button"
        className={className}
        data-state={context.open ? 'open' : 'closed'}
        onClick={() => context.setOpen(!context.open)}
      >
        {children}
      </button>
    );
  },
  CollapsibleIconTrigger: ({ icon: Icon }: { icon: () => ReactNode }) => (
    <Icon />
  ),
  Container: () => <svg aria-hidden="true" />,
  GalleryVerticalEnd: () => <svg aria-hidden="true" />,
  House: () => <svg aria-hidden="true" />,
  Lightbulb: () => <svg aria-hidden="true" />,
  ListChevronsUpDown: () => <svg aria-hidden="true" />,
  MessageSquarePlus: () => <svg aria-hidden="true" />,
  MessageCircleQuestionMark: () => <svg aria-hidden="true" />,
  Rows4: () => <svg aria-hidden="true" />,
  Settings: () => <svg aria-hidden="true" />,
  Search: () => <svg aria-hidden="true" />,
  PanelLeftClose: () => <svg aria-hidden="true" />,
  PanelLeftOpen: () => <svg aria-hidden="true" />,
  VectorSquare: () => <svg aria-hidden="true" />,
  Zap: () => <svg aria-hidden="true" />,
}));

vi.mock('@/components/layout', () => ({
  useChatWidgetButton: () => ({ isVisible: false, show: vi.fn() }),
  Logo: () => <div>logo</div>,
  RoomoteWordmark: ({
    className,
    'aria-label': ariaLabel,
  }: {
    className?: string;
    'aria-label'?: string;
  }) => (
    <div role="img" aria-label={ariaLabel} data-class-name={className}>
      wordmark
    </div>
  ),
  UserMenu: () => <div data-testid="user-menu">user</div>,
}));

vi.mock('@/components/layout/CommandPaletteContext', () => ({
  useCommandPalette: () => ({ setOpen: openCommandPaletteMock }),
}));

vi.mock('@/hooks/useRecentTasks', () => ({
  useRecentTasks: () => ({ recentTaskIds: state.recentTaskIds }),
}));

vi.mock('@/hooks/environments', () => ({
  useEnvironments: () => ({ data: state.environments }),
}));

vi.mock('@/hooks/useLayoutOptions', () => ({
  useHydrateLayoutStore: () => undefined,
  useLayoutStore: (
    selector: (state: {
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

vi.mock('@/hooks/tasks', () => ({
  useLiveTaskStatus: (taskId: string | null) => useLiveTaskStatusMock(taskId),
  useTaskPins: () => ({
    pinnedTaskIds: state.pinnedTaskIds,
    setTaskPinned: setTaskPinnedMock,
    isTaskPinMutationPending: isTaskPinMutationPendingMock,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    environments: {
      namesByIds: {
        queryOptions: environmentNamesQueryOptionsMock,
      },
    },
    tasks: {
      search: {
        queryOptions: queryOptionsMock,
      },
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
      data-pinned={String(isPinned)}
      data-expanded={String(expanded)}
      data-live-phase={liveStatus?.phase ?? ''}
      onClick={() => onTogglePin(!isPinned)}
    >
      {task.id}
    </button>
  ),
}));

import { SideNav, getTaskIdFromPathname } from './SideNav';

describe('SideNav quick access tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.pathname = '/tasks';
    state.user = {
      isAdmin: true,
      featureFlags: {},
    };
    state.isSideNavExpanded = false;
    state.recentTaskIds = ['task-2', 'task-3', 'task-4', 'task-5'];
    state.pinnedTaskIds = ['task-3', 'task-1'];
    state.environments = [
      { id: 'env-1', name: 'Environment 1' },
      { id: 'env-2', name: 'Environment 2' },
      { id: 'env-3', name: 'Environment 3' },
      { id: 'env-4', name: 'Environment 4' },
      { id: 'env-5', name: 'Environment 5' },
      { id: 'env-6', name: 'Environment 6' },
    ];
    state.searchTasks = makeSearchTasks();
    useLiveTaskStatusMock.mockReturnValue(null);
  });

  it('extracts task id from task routes and subroutes', () => {
    expect(getTaskIdFromPathname('/task/task-123')).toBe('task-123');
    expect(getTaskIdFromPathname('/task/task-123/artifacts/path/to/file')).toBe(
      'task-123',
    );
    expect(getTaskIdFromPathname('/tasks')).toBeNull();
  });

  it('renders pinned-first quick access list when expanded, up to the wider cap', () => {
    state.isSideNavExpanded = true;
    state.recentTaskIds = [
      'task-2',
      'task-3',
      'task-4',
      'task-5',
      'task-6',
      'task-7',
      'task-8',
    ];
    state.searchTasks = [
      ...makeSearchTasks(),
      {
        id: 'task-7',
        title: 'Task 7',
        timestamp: 0,
        lastMessageAt: 0,
        taskRun: { payload: { environmentId: 'env-7', repo: 'org/repo-7' } },
      },
      {
        id: 'task-8',
        title: 'Task 8',
        timestamp: -1,
        lastMessageAt: -1,
        taskRun: { payload: { environmentId: 'env-8', repo: 'org/repo-8' } },
      },
    ];

    render(<SideNav />);

    const renderedTaskIds = screen
      .getAllByTestId(/^task-item-/)
      .map((item) => item.textContent);

    expect(renderedTaskIds).toEqual([
      'task-3',
      'task-1',
      'task-2',
      'task-4',
      'task-5',
      'task-6',
      'task-7',
      'task-8',
    ]);

    expect(queryOptionsMock).toHaveBeenCalledWith(
      {
        limit: 20,
        includeIds: [
          'task-3',
          'task-1',
          'task-2',
          'task-4',
          'task-5',
          'task-6',
          'task-7',
          'task-8',
        ],
      },
      expect.objectContaining({
        enabled: true,
        placeholderData: expect.any(Function),
      }),
    );
    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });

  it('marks the active quick access task for task subroutes', () => {
    state.isSideNavExpanded = true;
    state.pathname = '/task/task-4/artifacts/plans/spec.md';

    render(<SideNav />);

    expect(screen.getByTestId('task-item-task-4')).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(screen.getByTestId('task-item-task-3')).toHaveAttribute(
      'data-active',
      'false',
    );
  });

  it('renders the settings nav item for members', () => {
    state.user.isAdmin = false;

    render(<SideNav />);

    expect(screen.getByTestId('nav-/settings')).toBeInTheDocument();
  });

  it('keeps analytics visible without feature gating', () => {
    render(<SideNav />);

    expect(screen.getByTestId('nav-/analytics')).toBeInTheDocument();
  });

  it('shows automations before task history for admins', () => {
    render(<SideNav />);

    const automations = screen.getByTestId('nav-/automations');
    const tasks = screen.getByTestId('nav-/tasks');

    expect(automations.compareDocumentPosition(tasks)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('hides automations from non-admins', () => {
    state.user.isAdmin = false;

    render(<SideNav />);

    expect(screen.queryByTestId('nav-/automations')).not.toBeInTheDocument();
  });

  it('routes pin toggles to the task pin mutation hook', () => {
    state.isSideNavExpanded = true;

    render(<SideNav />);

    fireEvent.click(screen.getByTestId('task-item-task-3'));
    fireEvent.click(screen.getByTestId('task-item-task-2'));

    expect(setTaskPinnedMock).toHaveBeenNthCalledWith(1, 'task-3', false);
    expect(setTaskPinnedMock).toHaveBeenNthCalledWith(2, 'task-2', true);
  });

  it('orders non-pinned quick access tasks by last activity, not visit order', () => {
    state.isSideNavExpanded = true;
    state.pinnedTaskIds = [];
    state.recentTaskIds = ['task-5', 'task-2', 'task-4'];
    state.searchTasks = makeSearchTasks({
      'task-2': { timestamp: 2, lastMessageAt: 6 },
      'task-4': { timestamp: 4, lastMessageAt: 5 },
      'task-5': { timestamp: 6, lastMessageAt: 4 },
    });

    render(<SideNav />);

    const renderedTaskIds = screen
      .getAllByTestId(/^task-item-/)
      .map((item) => item.textContent);

    expect(renderedTaskIds).toEqual([
      'task-2',
      'task-1',
      'task-4',
      'task-5',
      'task-3',
      'task-6',
    ]);
  });

  it('groups recent tasks under collapsible environment sections', () => {
    state.isSideNavExpanded = true;
    state.pinnedTaskIds = [];
    state.recentTaskIds = ['task-2', 'task-4', 'task-5'];
    state.searchTasks = makeSearchTasks({
      'task-1': {
        timestamp: 6,
        lastMessageAt: 6,
        taskRun: { payload: { environmentId: 'env-1', repo: 'org/repo-1' } },
      },
      'task-2': {
        timestamp: 5,
        lastMessageAt: 5,
        taskRun: { payload: { environmentId: 'env-1', repo: 'org/repo-2' } },
      },
      'task-4': {
        timestamp: 4,
        lastMessageAt: 4,
        taskRun: { payload: { environmentId: 'env-2', repo: 'org/repo-4' } },
      },
      'task-5': {
        timestamp: 3,
        lastMessageAt: 3,
        taskRun: { payload: { environmentId: 'env-2', repo: 'org/repo-5' } },
      },
      'task-3': {
        timestamp: 2,
        lastMessageAt: 2,
        taskRun: { payload: { environmentId: 'env-3', repo: 'org/repo-3' } },
      },
      'task-6': {
        timestamp: 1,
        lastMessageAt: 1,
        taskRun: { payload: { environmentId: 'env-3', repo: 'org/repo-6' } },
      },
    });
    state.environments = [
      { id: 'env-1', name: 'Maxolen Staging' },
      { id: 'env-2', name: 'CC Environment' },
      { id: 'env-3', name: 'Roomote Dev' },
    ];

    render(<SideNav />);

    const groupButtons = screen.getAllByRole('button', {
      name: /Maxolen Staging|CC Environment|Roomote Dev/,
    });

    expect(groupButtons.map((button) => button.textContent)).toEqual([
      'Maxolen Staging',
      'CC Environment',
      'Roomote Dev',
    ]);
    expect(environmentNamesQueryOptionsMock).toHaveBeenCalledWith(
      { ids: ['env-1', 'env-2', 'env-3'] },
      expect.objectContaining({
        enabled: true,
        placeholderData: expect.any(Function),
      }),
    );

    const maxolenGroup = groupButtons[0]?.parentElement;
    expect(maxolenGroup).not.toBeNull();
    expect(
      within(maxolenGroup as HTMLElement)
        .getAllByTestId(/^task-item-/)
        .map((item) => item.textContent),
    ).toEqual(['task-1', 'task-2']);
  });

  it('uses distinct fallback labels while environment names are unavailable', () => {
    state.isSideNavExpanded = true;
    state.pinnedTaskIds = [];
    state.searchTasks = makeSearchTasks({
      'task-1': {
        taskRun: { payload: { environmentId: 'env-1', repo: 'org/repo-1' } },
      },
      'task-2': {
        taskRun: { payload: { environmentId: 'env-1', repo: 'org/repo-2' } },
      },
      'task-3': {
        taskRun: { payload: { environmentId: 'env-2', repo: 'org/repo-3' } },
      },
      'task-4': {
        taskRun: { payload: { environmentId: 'env-3', repo: 'org/repo-4' } },
      },
    });
    state.environments = [];

    render(<SideNav />);

    const groupButtons = screen.getAllByRole('button', {
      name: /Environment env-/,
    });

    expect(groupButtons.map((button) => button.textContent)).toEqual([
      'Environment env-1',
      'Environment env-2',
      'Environment env-3',
      'Environment env-5',
      'Environment env-6',
    ]);
  });

  it('collapses an environment section without affecting other groups', () => {
    state.isSideNavExpanded = true;
    state.pinnedTaskIds = [];
    state.searchTasks = makeSearchTasks({
      'task-1': {
        taskRun: { payload: { environmentId: 'env-1', repo: 'org/repo-1' } },
      },
      'task-2': {
        taskRun: { payload: { environmentId: 'env-1', repo: 'org/repo-2' } },
      },
      'task-3': {
        taskRun: { payload: { environmentId: 'env-2', repo: 'org/repo-3' } },
      },
      'task-4': {
        taskRun: { payload: { environmentId: 'env-2', repo: 'org/repo-4' } },
      },
    });
    state.environments = [
      { id: 'env-1', name: 'Maxolen Staging' },
      { id: 'env-2', name: 'CC Environment' },
      { id: 'env-3', name: 'Roomote Dev' },
      { id: 'env-4', name: 'Sandbox' },
      { id: 'env-5', name: 'QA' },
      { id: 'env-6', name: 'Prod' },
    ];

    render(<SideNav />);

    fireEvent.click(screen.getByRole('button', { name: /Maxolen Staging/i }));

    expect(screen.queryByTestId('task-item-task-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-item-task-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('task-item-task-3')).toBeInTheDocument();
    expect(screen.getByTestId('task-item-task-4')).toBeInTheDocument();
  });

  it('passes live status only to the active task item', () => {
    state.isSideNavExpanded = true;
    state.pathname = '/task/task-4';
    useLiveTaskStatusMock.mockReturnValue({
      phase: 'waiting_for_prompt',
      lastErrorMessage: undefined,
    });

    render(<SideNav />);

    expect(screen.getByTestId('task-item-task-4')).toHaveAttribute(
      'data-live-phase',
      'waiting_for_prompt',
    );
    expect(screen.getByTestId('task-item-task-3')).toHaveAttribute(
      'data-live-phase',
      '',
    );
  });

  it('renders quick access tasks inside a scrollable region when expanded', () => {
    state.isSideNavExpanded = true;

    render(<SideNav />);

    expect(
      screen.getByTestId('task-item-task-3').parentElement?.parentElement,
    ).toHaveClass('overflow-y-auto', 'scroll-thin');
  });

  it('opens the expanded side nav from the collapsed header control', () => {
    render(<SideNav />);

    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));

    expect(setSideNavExpandedMock).toHaveBeenCalledWith(true);
  });

  it('opens the command palette from the unified search nav item', () => {
    render(<SideNav />);

    fireEvent.click(screen.getByTestId('nav-action-Search (⌘K)'));

    expect(openCommandPaletteMock).toHaveBeenCalledWith(true);
  });

  it('shows the collapsed-only task list affordance after search and expands the sidebar', () => {
    render(<SideNav />);

    const searchItem = screen.getByTestId('nav-action-Search (⌘K)');
    const expandItem = screen.getByTestId('nav-action-Expand sidebar');

    expect(searchItem.compareDocumentPosition(expandItem)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(expandItem);

    expect(setSideNavExpandedMock).toHaveBeenCalledWith(true);
  });

  it('hides the collapsed-only task list affordance when expanded', () => {
    state.isSideNavExpanded = true;

    render(<SideNav />);

    expect(
      screen.queryByTestId('nav-action-Expand sidebar'),
    ).not.toBeInTheDocument();
  });

  it('renders expanded nav rows and closes through the header control', () => {
    state.isSideNavExpanded = true;

    render(<SideNav />);

    expect(screen.getByRole('img', { name: 'Roomote' })).toHaveTextContent(
      'wordmark',
    );
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

    fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));

    expect(setSideNavExpandedMock).toHaveBeenCalledWith(false);
  });

  it('keeps the collapsed nav free of quick access tasks', () => {
    render(<SideNav />);

    expect(screen.queryByTestId('task-item-task-1')).not.toBeInTheDocument();
    expect(queryOptionsMock).toHaveBeenCalledWith(
      {
        limit: 20,
        includeIds: ['task-3', 'task-1', 'task-2', 'task-4', 'task-5'],
      },
      expect.objectContaining({
        enabled: false,
        placeholderData: expect.any(Function),
      }),
    );
  });
});
