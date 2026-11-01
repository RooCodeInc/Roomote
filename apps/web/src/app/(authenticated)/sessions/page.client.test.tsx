import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

const { getSessionsMock, sessionStatusState, remove, refresh, push } =
  vi.hoisted(() => ({
    remove: vi.fn(),
    refresh: vi.fn(),
    push: vi.fn(),
    getSessionsMock: vi.fn(),
    sessionStatusState: {
      current: ['active', 'needs_input', 'blocked', 'ready', 'done'] as Array<
        'active' | 'needs_input' | 'blocked' | 'ready' | 'done'
      >,
    },
  }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useRouter: () => ({ replace: vi.fn(), refresh, push }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({ sessions: { delete: { mutationOptions: () => ({}) } } }),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: remove }),
}));
vi.mock(
  '../../(sandbox)/sessions/[sessionId]/SessionDeleteAction',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    SessionActions: () => (
      <button type="button" aria-label="More session actions" />
    ),
  }),
);

vi.mock('@/components/sessions/use-session-status-mutation', () => ({
  useSessionStatusMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));

import SessionsPage from './page';

vi.mock('@/lib/server/auth-context', () => ({
  authorize: vi.fn().mockResolvedValue({ success: true, userId: 'user-1' }),
}));
vi.mock('./SessionsFilters', () => ({ SessionsFilters: () => null }));
vi.mock('@/lib/server/sessions', () => ({
  getSessionSources: vi.fn().mockResolvedValue([]),
  getSessions: getSessionsMock.mockImplementation(async () => ({
    sessions: sessionStatusState.current.map((status) => ({
      id: status ?? 'ready',
      title: `Review ${status ?? 'ready'} ${'long-unbroken-title'.repeat(20)}`,
      ownerKind: 'user',
      ownerAutomation: null,
      ownerName: 'Long display name '.repeat(10),
      ownerEmail: 'test@example.com',
      ownerImageUrl: null,
      ownerUserId: 'user-1',
      canManage: status !== 'blocked',
      privacy: 'shared',
      sourceSurface: 'web',
      activityAt: 1_788_000_000,
      cachedStatus: status === 'done' ? 'ready' : status,
      judgedStatus: status === 'done' ? 'done' : null,
      executionCount: 0,
      inferenceCostMicroUsd: 0,
      directInferenceCostMicroUsd: 0,
      unread: false,
      artifactCount: 0,
      singleArtifact: null,
      pullRequests: [1, 2, 3].map((number) => ({
        repository: `example/${'long-repository-name'.repeat(10)}`,
        number,
        url: `https://github.com/example/repo/pull/${number}`,
      })),
      tasks: [],
    })),
    nextCursor: 'older-cursor',
  })),
}));

describe('Sessions list', () => {
  beforeEach(() => {
    getSessionsMock.mockClear();
    remove.mockReset().mockResolvedValue({ deleted: true });
    sessionStatusState.current = [
      'active',
      'needs_input',
      'blocked',
      'ready',
      'done',
    ];
  });

  it.each(['list', 'board'])(
    'supports individual and page-wide selection without navigation or dragging in %s view',
    async (view) => {
      const { container } = render(
        await SessionsPage({ searchParams: Promise.resolve({ view }) }),
      );
      const sessionLink = screen.getByRole('link', { name: /^Review active/ });
      expect(sessionLink).toHaveAttribute('href', '/sessions/active');
      fireEvent.click(screen.getByRole('button', { name: 'Select sessions' }));
      expect(
        screen.queryByRole('link', { name: /^Review active/ }),
      ).not.toBeInTheDocument();
      expect(
        container.querySelector('[data-session-board-drag-activator]'),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole('button', { name: /^Select session: Review active/ }),
      );
      expect(
        screen.getByRole('checkbox', { name: /^Select Review active/ }),
      ).toBeChecked();
      expect(
        screen.getByRole('checkbox', {
          name: 'Select all sessions on this page',
        }),
      ).toBePartiallyChecked();
      expect(
        screen.getByRole('checkbox', { name: /^Select Review blocked/ }),
      ).toBeDisabled();
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: 'Select all sessions on this page',
        }),
      );
      expect(screen.getByRole('button', { name: 'Delete (4)' })).toBeEnabled();
      expect(
        screen.getByRole('checkbox', {
          name: 'Select all sessions on this page',
        }),
      ).toBeChecked();
      fireEvent.click(
        screen.getByRole('checkbox', { name: /^Select Review ready/ }),
      );
      expect(screen.getByRole('button', { name: 'Delete (3)' })).toBeEnabled();
      expect(push).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole('button', { name: 'Exit selection mode' }),
      );
      expect(
        screen.getByRole('link', { name: /^Review active/ }),
      ).toHaveAttribute('href', '/sessions/active');
      fireEvent.click(screen.getByRole('button', { name: 'Select sessions' }));
      expect(screen.getByRole('button', { name: 'Delete (0)' })).toBeDisabled();
    },
  );

  it.each(['list', 'board'])(
    'confirms bulk deletion and refreshes the current %s view without redirecting',
    async (view) => {
      render(
        await SessionsPage({
          searchParams: Promise.resolve({
            view,
            user: 'user-1',
            before: 'cursor',
          }),
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Select sessions' }));
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: 'Select all sessions on this page',
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Delete (4)' }));
      expect(remove).not.toHaveBeenCalled();
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Cancel',
        }),
      );
      expect(screen.getByRole('button', { name: 'Delete (4)' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Delete (4)' }));
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Delete (4)',
        }),
      );
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      expect(remove.mock.calls.map(([input]) => input.sessionId)).toEqual([
        'active',
        'needs_input',
        'ready',
        'done',
      ]);
      expect(push).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Select sessions' }),
      ).toBeEnabled();
    },
  );

  it('keeps only failed deletions selected, including rejected requests, and permits retry', async () => {
    remove
      .mockResolvedValueOnce({ deleted: true })
      .mockResolvedValueOnce({ deleted: false, reason: 'session_busy' })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ deleted: true });
    render(await SessionsPage({ searchParams: Promise.resolve({}) }));
    fireEvent.click(screen.getByRole('button', { name: 'Select sessions' }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Select all sessions on this page',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete (4)' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Delete (4)',
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(
      screen.getByRole('checkbox', { name: /^Select Review needs_input/ }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /^Select Review ready/ }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /^Select Review active/ }),
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Delete (2)' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete (2)' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Delete (2)',
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(
      remove.mock.calls.slice(4).map(([input]) => input.sessionId),
    ).toEqual(['needs_input', 'ready']);
  });

  it.each(['list', 'board'])(
    'locks selection while deleting a single selected session in %s view',
    async (view) => {
      let finish!: (result: { deleted: boolean }) => void;
      remove.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      render(await SessionsPage({ searchParams: Promise.resolve({ view }) }));
      fireEvent.click(screen.getByRole('button', { name: 'Select sessions' }));
      fireEvent.click(
        screen.getByRole('checkbox', { name: /^Select Review active/ }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Delete (1)' }));
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Delete (1)',
        }),
      );
      expect(
        screen.getByRole('button', { name: 'Deleting...' }),
      ).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
      expect(
        screen.getByRole('checkbox', {
          name: 'Select all sessions on this page',
          hidden: true,
        }),
      ).toBeDisabled();
      expect(remove).toHaveBeenCalledOnce();
      await act(async () => finish({ deleted: true }));
      expect(refresh).toHaveBeenCalledOnce();
      expect(push).not.toHaveBeenCalled();
      expect(
        screen.getByRole('button', { name: 'Select sessions' }),
      ).toBeEnabled();
    },
  );

  it('prunes selections on refresh, including an empty result, and resets on view/filter/page changes', async () => {
    const { rerender } = render(
      await SessionsPage({ searchParams: Promise.resolve({}) }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select sessions' }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Select all sessions on this page',
      }),
    );
    sessionStatusState.current = ['active'];
    rerender(await SessionsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('button', { name: 'Delete (1)' })).toBeEnabled();
    sessionStatusState.current = [];
    rerender(await SessionsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('button', { name: 'Delete (0)' })).toBeDisabled();
    sessionStatusState.current = ['active', 'ready'];
    rerender(await SessionsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('button', { name: 'Delete (0)' })).toBeDisabled();
    for (const params of [
      { view: 'board' },
      { view: 'board', status: 'active' },
      { view: 'board', before: 'older' },
    ]) {
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: 'Select all sessions on this page',
        }),
      );
      rerender(await SessionsPage({ searchParams: Promise.resolve(params) }));
      expect(
        screen.getByRole('button', { name: 'Select sessions' }),
      ).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Select sessions' }));
      expect(screen.getByRole('button', { name: 'Delete (0)' })).toBeDisabled();
    }
  });

  it('keeps every session and long-content link accessible, including older sessions', async () => {
    const { container } = render(
      await SessionsPage({ searchParams: Promise.resolve({}) }),
    );

    for (const status of [
      'active',
      'needs_input',
      'blocked',
      'ready',
      'done',
    ]) {
      expect(
        screen.getByRole('link', { name: new RegExp(`Review ${status}`) }),
      ).toHaveAttribute('href', `/sessions/${status}`);
    }
    for (const number of [1, 2, 3]) {
      expect(
        screen
          .getAllByRole('link', { name: new RegExp(`#${number}$`) })
          .some(
            (link) =>
              link.getAttribute('href') ===
              `https://github.com/example/repo/pull/${number}`,
          ),
      ).toBe(true);
    }
    expect(
      screen.getByRole('link', { name: 'Show older sessions' }),
    ).toHaveAttribute('href', '/sessions?before=older-cursor');
    expect(getSessionsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 100 }),
    );
    expect(container.querySelector('main')).toHaveClass('overflow-y-auto');
    expect(container.querySelector('main')).not.toHaveClass(
      'md:overflow-hidden',
    );
  });

  it('offers to clear filters when no sessions match', async () => {
    sessionStatusState.current = [];

    render(
      await SessionsPage({
        searchParams: Promise.resolve({ q: 'no-match' }),
      }),
    );

    expect(screen.getByText('No sessions match your filters.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute(
      'href',
      '/sessions',
    );
  });

  it('preserves the board view when clearing filters', async () => {
    sessionStatusState.current = [];

    render(
      await SessionsPage({
        searchParams: Promise.resolve({ q: 'no-match', view: 'board' }),
      }),
    );

    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute(
      'href',
      '/sessions?view=board',
    );
  });

  it.each([
    ['no parameters', {}],
    ['the default scope', { scope: 'all' }],
    ['the default status', { status: 'all' }],
    ['the default archive state', { archive: 'non-archived' }],
    ['a pagination cursor', { before: 'older-cursor' }],
    ['an unknown parameter', { q: undefined, unexpected: 'value' }],
    ['a whitespace-only search', { q: '   ' }],
    ['the board view', { view: 'board' }],
  ])('shows the unfiltered empty state with %s', async (_, searchParams) => {
    sessionStatusState.current = [];

    render(await SessionsPage({ searchParams: Promise.resolve(searchParams) }));

    expect(screen.getByText('No sessions found.')).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Clear filters' }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ['scope', { scope: 'tasks' }],
    ['status', { status: 'active' }],
    ['archive state', { archive: 'archived' }],
    ['time period', { period: '7' }],
    ['owner', { user: 'user-2' }],
    ['repository', { repository: 'example/repo' }],
    ['pull request', { pullRequest: 'example/repo#1' }],
    ['source', { source: 'slack' }],
    ['model', { model: 'example/model' }],
  ])('offers to clear a genuine %s filter', async (_, searchParams) => {
    sessionStatusState.current = [];

    render(await SessionsPage({ searchParams: Promise.resolve(searchParams) }));

    expect(screen.getByText('No sessions match your filters.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute(
      'href',
      '/sessions',
    );
  });

  it('exposes the board from a direct URL without a deployment flag', async () => {
    const { container } = render(
      await SessionsPage({
        searchParams: Promise.resolve({ view: 'board' }),
      }),
    );

    expect(screen.getByRole('heading', { name: 'done' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Show older sessions' }),
    ).toHaveAttribute('href', '/sessions?view=board&before=older-cursor');
    expect(container.querySelector('main')).toHaveClass(
      'md:flex',
      'md:overflow-hidden',
    );
  });

  it('shows deployment-wide board lanes while preserving each Session card', async () => {
    render(
      await SessionsPage({
        searchParams: Promise.resolve({ view: 'board' }),
      }),
    );

    const doneSection = screen
      .getByRole('heading', { name: 'done' })
      .closest('section');
    expect(doneSection).not.toBeNull();
    expect(
      within(doneSection!).getByRole('link', { name: /Review done/ }),
    ).toHaveAttribute('href', '/sessions/done');
    expect(
      screen.getByRole('link', { name: 'Show older sessions' }),
    ).toHaveAttribute('href', '/sessions?view=board&before=older-cursor');
  });

  it('hides empty lanes, moves attention colors to headers, and keeps desktop card lists scrollable', async () => {
    sessionStatusState.current = ['active', 'needs_input', 'blocked', 'done'];

    render(
      await SessionsPage({
        searchParams: Promise.resolve({ view: 'board' }),
      }),
    );

    expect(screen.getAllByRole('region')).toHaveLength(4);
    expect(
      screen.queryByRole('heading', { name: 'ready' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Empty')).not.toBeInTheDocument();

    const blockedSection = screen.getByRole('region', { name: 'blocked' });
    const needsInputSection = screen.getByRole('region', {
      name: 'needs input',
    });
    expect(
      within(blockedSection).getAllByText('blocked', { exact: true }),
    ).toHaveLength(1);
    expect(
      within(needsInputSection).getAllByText('needs input', { exact: true }),
    ).toHaveLength(1);
    expect(
      within(blockedSection).getByRole('heading').closest('header'),
    ).toHaveClass('cursor-default', 'text-destructive', 'md:sticky');
    expect(
      within(blockedSection).getByRole('heading').closest('header'),
    ).not.toHaveClass('bg-destructive');
    expect(
      within(needsInputSection).getByRole('heading').closest('header'),
    ).toHaveClass('text-warning', 'md:sticky');
    expect(
      within(needsInputSection).getByRole('heading').closest('header'),
    ).not.toHaveClass('bg-warning');
    expect(
      blockedSection.querySelector('[data-session-board-card-list="blocked"]'),
    ).toHaveClass('md:overflow-y-auto');
  });

  it('keeps populated card identity while board lanes appear and disappear', async () => {
    sessionStatusState.current = ['active'];

    const { container, rerender } = render(
      await SessionsPage({
        searchParams: Promise.resolve({ view: 'board' }),
      }),
    );
    const activeCard = container.querySelector(
      '[data-session-board-card-id="active"]',
    );
    expect(activeCard).not.toBeNull();
    expect(
      container.querySelector('[data-session-board-column="active"]'),
    ).not.toBeNull();

    sessionStatusState.current = ['active', 'ready'];
    rerender(
      await SessionsPage({
        searchParams: Promise.resolve({ view: 'board' }),
      }),
    );

    expect(
      container.querySelector('[data-session-board-column="ready"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-session-board-card-id="active"]'),
    ).toBe(activeCard);

    sessionStatusState.current = ['active'];
    rerender(
      await SessionsPage({
        searchParams: Promise.resolve({ view: 'board' }),
      }),
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-session-board-column="ready"]'),
      ).toBeNull();
    });
    expect(
      container.querySelector('[data-session-board-card-id="active"]'),
    ).toBe(activeCard);
  });
});
