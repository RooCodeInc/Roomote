import { fireEvent, render, screen } from '@testing-library/react';

import type { AnalyticsChartResponse } from '@/types';

import { AnalyticsStackedBarChart } from './AnalyticsStackedBarChart';

const mockRechartsState = vi.hoisted(() => ({
  tooltipProps: null as Record<string, unknown> | null,
  barProps: [] as Array<Record<string, unknown>>,
  tooltipPayload: [
    { name: 'Raphi Winkler', value: 2, color: '#ff9900' },
    { name: 'John Richmond', value: 1, color: '#3366ff' },
  ] as Array<{ name: string; value: number; color: string }>,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('./AnalyticsGranularitySelector', () => ({
  AnalyticsGranularitySelector: () => <div>By Day</div>,
}));

vi.mock('recharts', async () => {
  const React = await import('react');

  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
    BarChart: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Bar: (props: Record<string, unknown>) => {
      mockRechartsState.barProps.push(props);
      return null;
    },
    Tooltip: (props: Record<string, unknown>) => {
      mockRechartsState.tooltipProps = props;

      const content = props.content;
      return React.isValidElement(content)
        ? React.cloneElement(
            content as React.ReactElement<Record<string, unknown>>,
            {
              active: true,
              label: 'Mar 27',
              payload: mockRechartsState.tooltipPayload,
            },
          )
        : null;
    },
  };
});

const CHART: AnalyticsChartResponse = {
  object: 'pullRequests',
  viewBy: 'user',
  total: 3,
  series: [
    { key: 'raphi', label: 'Raphi Winkler', total: 2 },
    { key: 'john', label: 'John Richmond', total: 1 },
  ],
  buckets: [
    {
      key: '2026-03-27',
      label: 'Mar 27',
      total: 3,
      segments: {
        raphi: 2,
        john: 1,
      },
    },
  ],
};

const STATUS_CHART: AnalyticsChartResponse = {
  object: 'pullRequests',
  viewBy: 'status',
  total: 4,
  series: [
    { key: 'Closed', label: 'Closed', total: 1 },
    { key: 'Draft', label: 'Draft', total: 1 },
    { key: 'Open', label: 'Open', total: 1 },
    { key: 'Merged', label: 'Merged', total: 1 },
  ],
  buckets: [
    {
      key: '2026-03-27',
      label: 'Mar 27',
      total: 4,
      segments: {
        Closed: 1,
        Draft: 1,
        Open: 1,
        Merged: 1,
      },
    },
  ],
};

const PALETTE_CHART: AnalyticsChartResponse = {
  object: 'tasks',
  viewBy: 'user',
  total: 28,
  series: [
    { key: 'series-1', label: 'Series 1', total: 1 },
    { key: 'series-2', label: 'Series 2', total: 2 },
    { key: 'series-3', label: 'Series 3', total: 3 },
    { key: 'series-4', label: 'Series 4', total: 4 },
    { key: 'series-5', label: 'Series 5', total: 5 },
    { key: 'series-6', label: 'Series 6', total: 6 },
    { key: 'series-7', label: 'Series 7', total: 7 },
  ],
  buckets: [
    {
      key: '2026-03-27',
      label: 'Mar 27',
      total: 28,
      segments: {
        'series-1': 1,
        'series-2': 2,
        'series-3': 3,
        'series-4': 4,
        'series-5': 5,
        'series-6': 6,
        'series-7': 7,
      },
    },
  ],
};

describe('AnalyticsStackedBarChart', () => {
  beforeEach(() => {
    mockRechartsState.tooltipProps = null;
    mockRechartsState.barProps = [];
    mockRechartsState.tooltipPayload = [
      { name: 'Raphi Winkler', value: 2, color: '#ff9900' },
      { name: 'John Richmond', value: 1, color: '#3366ff' },
    ];
  });

  it('allows pointer interaction on the tooltip wrapper for long lists', () => {
    const { container } = render(
      <AnalyticsStackedBarChart
        axisLabel="PRs"
        chart={CHART}
        granularity="day"
        availableGranularities={['day', 'week', 'month', 'year']}
        isLoading={false}
        isError={false}
        onGranularityChange={vi.fn()}
        onResetFilters={vi.fn()}
        onSelectSegment={vi.fn()}
      />,
    );

    expect(mockRechartsState.tooltipProps).toMatchObject({
      wrapperStyle: {
        pointerEvents: 'auto',
      },
    });
    expect(
      container.querySelector('.scroll-thin.overflow-y-auto'),
    ).toBeInTheDocument();
  });

  it('stops tooltip pointer events from bubbling back into the chart container', () => {
    const onWrapperClick = vi.fn();
    const onWrapperMouseMove = vi.fn();
    const onWrapperPointerMove = vi.fn();

    render(
      <div
        onClick={onWrapperClick}
        onMouseMove={onWrapperMouseMove}
        onPointerMove={onWrapperPointerMove}
      >
        <AnalyticsStackedBarChart
          axisLabel="PRs"
          chart={CHART}
          granularity="day"
          availableGranularities={['day', 'week', 'month', 'year']}
          isLoading={false}
          isError={false}
          onGranularityChange={vi.fn()}
          onResetFilters={vi.fn()}
          onSelectSegment={vi.fn()}
        />
      </div>,
    );

    const tooltip = screen.getByText('Mar 27').closest('.min-w-56');
    expect(tooltip).toBeTruthy();

    fireEvent.mouseMove(tooltip!);
    fireEvent.pointerMove(tooltip!);
    fireEvent.click(tooltip!);

    expect(onWrapperMouseMove).not.toHaveBeenCalled();
    expect(onWrapperPointerMove).not.toHaveBeenCalled();
    expect(onWrapperClick).not.toHaveBeenCalled();
  });

  it('sorts user tooltip labels alphabetically', () => {
    mockRechartsState.tooltipPayload = [
      { name: 'Raphi Winkler', value: 2, color: '#ff9900' },
      { name: 'Chris Estreich', value: 4, color: '#8250df' },
      { name: 'Dan Riccio', value: 3, color: '#6e7781' },
    ];

    const { container } = render(
      <AnalyticsStackedBarChart
        axisLabel="PRs"
        chart={CHART}
        granularity="day"
        availableGranularities={['day', 'week', 'month', 'year']}
        isLoading={false}
        isError={false}
        onGranularityChange={vi.fn()}
        onResetFilters={vi.fn()}
        onSelectSegment={vi.fn()}
      />,
    );

    const tooltip = screen.getByText('Mar 27').closest('.min-w-56');
    expect(tooltip).toBeTruthy();

    const names = Array.from(
      container.querySelectorAll('.scroll-thin .truncate'),
    ).map((element) => element.textContent);

    expect(names).toEqual(['Chris Estreich', 'Dan Riccio', 'Raphi Winkler']);
  });

  it('keeps status tooltip labels in status order', () => {
    mockRechartsState.tooltipPayload = [
      { name: 'Merged', value: 1, color: '#8250df' },
      { name: 'Open', value: 1, color: '#1a7f37' },
      { name: 'Draft', value: 1, color: '#6e7781' },
      { name: 'Closed', value: 1, color: '#cf222e' },
    ];

    const { container } = render(
      <AnalyticsStackedBarChart
        axisLabel="PRs"
        chart={STATUS_CHART}
        granularity="day"
        availableGranularities={['day', 'week', 'month', 'year']}
        isLoading={false}
        isError={false}
        onGranularityChange={vi.fn()}
        onResetFilters={vi.fn()}
        onSelectSegment={vi.fn()}
      />,
    );

    const names = Array.from(
      container.querySelectorAll('.scroll-thin .truncate'),
    ).map((element) => element.textContent);

    expect(names).toEqual(['Closed', 'Draft', 'Open', 'Merged']);
  });

  it('uses the attached chart palette sequence for general analytics series', () => {
    render(
      <AnalyticsStackedBarChart
        axisLabel="Tasks"
        chart={PALETTE_CHART}
        granularity="day"
        availableGranularities={['day', 'week', 'month', 'year']}
        isLoading={false}
        isError={false}
        onGranularityChange={vi.fn()}
        onResetFilters={vi.fn()}
        onSelectSegment={vi.fn()}
      />,
    );

    expect(mockRechartsState.barProps.map((props) => props.fill)).toEqual([
      'var(--color-chart-1)',
      'var(--color-chart-2)',
      'var(--color-chart-3)',
      'var(--color-chart-4)',
      'var(--color-chart-5)',
      'var(--color-chart-7)',
      'var(--color-chart-1)',
    ]);
  });

  it('maps pull request statuses onto the updated chart palette', () => {
    render(
      <AnalyticsStackedBarChart
        axisLabel="PRs"
        chart={STATUS_CHART}
        granularity="day"
        availableGranularities={['day', 'week', 'month', 'year']}
        isLoading={false}
        isError={false}
        onGranularityChange={vi.fn()}
        onResetFilters={vi.fn()}
        onSelectSegment={vi.fn()}
      />,
    );

    expect(mockRechartsState.barProps.map((props) => props.fill)).toEqual([
      'var(--color-chart-1)',
      'var(--color-chart-2)',
      'var(--color-chart-3)',
      'var(--color-chart-4)',
    ]);
  });

  it('passes display labels to recharts while keeping stable series keys', () => {
    render(
      <AnalyticsStackedBarChart
        axisLabel="PRs"
        chart={{
          ...CHART,
          series: [
            { key: 'user:user_123', label: 'Bruno Bergher', total: 2 },
            { key: 'github:hannesrudolph', label: '@hannesrudolph', total: 1 },
          ],
          buckets: [
            {
              key: '2026-03-27',
              label: 'Mar 27',
              total: 3,
              segments: {
                'user:user_123': 2,
                'github:hannesrudolph': 1,
              },
            },
          ],
        }}
        granularity="day"
        availableGranularities={['day', 'week', 'month', 'year']}
        isLoading={false}
        isError={false}
        onGranularityChange={vi.fn()}
        onResetFilters={vi.fn()}
        onSelectSegment={vi.fn()}
      />,
    );

    expect(
      mockRechartsState.barProps.map((props) => ({
        dataKey: props.dataKey,
        name: props.name,
      })),
    ).toEqual([
      {
        dataKey: 'user:user_123',
        name: 'Bruno Bergher',
      },
      {
        dataKey: 'github:hannesrudolph',
        name: '@hannesrudolph',
      },
    ]);
  });
});
