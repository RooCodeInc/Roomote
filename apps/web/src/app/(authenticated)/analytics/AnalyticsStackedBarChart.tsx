'use client';

import { useMemo, useState, type SyntheticEvent } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type {
  AnalyticsChartResponse,
  AnalyticsDimension,
  AnalyticsGranularity,
  AnalyticsMetric,
} from '@/types';
import { cn } from '@/lib/utils';
import { formatInferenceCost, formatTokens } from '@/lib/formatters';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  Button,
  CircleOff,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Skeleton,
} from '@/components/system';

const CHART_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-7)',
];

const TOOLTIP_SOURCE_ORDER = [
  'Slack',
  'GitHub',
  'Linear',
  'Web',
  'Automation',
  'System',
];
const TOOLTIP_STATUS_ORDER = ['Closed', 'Draft', 'Open', 'Merged'];

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatAxisValue(value: number, metric: AnalyticsMetric) {
  switch (metric) {
    case 'tokens':
      return formatTokens(value);
    case 'cost':
      return `$${formatInferenceCost(value * 1_000_000)}`;
    case 'tasks':
    default:
      return formatCompactNumber(value);
  }
}

function formatMetricValue(value: number, metric: AnalyticsMetric) {
  switch (metric) {
    case 'tokens':
      return formatTokens(value);
    case 'cost':
      return `$${formatInferenceCost(value * 1_000_000)}`;
    case 'tasks':
    default:
      return String(value);
  }
}

function getSeriesColor(params: { index: number }) {
  return CHART_COLORS[params.index % CHART_COLORS.length];
}

function stopTooltipEventPropagation(event: SyntheticEvent<HTMLElement>) {
  event.stopPropagation();
}

function getTooltipSortOrder(viewBy: AnalyticsDimension) {
  if (viewBy === 'source') {
    return TOOLTIP_SOURCE_ORDER;
  }

  if (viewBy === 'status') {
    return TOOLTIP_STATUS_ORDER;
  }

  return null;
}

function compareTooltipLabels(
  viewBy: AnalyticsDimension,
  left: string,
  right: string,
) {
  const sortOrder = getTooltipSortOrder(viewBy);

  if (sortOrder) {
    const leftIndex = sortOrder.indexOf(left);
    const rightIndex = sortOrder.indexOf(right);

    if (leftIndex !== -1 || rightIndex !== -1) {
      return (
        (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
      );
    }
  }

  return left.localeCompare(right);
}

function AnalyticsChartSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid h-[320px] grid-cols-9 items-end gap-6 md:h-[420px] md:px-8">
        {Array.from({ length: 9 }).map((_, index) => (
          <Skeleton
            key={index}
            className="w-full rounded-t-xl"
            style={{ height: `${42 + (index % 4) * 18}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function AnalyticsEmptyState({ onReset }: { onReset: () => void }) {
  return (
    <Empty className="min-h-[320px] rounded-[24px] bg-background/20 md:min-h-[420px]">
      <EmptyHeader className="max-w-md gap-3">
        <EmptyMedia
          variant="icon"
          className="size-12 rounded-2xl bg-card text-muted-foreground"
        >
          <CircleOff className="size-5" />
        </EmptyMedia>
        <EmptyTitle>No data for this selection</EmptyTitle>
        <EmptyDescription>
          <span className="hidden md:inline">
            Try adjusting the filters to widen your selection.
          </span>
          <span className="md:hidden">Try changing the filters.</span>
        </EmptyDescription>
      </EmptyHeader>
      <Button type="button" variant="outline" onClick={onReset}>
        Reset Filters
      </Button>
    </Empty>
  );
}

function AnalyticsTooltip({
  active,
  hoveredSeriesKey,
  payload,
  label,
  viewBy,
  metric,
}: {
  active?: boolean;
  hoveredSeriesKey: string | null;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  viewBy: AnalyticsDimension;
  metric: AnalyticsMetric;
}) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const items = payload
    .filter((item) => item.value > 0)
    .sort((left, right) => compareTooltipLabels(viewBy, left.name, right.name));
  const total = items.reduce((sum, item) => sum + item.value, 0);

  return (
    <div
      className="min-w-56 max-w-80 rounded-2xl border border-border/80 bg-popover/95 p-3 text-popover-foreground shadow-xl backdrop-blur"
      onClick={stopTooltipEventPropagation}
      onMouseDown={stopTooltipEventPropagation}
      onMouseEnter={stopTooltipEventPropagation}
      onMouseMove={stopTooltipEventPropagation}
      onMouseUp={stopTooltipEventPropagation}
      onPointerDown={stopTooltipEventPropagation}
      onPointerEnter={stopTooltipEventPropagation}
      onPointerMove={stopTooltipEventPropagation}
      onPointerUp={stopTooltipEventPropagation}
    >
      <div className="mb-3 text-sm font-medium text-foreground">{label}</div>
      <div className="space-y-3">
        <div className="max-h-64 space-y-2 overflow-y-auto scroll-thin pr-1">
          {items.map((item) => (
            <div
              key={item.name}
              className={cn(
                'flex items-center justify-between gap-4 text-sm',
                item.name === hoveredSeriesKey &&
                  'font-semibold text-foreground',
              )}
            >
              <div
                className={cn(
                  'flex min-w-0 items-center gap-2 text-muted-foreground',
                  item.name === hoveredSeriesKey && 'text-foreground',
                )}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: item.color }}
                />
                <span className="truncate">{item.name}</span>
              </div>
              <div className="shrink-0 text-right text-foreground">
                <span
                  className={cn(
                    'font-medium',
                    item.name === hoveredSeriesKey && 'font-semibold',
                  )}
                >
                  {formatMetricValue(item.value, metric)}
                </span>
                <span className="ml-2 text-xs text-muted-foreground/90">
                  {Math.round((item.value / total) * 100)}%
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-border/60 pt-2 text-sm">
          <span className="text-muted-foreground">Total</span>
          <span className="font-medium text-foreground">
            {formatMetricValue(total, metric)}
          </span>
        </div>
      </div>
    </div>
  );
}

type AnalyticsStackedBarChartProps = {
  axisLabel: string;
  chart: AnalyticsChartResponse | undefined;
  granularity: AnalyticsGranularity;
  isLoading: boolean;
  isError: boolean;
  onResetFilters: () => void;
  onSelectSegment: (selection: {
    bucketKey: string;
    bucketLabel: string;
    seriesKey: string;
    seriesLabel: string;
  }) => void;
};

export function AnalyticsStackedBarChart({
  axisLabel,
  chart,
  granularity,
  isLoading,
  isError,
  onResetFilters,
  onSelectSegment,
}: AnalyticsStackedBarChartProps) {
  const [hoveredSeriesKey, setHoveredSeriesKey] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const chartData = useMemo(() => {
    if (!chart) {
      return [];
    }

    return chart.buckets.map((bucket) => {
      const entry: Record<string, string | number> = {
        bucketKey: bucket.key,
        label: bucket.label,
        total: bucket.total,
      };

      for (const series of chart.series) {
        entry[series.key] = bucket.segments[series.key] ?? 0;
      }

      return entry;
    });
  }, [chart]);

  const metric = chart?.metric ?? 'tasks';
  const yAxisWidth = isMobile ? 36 : metric === 'cost' ? 72 : 64;
  const chartMargin = {
    top: 8,
    right: 8,
    left: isMobile ? 0 : 12,
    bottom: 0,
  };
  const maxVisibleTicks = isMobile
    ? granularity === 'month' || granularity === 'year'
      ? 6
      : 4
    : granularity === 'month' || granularity === 'year'
      ? 12
      : 8;
  const xAxisInterval =
    chart && chart.buckets.length > maxVisibleTicks
      ? Math.ceil(chart.buckets.length / maxVisibleTicks) - 1
      : 0;
  const xAxisMinTickGap = isMobile ? 20 : 28;

  if (isLoading) {
    return <AnalyticsChartSkeleton />;
  }

  if (isError) {
    return (
      <Empty className="min-h-[320px] rounded-[24px] bg-background/20 md:min-h-[420px]">
        <EmptyHeader>
          <EmptyTitle>Unable to load analytics</EmptyTitle>
          <EmptyDescription>
            Please refresh the page and try again.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (!chart || chart.buckets.length === 0 || chart.series.length === 0) {
    return <AnalyticsEmptyState onReset={onResetFilters} />;
  }

  return (
    <div className="space-y-4">
      <div className="h-[320px] md:h-[420px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            accessibilityLayer={false}
            className="outline-none [&_*:focus]:outline-none [&_*:focus-visible]:outline-none"
            tabIndex={-1}
            margin={chartMargin}
          >
            <CartesianGrid
              vertical={false}
              stroke="var(--color-border)"
              strokeOpacity={0.35}
            />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              interval={xAxisInterval}
              minTickGap={xAxisMinTickGap}
              tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={yAxisWidth}
              tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
              tickFormatter={(value) => formatAxisValue(Number(value), metric)}
              label={
                isMobile
                  ? undefined
                  : {
                      value: axisLabel,
                      angle: -90,
                      position: 'insideLeft',
                      fill: 'var(--color-muted-foreground)',
                      fontSize: 13,
                      fontWeight: 500,
                      dx: 8,
                    }
              }
            />
            <Tooltip
              cursor={{ fill: 'var(--color-muted)', opacity: 0.12 }}
              wrapperStyle={{ pointerEvents: 'auto', outline: 'none' }}
              content={
                <AnalyticsTooltip
                  hoveredSeriesKey={hoveredSeriesKey}
                  viewBy={chart.viewBy}
                  metric={metric}
                />
              }
            />
            {chart.series.map((series, index) => (
              <Bar
                key={series.key}
                dataKey={series.key}
                name={series.label}
                stackId="analytics"
                onMouseOver={() => setHoveredSeriesKey(series.label)}
                onMouseLeave={() => setHoveredSeriesKey(null)}
                onClick={(data) => {
                  const bucketKey =
                    typeof data?.payload?.bucketKey === 'string'
                      ? data.payload.bucketKey
                      : null;
                  const bucketLabel =
                    typeof data?.payload?.label === 'string'
                      ? data.payload.label
                      : '';

                  if (!bucketKey) {
                    return;
                  }

                  onSelectSegment({
                    bucketKey,
                    bucketLabel,
                    seriesKey: series.key,
                    seriesLabel: series.label,
                  });
                }}
                radius={[0, 0, 0, 0]}
                fill={getSeriesColor({
                  index,
                })}
                maxBarSize={64}
                className="cursor-pointer"
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
