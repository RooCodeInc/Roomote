'use client';

import { getModelProviderLabel, getTaskModelDisplayName } from '@roomote/types';

import type { AnalyticsCostBreakdownRow } from '@/types';

function getTitle(rawValue: string, displayValue: string) {
  return rawValue === displayValue ? undefined : rawValue;
}

export function CostBreakdownTable({
  rows,
}: {
  rows: AnalyticsCostBreakdownRow[] | undefined;
}) {
  if (!rows || rows.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-muted/40 text-left text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Provider</th>
            <th className="px-4 py-3 font-medium">Model</th>
            <th className="px-4 py-3 text-right font-medium">Total cost</th>
            <th className="px-4 py-3 text-right font-medium">Share</th>
            <th className="px-4 py-3 text-right font-medium">Tasks</th>
            <th className="px-4 py-3 text-right font-medium">Avg / task</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const providerLabel = getModelProviderLabel(row.provider);
            const modelLabel = getTaskModelDisplayName(row.model);

            return (
              <tr key={row.key} className="border-t border-border/40">
                <td
                  className="px-4 py-3"
                  title={getTitle(row.provider, providerLabel)}
                >
                  {providerLabel}
                </td>
                <td
                  className="px-4 py-3"
                  title={getTitle(row.model, modelLabel)}
                >
                  {modelLabel}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  ${row.totalCost.toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {row.costShare.toFixed(1)}%
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {row.taskCount}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  ${row.averageCostPerTask.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
