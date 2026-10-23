import { db, eq, users } from '@roomote/db/server';

import { normalizeSessionFilters } from '@/app/(authenticated)/sessions/filter-preferences';

export async function getSessionFilterPreferences(userId: string) {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { metadata: true },
  });
  const metadata = user?.metadata;
  return normalizeSessionFilters(
    metadata &&
      typeof metadata === 'object' &&
      'session_list_filters_v1' in metadata
      ? metadata.session_list_filters_v1
      : undefined,
  );
}
