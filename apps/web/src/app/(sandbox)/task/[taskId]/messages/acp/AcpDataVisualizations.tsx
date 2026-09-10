'use client';

import { useId } from 'react';
import type { DataVisualizationBlock } from '@roomote/types';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useIsMobile } from '@/hooks/useIsMobile';

const CHART_COLORS = [
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
  'var(--color-chart-2)',
  'var(--color-chart-7)',
  'var(--color-chart-1)',
];

const TOOLTIP_CONTENT_STYLE = {
  borderColor: 'var(--color-border)',
  borderRadius: 10,
  background: 'var(--color-popover)',
  color: 'var(--color-popover-foreground)',
};

function getChartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length]!;
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function ChartDataTable({ chart }: { chart: DataVisualizationBlock }) {
  if (chart.chart.type === 'pie') {
    return (
      <table className="mt-2 w-full min-w-64 text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="border-b px-2 py-1.5 font-medium">
              Segment
            </th>
            <th
              scope="col"
              className="border-b px-2 py-1.5 text-right font-medium"
            >
              Value
            </th>
          </tr>
        </thead>
        <tbody>
          {chart.chart.segments.map((segment) => (
            <tr key={segment.label}>
              <th scope="row" className="border-b px-2 py-1.5 font-normal">
                {segment.label}
              </th>
              <td className="border-b px-2 py-1.5 text-right tabular-nums">
                {segment.value.toLocaleString('en-US')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  const cartesianChart = chart.chart;

  return (
    <table className="mt-2 w-full min-w-96 text-left text-xs">
      <thead className="text-muted-foreground">
        <tr>
          <th scope="col" className="border-b px-2 py-1.5 font-medium">
            {cartesianChart.axis_config.x_label ?? 'Category'}
          </th>
          {cartesianChart.series.map((series) => (
            <th
              key={series.name}
              scope="col"
              className="border-b px-2 py-1.5 text-right font-medium"
            >
              {series.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {cartesianChart.axis_config.categories.map((category) => (
          <tr key={category}>
            <th scope="row" className="border-b px-2 py-1.5 font-normal">
              {category}
            </th>
            {cartesianChart.series.map((series) => (
              <td
                key={series.name}
                className="border-b px-2 py-1.5 text-right tabular-nums"
              >
                {series.data
                  .find((point) => point.label === category)!
                  .value.toLocaleString('en-US')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CartesianVisualization({
  chart,
}: {
  chart: Extract<
    DataVisualizationBlock['chart'],
    { type: 'bar' | 'area' | 'line' }
  >;
}) {
  const isMobile = useIsMobile();
  const data = chart.axis_config.categories.map((category) => {
    const row: Record<string, string | number> = { category };
    chart.series.forEach((series, index) => {
      row[`series-${index}`] = series.data.find(
        (point) => point.label === category,
      )!.value;
    });
    return row;
  });
  const interval = Math.max(
    0,
    Math.ceil(chart.axis_config.categories.length / (isMobile ? 4 : 8)) - 1,
  );
  const common = {
    data,
    margin: {
      top: 12,
      right: 18,
      left: isMobile ? 2 : 16,
      bottom: 12,
    },
  };
  const axes = (
    <>
      <CartesianGrid
        vertical={false}
        stroke="var(--color-border)"
        strokeOpacity={0.35}
      />
      <XAxis
        dataKey="category"
        interval={interval}
        minTickGap={isMobile ? 18 : 24}
        padding={{ left: isMobile ? 6 : 10, right: isMobile ? 14 : 18 }}
        tickMargin={8}
        tickLine={false}
        axisLine={false}
        tick={{ fill: 'var(--color-foreground)', fontSize: 12 }}
      />
      <YAxis
        width={isMobile ? 40 : 64}
        tickLine={false}
        axisLine={false}
        tick={{ fill: 'var(--color-foreground)', fontSize: 12 }}
        tickFormatter={(value) => formatCompactNumber(Number(value))}
        label={
          !isMobile && chart.axis_config.y_label
            ? {
                value: chart.axis_config.y_label,
                angle: -90,
                position: 'insideLeft',
                fill: 'var(--color-muted-foreground)',
                fontSize: 12,
                fontWeight: 500,
                dx: 8,
              }
            : undefined
        }
      />
      <Tooltip contentStyle={TOOLTIP_CONTENT_STYLE} />
      <Legend
        iconType="circle"
        iconSize={8}
        wrapperStyle={{ fontSize: 12, fontWeight: 500 }}
      />
    </>
  );

  if (chart.type === 'bar') {
    return (
      <BarChart {...common} accessibilityLayer={false} tabIndex={-1}>
        {axes}
        {chart.series.map((series, index) => (
          <Bar
            key={series.name}
            dataKey={`series-${index}`}
            name={series.name}
            fill={getChartColor(index)}
            maxBarSize={64}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    );
  }

  if (chart.type === 'area') {
    return (
      <AreaChart {...common} accessibilityLayer={false} tabIndex={-1}>
        {axes}
        {chart.series.map((series, index) => (
          <Area
            key={series.name}
            type="monotone"
            dataKey={`series-${index}`}
            name={series.name}
            stroke={getChartColor(index)}
            fill={getChartColor(index)}
            fillOpacity={0.24}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    );
  }

  return (
    <LineChart {...common} accessibilityLayer={false} tabIndex={-1}>
      {axes}
      {chart.series.map((series, index) => (
        <Line
          key={series.name}
          type="monotone"
          dataKey={`series-${index}`}
          name={series.name}
          stroke={getChartColor(index)}
          strokeWidth={3}
          dot={{ r: 3, strokeWidth: 2, fill: 'var(--color-background)' }}
          activeDot={{ r: 5 }}
          isAnimationActive={false}
        />
      ))}
    </LineChart>
  );
}

function DataVisualization({ chart }: { chart: DataVisualizationBlock }) {
  const titleId = useId();

  return (
    <figure
      className="min-w-0 rounded-xl border border-border/70 bg-muted/20 p-3 sm:p-4"
      aria-labelledby={titleId}
      data-testid="conversation-data-visualization"
    >
      <figcaption id={titleId} className="text-base font-semibold">
        {chart.title}
      </figcaption>
      <div className="mt-3 h-64 w-full min-w-0 sm:h-80" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          {chart.chart.type === 'pie' ? (
            <PieChart accessibilityLayer={false} tabIndex={-1}>
              <Pie
                data={chart.chart.segments}
                dataKey="value"
                nameKey="label"
                innerRadius="38%"
                outerRadius="72%"
                paddingAngle={1}
                isAnimationActive={false}
              >
                {chart.chart.segments.map((segment, index) => (
                  <Cell key={segment.label} fill={getChartColor(index)} />
                ))}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_CONTENT_STYLE} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 12, fontWeight: 500 }}
              />
            </PieChart>
          ) : (
            <CartesianVisualization chart={chart.chart} />
          )}
        </ResponsiveContainer>
      </div>
      {chart.chart.type !== 'pie' && chart.chart.axis_config.x_label ? (
        <p className="-mt-1 text-center text-xs font-medium text-muted-foreground">
          {chart.chart.axis_config.x_label}
        </p>
      ) : null}
      <details className="mt-3 text-xs text-foreground">
        <summary className="w-fit cursor-pointer select-none rounded-sm py-1 text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          View data table
        </summary>
        <div
          className="max-w-full overflow-x-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          role="region"
          aria-label={`${chart.title} data table`}
          tabIndex={0}
        >
          <ChartDataTable chart={chart} />
        </div>
      </details>
    </figure>
  );
}

export function AcpDataVisualizations({
  charts,
}: {
  charts: DataVisualizationBlock[];
}) {
  if (charts.length === 0) return null;

  return (
    <div className="mt-4 grid min-w-0 gap-3">
      {charts.map((chart, index) => (
        <DataVisualization
          key={chart.block_id ?? `${chart.title}-${index}`}
          chart={chart}
        />
      ))}
    </div>
  );
}
