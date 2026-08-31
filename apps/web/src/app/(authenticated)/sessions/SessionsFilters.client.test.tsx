import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { replaceMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/tasks', () => ({
  TaskFilters: ({ showTimePeriod }: { showTimePeriod?: boolean }) =>
    showTimePeriod === false ? (
      <div data-testid="advanced-task-filters">Advanced task filters</div>
    ) : (
      <div data-testid="time-filter">Time filter</div>
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
    localStorage.clear();
  });

  it('hides advanced filters by default and persists their visibility', async () => {
    const { unmount } = render(<SessionsFilters {...baseProps} />);

    expect(
      screen.queryByTestId('advanced-task-filters'),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Toggle advanced filters' }),
    );

    expect(screen.getByTestId('advanced-task-filters')).toBeInTheDocument();
    expect(
      localStorage.getItem('roomote-sessions-advanced-filters-visible'),
    ).toBe('true');

    unmount();
    render(<SessionsFilters {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId('advanced-task-filters')).toBeInTheDocument(),
    );
  });

  it('expands the compact search input and switches views with icon buttons', () => {
    render(<SessionsFilters {...baseProps} />);

    expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Toggle session search' }),
    );
    expect(screen.getByPlaceholderText('Search...')).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Board view' }));
    expect(replaceMock).toHaveBeenCalledWith('/sessions?view=board');
    expect(localStorage.getItem('roomote-sessions-view')).toBe('board');
  });
});
