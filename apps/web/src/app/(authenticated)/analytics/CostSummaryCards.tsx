'use client';

import type { AnalyticsCostSummary } from '@/types';

function format(value: number | null) {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}

export function CostSummaryCards({
  summary,
}: {
  summary: AnalyticsCostSummary | undefined;
}) {
  if (!summary) {
    return null;
  }

  const cards = [
    ['Total inference cost', format(summary.totalInferenceCost)],
    ['Average cost per PR', format(summary.averageCostPerPr)],
    ['Average cost per task', format(summary.averageCostPerTask)],
    ['Average cost per active user', format(summary.averageCostPerActiveUser)],
  ];

  return (
    <div className="grid gap-2 bg-card p-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-border/60 p-4">
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-semibold">{value}</div>
        </div>
      ))}
    </div>
  );
}
