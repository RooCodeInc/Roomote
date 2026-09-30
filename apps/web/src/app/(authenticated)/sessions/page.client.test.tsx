import { render, screen, waitFor, within } from '@testing-library/react';

const { getSessionsMock, sessionStatusState } = vi.hoisted(() => ({
  getSessionsMock: vi.fn(),
  sessionStatusState: {
    current: ['active', 'needs_input', 'blocked', 'ready', 'done'] as Array<
      'active' | 'needs_input' | 'blocked' | 'ready' | 'done'
    >,
  },
}));

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
    sessionStatusState.current = [
      'active',
      'needs_input',
      'blocked',
      'ready',
      'done',
    ];
  });

  it('keeps every session and long-content link accessible, including older sessions', async () => {
    render(await SessionsPage({ searchParams: Promise.resolve({}) }));

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
  });

  it('exposes the board from a direct URL without a deployment flag', async () => {
    render(
      await SessionsPage({
        searchParams: Promise.resolve({ view: 'board' }),
      }),
    );

    expect(screen.getByRole('heading', { name: 'done' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Show older sessions' }),
    ).toHaveAttribute('href', '/sessions?view=board&before=older-cursor');
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
      within(blockedSection).getByRole('heading').parentElement,
    ).toHaveClass('cursor-default', 'text-destructive', 'md:sticky');
    expect(
      within(blockedSection).getByRole('heading').parentElement,
    ).not.toHaveClass('bg-destructive');
    expect(
      within(needsInputSection).getByRole('heading').parentElement,
    ).toHaveClass('text-warning', 'md:sticky');
    expect(
      within(needsInputSection).getByRole('heading').parentElement,
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
