import type { UserAuthSuccess } from '@/types';
import { getAnalyticsFilterOptions } from '@/lib/server';
import type {
  AnalyticsFilterOptionsResponse,
  AnalyticsFilters,
  AnalyticsObject,
  TimePeriodFilter,
} from '@/types';

export async function getAnalyticsFiltersCommand(
  auth: UserAuthSuccess,
  input: {
    object: AnalyticsObject;
    filters?: AnalyticsFilters;
    timePeriod?: TimePeriodFilter;
  },
): Promise<AnalyticsFilterOptionsResponse> {
  return getAnalyticsFilterOptions(auth, input);
}
