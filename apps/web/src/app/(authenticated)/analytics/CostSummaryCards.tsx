'use client';

import {
  ANALYTICS_TIME_RANGE_OPTIONS,
  type AnalyticsCostSummary,
  type TimePeriodFilter,
} from '@/types';

import {
  AnalyticsSummaryCard,
  AnalyticsSummaryCardsGrid,
} from '@/components/system';

function format(value: number | null) {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function formatTimePeriod(timePeriod: TimePeriodFilter) {
  return (
    ANALYTICS_TIME_RANGE_OPTIONS.find((option) => option.value === timePeriod)
      ?.label ?? 'Selected period'
  );
}

export function CostSummaryCards({
  summary,
  timePeriod,
}: {
  summary: AnalyticsCostSummary | undefined;
  timePeriod: TimePeriodFilter;
}) {
  if (!summary) {
    return null;
  }

  const cards: Array<{ label: string; value: string; secondary: string }> = [
    {
      label: 'Total inference cost',
      value: format(summary.totalInferenceCost),
      secondary: formatTimePeriod(timePeriod),
    },
    {
      label: 'Average cost per PR',
      value: format(summary.averageCostPerPr),
      secondary: `Across ${formatCount(summary.prCount)} ${pluralize(summary.prCount, 'PR')}`,
    },
    {
      label: 'Average cost per task',
      value: format(summary.averageCostPerTask),
      secondary: `Across ${formatCount(summary.taskCount)} ${pluralize(summary.taskCount, 'task')}`,
    },
    {
      label: 'Average cost per active user',
      value: format(summary.averageCostPerActiveUser),
      secondary: `Amongst ${formatCount(summary.activeUserCount)} active ${pluralize(summary.activeUserCount, 'user')}`,
    },
  ];

  return (
    <AnalyticsSummaryCardsGrid className="xl:grid-cols-4">
      {cards.map(({ label, value, secondary }) => (
        <AnalyticsSummaryCard
          key={label}
          label={label}
          value={value}
          secondary={secondary}
        />
      ))}
    </AnalyticsSummaryCardsGrid>
  );
}
