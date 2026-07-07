import { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';
import { getTasks } from '@/lib/server';

function isTaskTypeFilterEnabled(auth: UserAuthSuccess): boolean {
  if (auth.featureFlags[FeatureFlag.ShowDebugUISetting] !== true) {
    return false;
  }

  const metadata = (auth.resource as { metadata?: { show_debug_ui?: unknown } })
    .metadata;

  return metadata?.show_debug_ui === true;
}

export async function getTasksCommand(
  auth: UserAuthSuccess,
  input: {
    limit?: number;
    cursor?: string | number;
    filters?: Parameters<typeof getTasks>[0]['filters'];
    timePeriod?: Parameters<typeof getTasks>[0]['timePeriod'];
  },
) {
  const allowTaskTypeFilter = isTaskTypeFilterEnabled(auth);

  // Default to filtering by the current user when no userId filter is provided.
  // A userId filter with value 'all' explicitly opts out of user filtering.
  const filters = input.filters ?? [];
  const userFilter = filters.find((f) => f.type === 'userId');
  const hasCategoryFilter = filters.some((f) => f.type === 'category');

  let effectiveFilters: typeof filters;

  if (!userFilter && !hasCategoryFilter) {
    // No userId filter and no category filter → default to current user.
    effectiveFilters = [
      ...filters,
      { type: 'userId', value: auth.userId, label: auth.userId },
    ];
  } else if (userFilter?.value === 'all') {
    // Explicit 'all' → remove the userId filter (show all users).
    effectiveFilters = filters.filter((f) => f.type !== 'userId');
  } else {
    // Agent filter present (without userId) or explicit userId → pass through.
    effectiveFilters = filters;
  }

  if (!allowTaskTypeFilter) {
    effectiveFilters = effectiveFilters.filter(
      (filter) => filter.type !== 'taskType',
    );
  }

  return getTasks({
    userId: auth.userId,
    isAdmin: auth.isAdmin,
    allowTaskTypeFilter,
    ...input,
    filters: effectiveFilters,
  });
}
