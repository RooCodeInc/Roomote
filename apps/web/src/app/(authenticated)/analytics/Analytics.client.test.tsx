import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
}));
const hooks = vi.hoisted(() => ({
  useAnalyticsOverview: vi.fn(),
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
  useAnalyticsDetails: () => ({
    data: null,
    isLoading: false,
    isError: false,
  }),
  useAnalyticsOverview: hooks.useAnalyticsOverview,
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
      return '/analytics';
    }

    if (object === 'pullRequests') {
      return '/analytics?object=pullRequests';
    }

    return '/analytics?object=tasks';
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
    hooks.useAnalyticsOverview.mockReset();
    hooks.useAnalyticsOverview.mockReturnValue({
      data: {
        chart: EMPTY_CHART,
        filterOptions: { filters: {} },
      },
      isLoading: false,
      isFetching: false,
      isError: false,
    });
  });

  it.each(['unknown', 'sessions'])(
    'uses Costs for unsupported %s analytics objects on the generic /analytics page',
    (object) => {
      state.searchParams = new URLSearchParams({
        object,
        viewBy: 'status',
        status: 'active',
      });

      render(<Analytics />);

      expect(screen.getByTestId('active-item')).toHaveTextContent('costs');
      expect(
        screen.getByRole('heading', { name: 'Costs' }),
      ).toBeInTheDocument();
      expect(hooks.useAnalyticsOverview).toHaveBeenCalledWith(
        expect.objectContaining({
          object: 'costs',
          viewBy: 'taskType',
          filters: {},
        }),
        { enabled: true },
      );
    },
  );

  it('uses Costs as the default /analytics view', () => {
    render(<Analytics />);

    expect(screen.getByTestId('active-item')).toHaveTextContent('costs');
    expect(screen.getByRole('heading', { name: 'Costs' })).toBeInTheDocument();
  });

  it('opens the canonical Costs URL from Tasks analytics', () => {
    state.searchParams = new URLSearchParams('object=tasks');
    render(<Analytics />);

    fireEvent.click(screen.getByRole('button', { name: 'Costs' }));

    expect(state.replace).toHaveBeenCalledWith('/analytics', { scroll: false });
    expect(state.push).not.toHaveBeenCalled();
  });

  it('loads costs through the combined analytics overview query', () => {
    render(<Analytics fixedObject="costs" />);

    expect(hooks.useAnalyticsOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        object: 'costs',
        timePeriod: 7,
      }),
      { enabled: true },
    );
  });
});
