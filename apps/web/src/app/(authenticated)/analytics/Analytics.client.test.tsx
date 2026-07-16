import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
}));

const EMPTY_CHART = {
  object: 'pullRequests' as const,
  viewBy: 'user' as const,
  metric: 'tasks' as const,
  total: 0,
  series: [],
  buckets: [],
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: state.push,
    replace: state.replace,
  }),
  useSearchParams: () => state.searchParams,
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    fetchQuery: vi.fn(),
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    analytics: {
      export: {
        queryOptions: vi.fn(),
      },
    },
  }),
}));

vi.mock('@/hooks/useDelayedRefetchLoading', () => ({
  useDelayedRefetchLoading: () => false,
}));

vi.mock('@/hooks/analytics', () => ({
  useAnalyticsChart: () => ({
    data: EMPTY_CHART,
    isLoading: false,
    isFetching: false,
    isError: false,
  }),
  useAnalyticsDetails: () => ({
    data: null,
    isLoading: false,
    isError: false,
  }),
  useAnalyticsFilters: () => ({
    data: { filters: {} },
    isLoading: false,
    isFetching: false,
    isError: false,
  }),
  usePullRequestAnalyticsOverview: () => ({
    data: {
      summary: null,
      chart: EMPTY_CHART,
      filterOptions: { filters: {} },
    },
    isLoading: false,
    isFetching: false,
    isError: false,
  }),
}));

vi.mock('./AnalyticsShell', () => ({
  AnalyticsShell: ({
    activeItemId,
    title,
    onItemSelect,
    children,
  }: {
    activeItemId: string;
    title: string;
    onItemSelect: (value: 'tasks' | 'pullRequests' | 'costs') => void;
    children: ReactNode;
  }) => (
    <div>
      <div data-testid="active-item">{activeItemId}</div>
      <h1>{title}</h1>
      <button type="button" onClick={() => onItemSelect('costs')}>
        Costs
      </button>
      {children}
    </div>
  ),
  AnalyticsShellDownloadAction: () => null,
  getAnalyticsHref: (object: 'tasks' | 'pullRequests' | 'costs') => {
    if (object === 'costs') {
      return '/analytics/costs';
    }

    if (object === 'pullRequests') {
      return '/analytics?object=pullRequests';
    }

    return '/analytics';
  },
}));

vi.mock('./AnalyticsFilterBar', () => ({
  AnalyticsFilterBar: () => <div>filters</div>,
}));

vi.mock('./AnalyticsControlRow', () => ({
  AnalyticsControlRow: () => <div>controls</div>,
}));

vi.mock('./AnalyticsStackedBarChart', () => ({
  AnalyticsStackedBarChart: () => <div>chart</div>,
}));

vi.mock('./AnalyticsDetailsDialog', () => ({
  AnalyticsDetailsDialog: () => null,
}));

vi.mock('./PullRequestSummaryCards', () => ({
  PullRequestSummaryCards: () => <div>summary</div>,
}));

import { Analytics } from './Analytics';

describe('Analytics', () => {
  beforeEach(() => {
    state.searchParams = new URLSearchParams();
    state.push.mockReset();
    state.replace.mockReset();
  });

  it('treats unknown analytics objects as invalid on the generic /analytics page', () => {
    state.searchParams = new URLSearchParams('object=unknown');

    render(<Analytics />);

    expect(screen.getByTestId('active-item')).toHaveTextContent('tasks');
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('opens Costs on its dedicated analytics page from generic analytics', () => {
    render(<Analytics />);

    fireEvent.click(screen.getByRole('button', { name: 'Costs' }));

    expect(state.push).toHaveBeenCalledWith('/analytics/costs');
    expect(state.replace).not.toHaveBeenCalled();
  });
});
