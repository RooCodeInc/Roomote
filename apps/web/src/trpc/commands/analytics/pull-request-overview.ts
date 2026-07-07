import type { UserAuthSuccess } from '@/types';
import { getPullRequestAnalyticsOverview } from '@/lib/server';
import type {
  AnalyticsDimension,
  AnalyticsFilters,
  AnalyticsGranularity,
  PullRequestAnalyticsOverviewResponse,
  TimePeriodFilter,
} from '@/types';

export async function getPullRequestAnalyticsOverviewCommand(
  auth: UserAuthSuccess,
  input: {
    viewBy: AnalyticsDimension;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
    granularity?: AnalyticsGranularity;
  },
): Promise<PullRequestAnalyticsOverviewResponse> {
  return getPullRequestAnalyticsOverview(auth, input);
}
