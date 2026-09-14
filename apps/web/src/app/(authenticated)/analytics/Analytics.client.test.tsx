import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
}));
const hooks = vi.hoisted(() => ({
  useAnalyticsDetails: vi.fn(),
  useAnalyticsOverview: vi.fn(),
  usePullRequestAnalyticsOverview: vi.fn(),
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
  useAnalyticsDetails: hooks.useAnalyticsDetails,
  useAnalyticsOverview: hooks.useAnalyticsOverview,
  usePullRequestAnalyticsOverview: hooks.usePullRequestAnalyticsOverview,
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
  AnalyticsStackedBarChart: ({
    isError,
    isRetrying,
    onRetry,
    onSelectSegment,
  }: {
    isError: boolean;
    isRetrying: boolean;
    onRetry: () => void;
    onSelectSegment: (selection: {
      bucketKey: string;
      bucketLabel: string;
      seriesKey: string;
      seriesLabel: string;
      metric: 'tokens';
    }) => void;
  }) => (
    <div>
      {isError ? (
        <button type="button" disabled={isRetrying} onClick={onRetry}>
          {isRetrying ? 'Retrying...' : 'Retry'}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() =>
          onSelectSegment({
            bucketKey: '2026-03-27',
            bucketLabel: 'Mar 27',
            seriesKey: 'openai',
            seriesLabel: 'OpenAI',
            metric: 'tokens',
          })
        }
      >
        Select token segment
      </button>
    </div>
  ),
}));

vi.mock('./AnalyticsDetailsDialog', () => ({
  AnalyticsDetailsDialog: ({ metric }: { metric: string }) => (
    <div data-testid="details-metric">{metric}</div>
  ),
}));

vi.mock('./PullRequestSummaryCards', () => ({
  PullRequestSummaryCards: ({ isError }: { isError: boolean }) => (
    <div>{isError ? 'summary error' : 'summary ready'}</div>
  ),
}));

import { Analytics } from './Analytics';

describe('Analytics', () => {
  beforeEach(() => {
    state.searchParams = new URLSearchParams();
    state.push.mockReset();
    state.replace.mockReset();
    hooks.useAnalyticsOverview.mockReset();
    hooks.usePullRequestAnalyticsOverview.mockReset();
    hooks.useAnalyticsDetails.mockReset();
    hooks.useAnalyticsDetails.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
    });
    hooks.useAnalyticsOverview.mockReturnValue({
      data: {
        chart: EMPTY_CHART,
        filterOptions: { filters: {} },
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    });
    hooks.usePullRequestAnalyticsOverview.mockReturnValue({
      data: {
        summary: null,
        chart: EMPTY_CHART,
        filterOptions: { filters: {} },
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
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

  it('uses the clicked token metric for cost details', () => {
    render(<Analytics />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Select token segment' }),
    );

    expect(hooks.useAnalyticsDetails).toHaveBeenLastCalledWith(
      expect.objectContaining({
        object: 'costs',
        metric: 'tokens',
        seriesKey: 'openai',
      }),
    );
    expect(screen.getByTestId('details-metric')).toHaveTextContent('tokens');
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

  it('retries an initial analytics overview error', () => {
    const refetch = vi.fn();
    hooks.useAnalyticsOverview.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: true,
      refetch,
    });

    render(<Analytics />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(refetch).toHaveBeenCalledOnce();
  });

  it('keeps cached analytics visible after a later refetch error', () => {
    hooks.useAnalyticsOverview.mockReturnValue({
      data: {
        chart: EMPTY_CHART,
        filterOptions: { filters: {} },
      },
      isLoading: false,
      isFetching: false,
      isError: true,
      refetch: vi.fn(),
    });

    render(<Analytics />);

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('recovers the pull request chart and summary with one retry', () => {
    state.searchParams = new URLSearchParams('object=pullRequests');
    const refetch = vi.fn();
    hooks.usePullRequestAnalyticsOverview.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: true,
      refetch,
    });

    const { rerender } = render(<Analytics />);
    expect(screen.getByText('summary error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();

    hooks.usePullRequestAnalyticsOverview.mockReturnValue({
      data: {
        summary: null,
        chart: EMPTY_CHART,
        filterOptions: { filters: {} },
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch,
    });
    rerender(<Analytics />);

    expect(screen.getByText('summary ready')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
