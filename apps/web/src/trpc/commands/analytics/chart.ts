import type { UserAuthSuccess } from '@/types';
import { getAnalyticsChartData } from '@/lib/server';
import type {
  AnalyticsChartResponse,
  AnalyticsDimension,
  AnalyticsFilters,
  AnalyticsGranularity,
  AnalyticsMetric,
  AnalyticsObject,
  TimePeriodFilter,
} from '@/types';

export async function getAnalyticsChartCommand(
  auth: UserAuthSuccess,
  input: {
    object: AnalyticsObject;
    viewBy: AnalyticsDimension;
    metric?: AnalyticsMetric;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
    granularity?: AnalyticsGranularity;
  },
): Promise<AnalyticsChartResponse> {
  return getAnalyticsChartData(auth, input);
}
