import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import type { WorkItemStatus } from '@roomote/types';

import { type DatabaseOrTransaction } from '../db';
import { workItems } from '../schema';

/**
 * Shared launch claim/release/finalize helpers for the work_items launch state
 * machine. Every launchable surface (Slack reactions, Telegram buttons,
 * automation act items, web implement, the web setup-new onboarding queue)
 * drives its launch through these so the claim CAS, stale-claim recovery, and
 * launched-guard are identical everywhere. The setup-new onboarding queue is a
 * batch launcher: it claims each queued onboarding item individually and mirrors
 * the launched state back onto the source suggestion through the same helpers.
 *
 * Why one module: stale-claim recovery used to be dead code on some surfaces —
 * a claim requires `open`, but a stale claim is always `launching`, so a crash
 * between claim and finalize left the item permanently unlaunchable. Claiming a
 * stale `launching` here fixes that for all surfaces at once. The
 * `launched_task_id IS NULL` guard additionally blocks relaunch of an item that
 * already produced a task, even if its status is momentarily inconsistent.
 *
 * Fencing token: `claimWorkItem` stamps `launch_claimed_at = now` and returns
 * the claimed row, so the returned `launchClaimedAt` IS the caller's per-claim
 * ownership token. `finalizeWorkItemLaunched` and `releaseWorkItemClaim` require
 * that token and match it in their WHERE guard, so a slow launcher whose stale
 * `launching` claim was reclaimed by a second launcher (reclaims are ≥10 minutes
 * apart, so the timestamps cannot collide) deterministically fails to finalize
 * or release and cannot stomp the new claimant's state. Callers thread the
 * claimed row's `launchClaimedAt` straight through to their finalize/release.
 */
export const WORK_ITEM_LAUNCH_STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * All columns of a work_items row (what the claim CAS returns). `claimWorkItem`
 * always stamps `launch_claimed_at = now`, so on a successful claim that column
 * is guaranteed non-null — the caller's fencing token to thread through
 * finalize/release.
 */
export type ClaimedWorkItem = Omit<
  typeof workItems.$inferSelect,
  'launchClaimedAt'
> & { launchClaimedAt: Date };

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

  // The CAS always sets launch_claimed_at = now, so the returned row's
  // launchClaimedAt is non-null; narrow it into the fencing-token type.
  return (claimed as ClaimedWorkItem | undefined) ?? null;
}

/**
 * Release an in-flight claim back to `open` after a launch failed before the
 * cloud task started, clearing the claim so a later trigger can retry.
 *
 * Guarded on `status = 'launching'` AND `launch_claimed_at = claimedAt` (the
 * fencing token returned by `claimWorkItem`): it never reverts a `launched` item
 * (whose `launched_task_id` is set), which would otherwise risk a double launch,
 * and a slow launcher whose claim was already reclaimed cannot revert the new
 * claimant's `launching` state back to `open`. Returns false when the guard did
 * not match (already launched, or the claim was stolen).
 */
export async function releaseWorkItemClaim(
  tx: DatabaseOrTransaction,
  params: {
    id: string;
    /** The `launchClaimedAt` from the claimed row — the caller's claim token. */
    claimedAt: Date;
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
        eq(workItems.launchClaimedAt, params.claimedAt),
        ...(params.extraConditions ?? []),
      ),
    )
    .returning({ id: workItems.id });

  return Boolean(released);
}

/**
 * Finalize a successful launch: `launching` -> `launched` with the task link.
 *
 * Guarded on `status = 'launching'` AND `launch_claimed_at = claimedAt` (the
 * fencing token returned by `claimWorkItem`) so it is idempotent under a race
 * (returns false when another launcher already finalized) AND so a slow launcher
 * whose claim was reclaimed cannot finalize onto the new claimant's claim. When
 * this returns false after the caller already enqueued a task, that task is
 * orphaned (unlinked from the work item) and the caller must handle it (log
 * loudly and best-effort cancel). Surface-specific side effects (e.g. stamping a
 * Slack thread) stay with the caller. `targetEnvironmentId` is stamped in the
 * same fenced write only when provided (the setup-new onboarding queue records
 * the matched environment at finalize time; other surfaces resolve it earlier
 * and omit it).
 */
export async function finalizeWorkItemLaunched(
  tx: DatabaseOrTransaction,
  params: {
    id: string;
    taskId: string | null;
    /** The `launchClaimedAt` from the claimed row — the caller's claim token. */
    claimedAt: Date;
    /** Clear a prior `launch_error` (automation act items). */
    clearLaunchError?: boolean;
    /** Clear `dismissed_at` (web relaunch of a dismissed suggestion). */
    clearDismissedAt?: boolean;
    /** Stamp the matched environment (setup-new onboarding queue). */
    targetEnvironmentId?: string;
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
      ...(params.targetEnvironmentId
        ? { targetEnvironmentId: params.targetEnvironmentId }
        : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(workItems.id, params.id),
        eq(workItems.status, 'launching'),
        eq(workItems.launchClaimedAt, params.claimedAt),
      ),
    )
    .returning({ id: workItems.id });

  return Boolean(updated);
}
