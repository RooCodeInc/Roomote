import {
  type AnalyticsChartResponse,
  type AnalyticsCostBreakdownRow,
  type AnalyticsCostSummary,
} from '@/types';

import { NO_VALUE_LABEL, type AnalyticsRow } from './types';

export function buildCostChartAnalytics(rows: AnalyticsRow[]): {
  costBreakdown: NonNullable<AnalyticsChartResponse['costBreakdown']>;
  costSummary: NonNullable<AnalyticsChartResponse['costSummary']>;
} {
  const totalCost = rows.reduce((sum, row) => sum + row.value, 0);
  const breakdown = new Map<
    string,
    {
      provider: string;
      model: string;
      cost: number;
      taskCost: number;
      prCost: number;
      tasks: Set<string>;
      prs: Set<string>;
    }
  >();

  for (const row of rows) {
    const provider = row.dimensions.provider?.label ?? 'Unknown provider';
    const model = row.dimensions.model?.label ?? 'Unknown model';
    const key = `${provider}:${model}`;
    const current = breakdown.get(key) ?? {
      provider,
      model,
      cost: 0,
      taskCost: 0,
      prCost: 0,
      tasks: new Set<string>(),
      prs: new Set<string>(),
    };
    current.cost += row.value;
    if (row.meta?.canonicalTaskId) {
      current.tasks.add(row.meta.canonicalTaskId);
      current.taskCost += row.value;
      for (const prKey of row.meta.prKeys ?? []) {
        current.prs.add(prKey);
      }
      if ((row.meta.prKeys ?? []).length > 0) {
        current.prCost += row.value;
      }
    }
    breakdown.set(key, current);
  }

  const costBreakdown = [...breakdown.entries()]
    .map(
      ([key, row]): AnalyticsCostBreakdownRow => ({
        key,
        provider: row.provider,
        model: row.model,
        totalCost: row.cost,
        costShare: totalCost === 0 ? 0 : (row.cost / totalCost) * 100,
        taskCount: row.tasks.size,
        averageCostPerTask:
          row.tasks.size === 0 ? 0 : row.taskCost / row.tasks.size,
        averageCostPerPr: row.prs.size === 0 ? null : row.prCost / row.prs.size,
      }),
    )
    .sort((left, right) => right.totalCost - left.totalCost);

  const taskIds = new Set<string>();
  const qualifyingPrs = new Set<string>();
  let taskCost = 0;
  let prTaskCost = 0;
  for (const row of rows) {
    if (!row.meta?.canonicalTaskId) {
      continue;
    }
    taskIds.add(row.meta.canonicalTaskId);
    taskCost += row.value;
    const prKeys = row.meta.prKeys ?? [];
    if (prKeys.length === 0) {
      continue;
    }
    prTaskCost += row.value;
    for (const prKey of prKeys) {
      qualifyingPrs.add(prKey);
    }
  }
  const userIds = new Set(
    rows
      .map((row) => row.dimensions.user?.key)
      .filter(
        (user): user is string => Boolean(user) && user !== NO_VALUE_LABEL,
      ),
  );
  const summary: AnalyticsCostSummary = {
    totalInferenceCost: totalCost,
    averageCostPerTask: taskIds.size === 0 ? null : taskCost / taskIds.size,
    averageCostPerPr:
      qualifyingPrs.size === 0 ? null : prTaskCost / qualifyingPrs.size,
    averageCostPerActiveUser:
      userIds.size === 0 ? null : totalCost / userIds.size,
    taskCount: taskIds.size,
    prCount: qualifyingPrs.size,
    activeUserCount: userIds.size,
  };
  const costSummary = summary;

  return { costBreakdown, costSummary };
}
