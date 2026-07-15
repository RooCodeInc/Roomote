'use client';

import type { AnalyticsCostBreakdownRow } from '@/types';

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
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border/40">
              <td className="px-4 py-3">{row.provider}</td>
              <td className="px-4 py-3">{row.model}</td>
              <td className="px-4 py-3 text-right">
                ${row.totalCost.toFixed(2)}
              </td>
              <td className="px-4 py-3 text-right">
                {row.costShare.toFixed(1)}%
              </td>
              <td className="px-4 py-3 text-right">{row.taskCount}</td>
              <td className="px-4 py-3 text-right">
                ${row.averageCostPerTask.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
