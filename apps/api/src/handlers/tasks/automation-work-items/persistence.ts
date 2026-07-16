import {
  and,
  asc,
  db,
  eq,
  inArray,
  isNull,
  sql,
  workItems,
} from '@roomote/db/server';
import { WORK_ITEM_ACTIVE_STATUSES } from '@roomote/types';

import {
  persistedAutomationWorkItemProjection,
  toPersistedAutomationWorkItem,
} from './row-projection.js';
import {
  buildAutomationWorkItemsSummaryLockKey,
  type AutomationKey,
} from './source.js';
import type {
  PersistedAutomationWorkItemsResult,
  PersistedDuplicateWorkItemRef,
  PreparedAutomationWorkItem,
} from './types.js';

/**
 * Loads fingerprint-duplicate work items that are still waiting for a launch:
 * `open` (or `launching`, whose staleness the launch claim CAS arbitrates)
 * with no linked task. A transient launch failure reopens its work item, and
 * the reopened row blocks re-insertion as an active fingerprint duplicate —
 * so the scan that reported the same finding must relaunch it, or the item
 * strands indefinitely.
 */
export async function loadRelaunchableDuplicateWorkItems(
  ids: string[],
): Promise<PersistedAutomationWorkItemsResult['workItems']> {
  if (ids.length === 0) {
    return [];
  }

  const rows = await db
    .select(persistedAutomationWorkItemProjection)
    .from(workItems)
    .where(
      and(
        inArray(workItems.id, ids),
        eq(workItems.kind, 'auto_fix'),
        inArray(workItems.status, ['open', 'launching']),
        isNull(workItems.launchedTaskId),
      ),
    )
    .orderBy(asc(workItems.sortOrder));

  return rows.map(toPersistedAutomationWorkItem);
}

export async function persistAutomationWorkItems(params: {
  sourceTaskId: string;
  automationKey: AutomationKey;
  preparedWorkItems: PreparedAutomationWorkItem[];
  repositoryIds: string[];
}): Promise<PersistedAutomationWorkItemsResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${buildAutomationWorkItemsSummaryLockKey(
        {
          sourceTaskId: params.sourceTaskId,
        },
      )}))`,
    );

    const existingWorkItems = await tx
      .select(persistedAutomationWorkItemProjection)
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, 'auto_fix'),
          eq(workItems.sourceTaskId, params.sourceTaskId),
        ),
      )
      .orderBy(asc(workItems.sortOrder));

    if (existingWorkItems.length > 0) {
      return {
        created: false,
        duplicateCount: 0,
        duplicateWorkItemRefs: [],
        workItems: existingWorkItems.map(toPersistedAutomationWorkItem),
      };
    }

    const fingerprints = [
      ...new Set(params.preparedWorkItems.map((item) => item.fingerprint)),
    ];
    const unorderedDuplicateWorkItemRefs =
      fingerprints.length === 0
        ? ([] as PersistedDuplicateWorkItemRef[])
        : await tx
            .select({
              id: workItems.id,
              fingerprint: workItems.fingerprint,
            })
            .from(workItems)
            .where(
              and(
                eq(workItems.kind, 'auto_fix'),
                eq(workItems.automationKey, params.automationKey),
                inArray(workItems.status, [...WORK_ITEM_ACTIVE_STATUSES]),
                inArray(workItems.fingerprint, fingerprints),
              ),
            );
    const duplicateWorkItemRefsByFingerprint = new Map<
      string,
      PersistedDuplicateWorkItemRef[]
    >();

    for (const workItemRef of unorderedDuplicateWorkItemRefs) {
      // The WHERE clause filters on a non-null fingerprint set, so matched
      // rows always carry a fingerprint despite the column being nullable.
      if (workItemRef.fingerprint === null) {
        continue;
      }

      const ref: PersistedDuplicateWorkItemRef = {
        id: workItemRef.id,
        fingerprint: workItemRef.fingerprint,
      };
      const existingRefs =
        duplicateWorkItemRefsByFingerprint.get(ref.fingerprint) ?? [];

      existingRefs.push(ref);
      duplicateWorkItemRefsByFingerprint.set(ref.fingerprint, existingRefs);
    }

    const duplicateWorkItemRefs = fingerprints.flatMap(
      (fingerprint) =>
        duplicateWorkItemRefsByFingerprint.get(fingerprint) ?? [],
    );
    const existingFingerprints = new Set(
      duplicateWorkItemRefs.map((row) => row.fingerprint),
    );

    const workItemsToInsert = params.preparedWorkItems.filter(
      (item) => !existingFingerprints.has(item.fingerprint),
    );

    if (workItemsToInsert.length === 0) {
      return {
        created: true,
        duplicateCount: params.preparedWorkItems.length,
        duplicateWorkItemRefs,
        workItems: [],
      };
    }

    const insertedWorkItems = await tx
      .insert(workItems)
      .values(
        workItemsToInsert.map(
          (workItem, index): typeof workItems.$inferInsert => ({
            kind: 'auto_fix',
            automationKey: params.automationKey,
            sourceTaskId: params.sourceTaskId,
            title: workItem.title,
            brief: workItem.brief,
            category: workItem.category,
            priority: workItem.priority,
            actionKind: workItem.actionKind,
            disposition: workItem.disposition,
            status: 'open',
            fingerprint: workItem.fingerprint,
            executionPrompt: workItem.executionPrompt,
            investigationContext: workItem.investigationContext,
            repositoryIds: params.repositoryIds,
            targetRepositoryFullName: workItem.targetRepositoryFullName,
            targetEnvironmentId: workItem.targetEnvironmentId,
            workspaceReadiness: workItem.workspaceReadiness,
            readinessMessage: workItem.readinessMessage,
            sortOrder: index,
          }),
        ),
      )
      .returning(persistedAutomationWorkItemProjection);

    return {
      created: true,
      duplicateCount:
        params.preparedWorkItems.length - insertedWorkItems.length,
      duplicateWorkItemRefs,
      workItems: insertedWorkItems.map(toPersistedAutomationWorkItem),
    };
  });
}
