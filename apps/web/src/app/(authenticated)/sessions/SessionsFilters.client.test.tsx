import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { replaceMock, searchParamsMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  searchParamsMock: { current: new URLSearchParams() },
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
    userId,
    onUserChange,
  }: {
    showTimePeriod?: boolean;
    showUser?: boolean;
    userId: string | null;
    onUserChange: (value: string | null) => void;
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
    </div>
  ),
}));

import { SessionsFilters } from './SessionsFilters';

const baseProps = {
  userId: null,
  timePeriod: 'all' as const,
  sourceOptions: ['slack', 'web'],
};

describe('SessionsFilters', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    searchParamsMock.current = new URLSearchParams();
    localStorage.clear();
  });

  it.each(['repository', 'pullRequest', 'model', 'source'])(
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

  it('shows the user and automation filter with the primary controls', () => {
    render(<SessionsFilters {...baseProps} />);

    expect(screen.getByTestId('time-filter')).toHaveAttribute(
      'data-show-user',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose automation' }));
    expect(replaceMock).toHaveBeenCalledWith(
      '/sessions?user=automation%3Asentry_triage',
    );
  });

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

  it('expands search to the left, shows a submit hint, and switches views', () => {
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
    expect(replaceMock).toHaveBeenCalledWith('/sessions?q=release+notes');

    fireEvent.click(screen.getByRole('button', { name: 'Board view' }));
    expect(replaceMock).toHaveBeenCalledWith('/sessions?view=board');
    expect(localStorage.getItem('roomote-sessions-view')).toBe('board');
  });

  it('clears the search query from the URL when search is closed', () => {
    searchParamsMock.current = new URLSearchParams(
      'q=release+notes&view=board',
    );
    render(
      <SessionsFilters {...baseProps} query="release notes" view="board" />,
    );

    const searchButton = screen.getByRole('button', {
      name: 'Toggle session search',
    });
    expect(searchButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(searchButton);

    expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
    expect(searchButton).toHaveAttribute('aria-pressed', 'false');
    expect(replaceMock).toHaveBeenCalledWith('/sessions?view=board');
  });
});
