import { fireEvent, render, screen } from '@testing-library/react';

const { routerReplaceMock } = vi.hoisted(() => ({
  routerReplaceMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useRouter: () => ({ replace: routerReplaceMock }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/tasks', () => ({
  TaskFilters: () => <div data-testid="task-filters" />,
}));

import { SessionsFilters } from './SessionsFilters';

describe('SessionsFilters', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses the shared view toggle and keeps view selection in the URL', () => {
    render(<SessionsFilters userId={null} timePeriod="all" />);

    fireEvent.click(screen.getByRole('button', { name: 'Board view' }));

    expect(routerReplaceMock).toHaveBeenCalledWith('/sessions?view=board');
  });
});
