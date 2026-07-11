import type { UserAuthSuccess } from '@/types';
import { getAnalyticsExportData } from '@/lib/server';
import type {
  AnalyticsDimension,
  AnalyticsExportResponse,
  AnalyticsFilters,
  AnalyticsGranularity,
  AnalyticsMetric,
  AnalyticsObject,
  TimePeriodFilter,
} from '@/types';

export async function exportAnalyticsCommand(
  auth: UserAuthSuccess,
  input: {
    object: AnalyticsObject;
    viewBy: AnalyticsDimension;
    metric?: AnalyticsMetric;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
    granularity?: AnalyticsGranularity;
  },
): Promise<AnalyticsExportResponse> {
  return getAnalyticsExportData(auth, input);
}
