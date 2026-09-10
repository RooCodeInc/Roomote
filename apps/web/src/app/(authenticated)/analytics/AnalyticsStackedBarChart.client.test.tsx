import { fireEvent, render, screen } from '@testing-library/react';

import type { AnalyticsChartResponse } from '@/types';

import { AnalyticsStackedBarChart } from './AnalyticsStackedBarChart';

const mockRechartsState = vi.hoisted(() => ({
  tooltipProps: null as Record<string, unknown> | null,
  barProps: [] as Array<Record<string, unknown>>,
  lineProps: [] as Array<Record<string, unknown>>,
  chartData: [] as Array<Record<string, unknown>>,
  yAxisProps: [] as Array<Record<string, unknown>>,
  tooltipPayload: [
    { name: 'Radia Perlman', value: 2, color: '#ff9900' },
    { name: 'John Richmond', value: 1, color: '#3366ff' },
  ] as Array<{
    name: string;
    value: number;
    color: string;
    unit?: string;
    payload?: { tokenSegments?: Record<string, number> };
  }>,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('recharts', async () => {
  const React = await import('react');

  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
    ComposedChart: ({
      children,
      data,
    }: {
      children: React.ReactNode;
      data: Array<Record<string, unknown>>;
    }) => {
      mockRechartsState.chartData = data;
      return <div>{children}</div>;
    },
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: (props: Record<string, unknown>) => {
      mockRechartsState.yAxisProps.push(props);
      return null;
    },
    Bar: (props: Record<string, unknown>) => {
      mockRechartsState.barProps.push(props);
      return null;
    },
    Line: (props: Record<string, unknown>) => {
      mockRechartsState.lineProps.push(props);
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
  metric: 'tasks',
  total: 3,
  series: [
    { key: 'radia', label: 'Radia Perlman', total: 2 },
    { key: 'john', label: 'John Richmond', total: 1 },
  ],
  buckets: [
    {
      key: '2026-03-27',
      label: 'Mar 27',
      total: 3,
      segments: {
        radia: 2,
        john: 1,
      },
    },
  ],
};

const STATUS_CHART: AnalyticsChartResponse = {
  object: 'pullRequests',
  viewBy: 'status',
  metric: 'tasks',
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
  metric: 'tasks',
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

const COST_CHART: AnalyticsChartResponse = {
  object: 'costs',
  viewBy: 'provider',
  metric: 'cost',
  total: 2,
  tokenTotal: 3_500_000,
  series: [
    {
      key: 'openai',
      label: 'OpenAI',
      total: 2,
      tokenTotal: 1_500_000,
    },
    {
      key: 'google',
      label: 'Google',
      total: 0,
      tokenTotal: 2_000_000,
    },
  ],
  buckets: [
    {
      key: '2026-03-27',
      label: 'Mar 27',
      total: 2,
      tokenTotal: 3_500_000,
      segments: { openai: 2, google: 0 },
      tokenSegments: { openai: 1_500_000, google: 2_000_000 },
    },
  ],
};

describe('AnalyticsStackedBarChart', () => {
  beforeEach(() => {
    mockRechartsState.tooltipProps = null;
    mockRechartsState.barProps = [];
    mockRechartsState.lineProps = [];
    mockRechartsState.chartData = [];
    mockRechartsState.yAxisProps = [];
    mockRechartsState.tooltipPayload = [
      { name: 'Radia Perlman', value: 2, color: '#ff9900' },
      { name: 'John Richmond', value: 1, color: '#3366ff' },
    ];
  });

  it('allows pointer interaction on the tooltip wrapper for long lists', () => {
    const { container } = render(
      <AnalyticsStackedBarChart
        axisLabel="PRs"
        chart={CHART}
        granularity="day"
        isLoading={false}
        isError={false}
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
          isLoading={false}
          isError={false}
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
      { name: 'Radia Perlman', value: 2, color: '#ff9900' },
      { name: 'Edsger Dijkstra', value: 4, color: '#8250df' },
      { name: 'Grace Hopper', value: 3, color: '#6e7781' },
    ];

    const { container } = render(
      <AnalyticsStackedBarChart
        axisLabel="PRs"
        chart={CHART}
        granularity="day"
        isLoading={false}
        isError={false}
        onResetFilters={vi.fn()}
        onSelectSegment={vi.fn()}
      />,
    );

    const tooltip = screen.getByText('Mar 27').closest('.min-w-56');
    expect(tooltip).toBeTruthy();

    const names = Array.from(
      container.querySelectorAll('.scroll-thin .truncate'),
    ).map((element) => element.textContent);

    expect(names).toEqual(['Edsger Dijkstra', 'Grace Hopper', 'Radia Perlman']);
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
        isLoading={false}
        isError={false}
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
        isLoading={false}
        isError={false}
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
        isLoading={false}
        isError={false}
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

  it('renders grouped cost bars and one aggregate token line on separate axes', () => {
    const onSelectSegment = vi.fn();
    mockRechartsState.tooltipPayload = [
      {
        name: 'OpenAI',
        value: 2,
        color: '#3366ff',
        unit: 'cost',
        payload: {
          tokenSegments: { openai: 1_500_000, google: 2_000_000 },
        },
      },
      {
        name: 'Total tokens',
        value: 3_500_000,
        color: '#ff0000',
        unit: 'tokens',
        payload: {
          tokenSegments: { openai: 1_500_000, google: 2_000_000 },
        },
      },
    ];
    render(
      <AnalyticsStackedBarChart
        axisLabel="Cost (USD)"
        chart={COST_CHART}
        granularity="day"
        isLoading={false}
        isError={false}
        onResetFilters={vi.fn()}
        onSelectSegment={onSelectSegment}
      />,
    );

    expect(mockRechartsState.yAxisProps).toEqual([
      expect.objectContaining({ yAxisId: 'cost' }),
      expect.objectContaining({ yAxisId: 'tokens', orientation: 'right' }),
    ]);
    expect(mockRechartsState.barProps).toEqual([
      expect.objectContaining({
        dataKey: 'openai',
        fill: 'var(--color-chart-1)',
        stackId: 'cost',
        unit: 'cost',
        yAxisId: 'cost',
      }),
      expect.objectContaining({
        dataKey: 'google',
        fill: 'var(--color-chart-2)',
        stackId: 'cost',
        unit: 'cost',
        yAxisId: 'cost',
      }),
    ]);
    expect(mockRechartsState.lineProps).toEqual([
      expect.objectContaining({
        dataKey: 'tokenTotal',
        name: 'Total tokens',
        stroke: 'var(--color-foreground)',
        strokeWidth: 3,
        type: 'linear',
        unit: 'tokens',
        yAxisId: 'tokens',
      }),
    ]);
    expect(mockRechartsState.chartData).toEqual([
      expect.objectContaining({
        tokenTotal: 3_500_000,
        tokenSegments: { openai: 1_500_000, google: 2_000_000 },
      }),
    ]);
    expect(screen.getByText('1.5M tokens')).toBeInTheDocument();
    expect(screen.getByText('2M tokens')).toBeInTheDocument();
    expect(screen.getByText('3.5M tokens')).toBeInTheDocument();

    const costBarClick = mockRechartsState.barProps[0]?.onClick as (
      data: unknown,
    ) => void;
    costBarClick({
      payload: { bucketKey: '2026-03-27', label: 'Mar 27' },
    });
    expect(onSelectSegment).toHaveBeenLastCalledWith({
      bucketKey: '2026-03-27',
      bucketLabel: 'Mar 27',
      seriesKey: 'openai',
      seriesLabel: 'OpenAI',
      metric: 'cost',
    });
  });

  it('passes display labels to recharts while keeping stable series keys', () => {
    render(
      <AnalyticsStackedBarChart
        axisLabel="PRs"
        chart={{
          ...CHART,
          series: [
            { key: 'user:user_123', label: 'Alan Turing', total: 2 },
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
        isLoading={false}
        isError={false}
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
        name: 'Alan Turing',
      },
      {
        dataKey: 'github:hannesrudolph',
        name: '@hannesrudolph',
      },
    ]);
  });
});
