import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import Link from 'next/link';

const { replaceMock, searchParamsMock, viewport, savePreferencesMock } =
  vi.hoisted(() => ({
    savePreferencesMock: vi.fn().mockResolvedValue(undefined),
    replaceMock: vi.fn(),
    searchParamsMock: { current: new URLSearchParams() },
    viewport: { isMobile: false },
  }));

vi.mock('./filter-preference-actions', () => ({
  saveSessionFilterPreferences: savePreferencesMock,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => viewport.isMobile,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => searchParamsMock.current,
}));

vi.mock('@/components/tasks', () => ({
  TaskFilters: ({
    showTimePeriod,
    showUser = true,
    showRepository = true,
    showPullRequest = true,
    userId,
    onUserChange,
    onRepositoryChange,
    onPullRequestChange,
  }: {
    showTimePeriod?: boolean;
    showUser?: boolean;
    showRepository?: boolean;
    showPullRequest?: boolean;
    userId: string | null;
    onUserChange: (value: string | null) => void;
    onRepositoryChange: (value: string | null) => void;
    onPullRequestChange: (value: string | null) => void;
  }) => (
    <div
      data-testid={
        showTimePeriod === false ? 'advanced-task-filters' : 'time-filter'
      }
      data-show-user={String(showUser)}
      data-user-id={userId}
    >
      <button onClick={() => onUserChange('automation:sentry_triage')}>
        Choose automation
      </button>
      {showRepository ? (
        <button onClick={() => onRepositoryChange('env:fixture-environment')}>
          Choose environment
        </button>
      ) : null}
      {showPullRequest ? (
        <button onClick={() => onPullRequestChange('__has_pr__')}>
          Choose Has PR
        </button>
      ) : null}
    </div>
  ),
}));

import { SessionsFilters } from './SessionsFilters';

const baseProps = {
  viewerUserId: 'viewer-1',
  userId: null,
  timePeriod: 'all' as const,
  sourceOptions: ['slack', 'web'],
};

describe('SessionsFilters', () => {
  beforeEach(() => {
    viewport.isMobile = false;
    replaceMock.mockReset();
    savePreferencesMock.mockClear();
    searchParamsMock.current = new URLSearchParams();
    localStorage.clear();
  });

  it.each(['repository', 'pullRequest', 'model', 'source', 'archive'])(
    'shows advanced filters when the URL supplies %s without changing the saved preference',
    (param) => {
      localStorage.setItem(
        'roomote-sessions-advanced-filters-visible',
        'false',
      );
      searchParamsMock.current = new URLSearchParams(`${param}=active`);

      render(<SessionsFilters {...baseProps} />);

      expect(screen.getByTestId('advanced-task-filters')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Toggle advanced filters' }),
      ).toBeDisabled();
      expect(
        localStorage.getItem('roomote-sessions-advanced-filters-visible'),
      ).toBe('false');
    },
  );

  it('shows the user and automation filter with the primary controls', async () => {
    render(<SessionsFilters {...baseProps} />);

    expect(screen.getByTestId('time-filter')).toHaveAttribute(
      'data-show-user',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose automation' }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
    expect(replaceMock).toHaveBeenCalledWith(
      '/sessions?user=automation%3Asentry_triage',
    );
  });

  it('preserves environment and Has PR values in the shared URL contract', async () => {
    localStorage.setItem('roomote-sessions-advanced-filters-visible', 'true');
    const { rerender } = render(<SessionsFilters {...baseProps} />);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Choose environment' }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose environment' }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
    expect(replaceMock).toHaveBeenCalledWith(
      '/sessions?repository=env%3Afixture-environment',
    );

    replaceMock.mockReset();
    searchParamsMock.current = new URLSearchParams(
      'repository=env%3Afixture-environment',
    );
    rerender(
      <SessionsFilters {...baseProps} repository="env:fixture-environment" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose Has PR' }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());

    expect(replaceMock).toHaveBeenCalledWith(
      '/sessions?repository=env%3Afixture-environment&pullRequest=__has_pr__',
    );
  });

  it('always exposes the board switch and preserves its URL', async () => {
    render(<SessionsFilters {...baseProps} view="list" />);
    fireEvent.click(screen.getByRole('button', { name: 'Board view' }));
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(
        '/sessions?view=board&scope=all',
      ),
    );
  });

  it('clears a board-only Done status when switching to list view', async () => {
    searchParamsMock.current = new URLSearchParams(
      'view=board&status=done&archive=all&before=cursor',
    );
    render(
      <SessionsFilters
        {...baseProps}
        view="board"
        status="done"
        archive="all"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());

    expect(replaceMock).toHaveBeenCalledWith('/sessions?archive=all');
  });

  it.each([false, true])(
    'keeps primary navigation available while a filter menu is open (mobile: %s)',
    async (isMobile) => {
      viewport.isMobile = isMobile;
      render(
        <>
          <Link href="/automations">Automations</Link>
          <SessionsFilters {...baseProps} />
        </>,
      );

      fireEvent.keyDown(screen.getByRole('button', { name: 'Session scope' }), {
        key: 'ArrowDown',
      });

      expect(
        await screen.findByRole('menuitemcheckbox', { name: 'All sessions' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'Automations' }),
      ).toBeInTheDocument();
    },
  );

  it('keeps a selected user filter in the primary controls', () => {
    searchParamsMock.current = new URLSearchParams('user=user-1');

    render(<SessionsFilters {...baseProps} userId="user-1" />);

    expect(screen.getByTestId('time-filter')).toHaveAttribute(
      'data-user-id',
      'user-1',
    );
    expect(
      screen.queryByTestId('advanced-task-filters'),
    ).not.toBeInTheDocument();
  });

  it('restores the saved hidden preference after URL filters are removed', () => {
    localStorage.setItem('roomote-sessions-advanced-filters-visible', 'false');
    searchParamsMock.current = new URLSearchParams('source=slack');
    const { rerender } = render(
      <SessionsFilters {...baseProps} source="slack" />,
    );

    expect(screen.getByTestId('advanced-task-filters')).toBeInTheDocument();

    searchParamsMock.current = new URLSearchParams();
    rerender(<SessionsFilters {...baseProps} />);

    expect(
      screen.queryByTestId('advanced-task-filters'),
    ).not.toBeInTheDocument();
  });

  it('hides advanced filters by default and persists their visibility', async () => {
    const { unmount } = render(<SessionsFilters {...baseProps} />);
    const advancedFiltersButton = screen.getByRole('button', {
      name: 'Toggle advanced filters',
    });

    expect(
      screen.queryByTestId('advanced-task-filters'),
    ).not.toBeInTheDocument();
    expect(advancedFiltersButton).toHaveAttribute('aria-pressed', 'false');
    expect(advancedFiltersButton).not.toHaveAttribute('title');
    fireEvent.click(advancedFiltersButton);

    expect(screen.getByTestId('advanced-task-filters')).toBeInTheDocument();
    expect(advancedFiltersButton).toHaveAttribute('aria-pressed', 'true');
    expect(
      localStorage.getItem('roomote-sessions-advanced-filters-visible'),
    ).toBe('true');

    unmount();
    render(<SessionsFilters {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId('advanced-task-filters')).toBeInTheDocument(),
    );
  });

  it('defaults archive filtering to non-archived and serializes non-default choices', async () => {
    localStorage.setItem('roomote-sessions-advanced-filters-visible', 'true');
    const { rerender } = render(<SessionsFilters {...baseProps} />);

    const archiveButton = await screen.findByRole('button', {
      name: 'Session archive state',
    });
    fireEvent.keyDown(archiveButton, { key: 'ArrowDown' });
    const options = await screen.findAllByRole('menuitemcheckbox');
    expect(options.map((option) => option.textContent)).toEqual([
      'Archived',
      'Non-Archived',
      'All',
    ]);
    expect(
      within(screen.getByRole('menu')).getByRole('menuitemcheckbox', {
        name: 'Non-Archived',
      }),
    ).toHaveAttribute('data-state', 'checked');

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Archived' }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
    expect(replaceMock).toHaveBeenCalledWith('/sessions?archive=archived');

    replaceMock.mockReset();
    searchParamsMock.current = new URLSearchParams('archive=archived');
    rerender(<SessionsFilters {...baseProps} archive="archived" />);
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Session archive state' }),
      { key: 'ArrowDown' },
    );
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', { name: 'Non-Archived' }),
    );
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith('/sessions?scope=all'),
    );
  });

  it('hides the status filter in board view while keeping advanced filters', async () => {
    localStorage.setItem('roomote-sessions-advanced-filters-visible', 'true');
    render(<SessionsFilters {...baseProps} view="board" />);

    await screen.findByRole('button', { name: 'Session archive state' });
    expect(
      screen.queryByRole('button', { name: 'Session status' }),
    ).not.toBeInTheDocument();
  });

  it('expands search to the left and shows a submit hint', async () => {
    render(<SessionsFilters {...baseProps} />);
    const searchButton = screen.getByRole('button', {
      name: 'Toggle session search',
    });

    expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
    expect(searchButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(searchButton);

    const searchInput = screen.getByPlaceholderText('Search...');
    expect(searchInput).toHaveFocus();
    expect(searchInput.compareDocumentPosition(searchButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(searchButton).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.queryByRole('button', { name: 'Submit session search' }),
    ).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'release notes' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Submit session search' }),
    );
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
    expect(replaceMock).toHaveBeenCalledWith('/sessions?q=release+notes');
  });

  it('clears the search query from the URL when search is closed', async () => {
    searchParamsMock.current = new URLSearchParams(
      'q=release+notes&view=board',
    );
    render(<SessionsFilters {...baseProps} query="release notes" />);

    const searchButton = screen.getByRole('button', {
      name: 'Toggle session search',
    });
    expect(searchButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(searchButton);
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());

    expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
    expect(searchButton).toHaveAttribute('aria-pressed', 'false');
    expect(replaceMock).toHaveBeenCalledWith('/sessions?view=board&scope=all');
  });

  it('saves explicit URL selections for the viewer without cursor or view state', async () => {
    searchParamsMock.current = new URLSearchParams(
      'scope=tasks&user=other-user&period=7&status=active&q=release&repository=env:fixture&pullRequest=__has_pr__&source=slack&model=example/model&archive=all&before=stale&view=board',
    );
    render(<SessionsFilters {...baseProps} />);
    await waitFor(() =>
      expect(savePreferencesMock).toHaveBeenCalledWith('viewer-1', {
        scope: 'tasks',
        user: 'other-user',
        period: '7',
        status: 'active',
        q: 'release',
        repository: 'env:fixture',
        pullRequest: '__has_pr__',
        source: 'slack',
        model: 'example/model',
        archive: 'all',
      }),
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('persists clearing the last filter before navigating and persists the clear-link state on remount', async () => {
    searchParamsMock.current = new URLSearchParams('q=release&before=stale');
    const { unmount } = render(
      <SessionsFilters {...baseProps} query="release" />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Toggle session search' }),
    );
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith('/sessions?scope=all'),
    );
    expect(savePreferencesMock).toHaveBeenLastCalledWith('viewer-1', {});
    unmount();
    searchParamsMock.current = new URLSearchParams('scope=all');
    render(<SessionsFilters {...baseProps} />);
    await waitFor(() =>
      expect(savePreferencesMock).toHaveBeenLastCalledWith('viewer-1', {}),
    );
  });

  it('still navigates when saving preferences fails', async () => {
    savePreferencesMock.mockRejectedValueOnce(new Error('unavailable'));
    render(<SessionsFilters {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose automation' }));
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(
        '/sessions?user=automation%3Asentry_triage',
      ),
    );
  });

  it('does not resave on server rerenders or pagination-only URL changes', async () => {
    searchParamsMock.current = new URLSearchParams('scope=tasks');
    const { rerender } = render(
      <SessionsFilters {...baseProps} scope="tasks" />,
    );
    await waitFor(() => expect(savePreferencesMock).toHaveBeenCalledTimes(1));
    searchParamsMock.current = new URLSearchParams('scope=tasks&before=older');
    rerender(<SessionsFilters {...baseProps} scope="tasks" />);
    await waitFor(() => expect(savePreferencesMock).toHaveBeenCalledTimes(1));
  });

  it('orders a reset after an in-flight deep-link save', async () => {
    let finishSave!: () => void;
    savePreferencesMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    searchParamsMock.current = new URLSearchParams('q=release');
    render(<SessionsFilters {...baseProps} query="release" />);
    await waitFor(() => expect(savePreferencesMock).toHaveBeenCalledTimes(1));
    fireEvent.click(
      screen.getByRole('button', { name: 'Toggle session search' }),
    );
    expect(replaceMock).not.toHaveBeenCalled();
    finishSave();
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith('/sessions?scope=all'),
    );
    expect(savePreferencesMock.mock.calls.map((call) => call[1])).toEqual([
      { q: 'release' },
      {},
    ]);
  });
});
