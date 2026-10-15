'use server';

import { db, eq, sql, users } from '@roomote/db/server';
import { revalidatePath } from 'next/cache';

import { authorize } from '@/lib/server/auth-context';

import { normalizeSessionFilters } from './filter-preferences';

export async function saveSessionFilterPreferences(
  viewerUserId: string,
  value: unknown,
) {
  const auth = await authorize();
  // A delayed write from a previous account must not update the new account.
  if (!auth.success || auth.userId !== viewerUserId) return;

  const metadata = { session_list_filters_v1: normalizeSessionFilters(value) };
  await db
    .update(users)
    .set({
      metadata: sql`${users.metadata} || ${JSON.stringify(metadata)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, auth.userId));
  revalidatePath('/sessions', 'page');
}
