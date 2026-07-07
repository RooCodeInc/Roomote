import type { UserAuthSuccess } from '@/types';
import { getAnalyticsDetails } from '@/lib/server';
import type {
  AnalyticsDetailsResponse,
  AnalyticsDimension,
  AnalyticsFilters,
  AnalyticsGranularity,
  AnalyticsObject,
  TimePeriodFilter,
} from '@/types';

export async function getAnalyticsDetailsCommand(
  auth: UserAuthSuccess,
  input: {
    object: AnalyticsObject;
    viewBy: AnalyticsDimension;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
    granularity?: AnalyticsGranularity;
    bucketKey: string;
    seriesKey: string;
  },
): Promise<AnalyticsDetailsResponse> {
  return getAnalyticsDetails(auth, input);
}
