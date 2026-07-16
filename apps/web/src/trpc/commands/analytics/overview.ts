import type { UserAuthSuccess } from '@/types';
import { getAnalyticsOverview } from '@/lib/server';
import type {
  AnalyticsDimension,
  AnalyticsFilters,
  AnalyticsGranularity,
  AnalyticsMetric,
  AnalyticsObject,
  AnalyticsOverviewResponse,
  TimePeriodFilter,
} from '@/types';

export async function getAnalyticsOverviewCommand(
  auth: UserAuthSuccess,
  input: {
    object: AnalyticsObject;
    viewBy: AnalyticsDimension;
    metric?: AnalyticsMetric;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
    granularity?: AnalyticsGranularity;
  },
): Promise<AnalyticsOverviewResponse> {
  return getAnalyticsOverview(auth, input);
}
