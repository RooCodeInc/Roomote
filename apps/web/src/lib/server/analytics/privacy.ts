import type { UserAuthSuccess } from '@/types';

import { createLabelBackedDimensionValue } from './dimensions';

export const PRIVATE_ANALYTICS_LABEL = 'Private';
export const PRIVATE_SESSION_LABEL = 'Private session';
export const PRIVATE_TASK_LABEL = 'Private task';

export const privateAnalyticsDimensionValue = createLabelBackedDimensionValue(
  PRIVATE_ANALYTICS_LABEL,
);

export function canViewPrivateAnalyticsDetails(
  auth: UserAuthSuccess,
  record: {
    privacy: 'shared' | 'private';
    privateOwnerUserId: string | null;
  },
) {
  return (
    record.privacy === 'shared' || record.privateOwnerUserId === auth.userId
  );
}

export function createPrivateAnalyticsIdMapper(prefix: string) {
  const ids = new Map<string, string>();

  return (id: string) => {
    const existing = ids.get(id);
    if (existing) {
      return existing;
    }

    const redactedId = `${prefix}:${ids.size + 1}`;
    ids.set(id, redactedId);
    return redactedId;
  };
}
