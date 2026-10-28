import {
  backfillBrainMemoryEvents,
  db,
  requeueFailedBrainMemoryEvents,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';

/**
 * Enqueue a memory for every completed run that does not have one.
 * Idempotent by the outbox's unique(runId).
 */
export async function backfillBrainTaskMemoriesCommand(
  auth: UserAuthSuccess,
): Promise<{ queued: number }> {
  assertAdmin(auth);

  return { queued: await backfillBrainMemoryEvents(db) };
}

export async function retryFailedBrainTaskMemoriesCommand(
  auth: UserAuthSuccess,
): Promise<{ requeued: number }> {
  assertAdmin(auth);

  return { requeued: await requeueFailedBrainMemoryEvents(db) };
}
