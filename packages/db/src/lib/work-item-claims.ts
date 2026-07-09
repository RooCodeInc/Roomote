import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import type { WorkItemStatus } from '@roomote/types';

import { type DatabaseOrTransaction } from '../db';
import { workItems } from '../schema';

/**
 * Shared launch claim/release/finalize helpers for the work_items launch state
 * machine. Every launchable surface (Slack reactions, Telegram buttons,
 * automation act items, web implement) drives its single-item launch through
 * these so the claim CAS, stale-claim recovery, and launched-guard are
 * identical everywhere.
 *
 * Why one module: stale-claim recovery used to be dead code on some surfaces —
 * a claim requires `open`, but a stale claim is always `launching`, so a crash
 * between claim and finalize left the item permanently unlaunchable. Claiming a
 * stale `launching` here fixes that for all surfaces at once. The
 * `launched_task_id IS NULL` guard additionally blocks relaunch of an item that
 * already produced a task, even if its status is momentarily inconsistent.
 */
export const WORK_ITEM_LAUNCH_STALE_CLAIM_MS = 10 * 60 * 1000;

/** All columns of a work_items row (what the claim CAS returns). */
export type ClaimedWorkItem = typeof workItems.$inferSelect;

/**
 * CAS a work item from a claimable state into `launching`, stamping the claim.
 *
 * Claimable when `launched_task_id IS NULL` AND either:
 * - status = `open`, or
 * - status is one of `additionalClaimableStatuses` (e.g. `dismissed` for the
 *   web implement surface, which relaunches dismissed suggestions), or
 * - status = `launching` but the existing claim is older than `staleClaimMs`
 *   (crash recovery).
 *
 * `failed` is intentionally never claimable: an automation launch that failed
 * terminally stays terminal by design.
 *
 * Returns the updated row, or null when nothing was claimable (another launcher
 * won, or the item is already launched/failed with a fresh claim).
 */
export async function claimWorkItem(
  tx: DatabaseOrTransaction,
  params: {
    id: string;
    staleClaimMs?: number;
    /** Extra statuses to treat as claimable (e.g. ['dismissed']). */
    additionalClaimableStatuses?: readonly WorkItemStatus[];
    /** Extra predicates ANDed into the CAS (e.g. eq(kind, 'suggestion')). */
    extraConditions?: readonly SQLWrapper[];
  },
): Promise<ClaimedWorkItem | null> {
  const now = new Date();
  const staleClaimThreshold = new Date(
    now.getTime() - (params.staleClaimMs ?? WORK_ITEM_LAUNCH_STALE_CLAIM_MS),
  );

  const claimableStatusPredicates = [
    eq(workItems.status, 'open'),
    ...(params.additionalClaimableStatuses &&
    params.additionalClaimableStatuses.length > 0
      ? [inArray(workItems.status, [...params.additionalClaimableStatuses])]
      : []),
    and(
      eq(workItems.status, 'launching'),
      lte(workItems.launchClaimedAt, staleClaimThreshold),
    ),
  ];

  const [claimed] = await tx
    .update(workItems)
    .set({ status: 'launching', launchClaimedAt: now, updatedAt: now })
    .where(
      and(
        eq(workItems.id, params.id),
        isNull(workItems.launchedTaskId),
        or(...claimableStatusPredicates),
        ...(params.extraConditions ?? []),
      ),
    )
    .returning();

  return claimed ?? null;
}

/**
 * Release an in-flight claim back to `open` after a launch failed before the
 * cloud task started, clearing the claim so a later trigger can retry.
 *
 * Guarded on `status = 'launching'`: it never reverts a `launched` item (whose
 * `launched_task_id` is set), which would otherwise risk a double launch.
 */
export async function releaseWorkItemClaim(
  tx: DatabaseOrTransaction,
  params: {
    id: string;
    /** Also clear `dismissed_at` (web surface releases to a clean `open`). */
    clearDismissedAt?: boolean;
    /** Extra predicates ANDed into the guard. */
    extraConditions?: readonly SQLWrapper[];
  },
): Promise<boolean> {
  const now = new Date();
  const [released] = await tx
    .update(workItems)
    .set({
      status: 'open',
      launchClaimedAt: null,
      ...(params.clearDismissedAt ? { dismissedAt: null } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(workItems.id, params.id),
        eq(workItems.status, 'launching'),
        ...(params.extraConditions ?? []),
      ),
    )
    .returning({ id: workItems.id });

  return Boolean(released);
}

/**
 * Finalize a successful launch: `launching` -> `launched` with the task link.
 *
 * Guarded on `status = 'launching'` so it is idempotent under a race (returns
 * false when another launcher already finalized). Surface-specific side effects
 * (e.g. stamping a Slack thread) stay with the caller.
 */
export async function finalizeWorkItemLaunched(
  tx: DatabaseOrTransaction,
  params: {
    id: string;
    taskId: string | null;
    /** Clear a prior `launch_error` (automation act items). */
    clearLaunchError?: boolean;
    /** Clear `dismissed_at` (web relaunch of a dismissed suggestion). */
    clearDismissedAt?: boolean;
  },
): Promise<boolean> {
  const now = new Date();
  const [updated] = await tx
    .update(workItems)
    .set({
      status: 'launched',
      launchedTaskId: params.taskId,
      launchedAt: now,
      launchClaimedAt: null,
      ...(params.clearLaunchError ? { launchError: null } : {}),
      ...(params.clearDismissedAt ? { dismissedAt: null } : {}),
      updatedAt: now,
    })
    .where(and(eq(workItems.id, params.id), eq(workItems.status, 'launching')))
    .returning({ id: workItems.id });

  return Boolean(updated);
}
