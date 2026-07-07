import {
  and,
  asc,
  automationWorkItems,
  db,
  eq,
  inArray,
  sql,
} from '@roomote/db/server';
import { ACTIVE_AUTOMATION_WORK_ITEM_STATUSES } from '@roomote/types';

import { persistedAutomationWorkItemProjection } from './row-projection.js';
import {
  buildAutomationWorkItemsSummaryLockKey,
  type AutomationKey,
} from './source.js';
import type {
  PersistedAutomationWorkItemsResult,
  PersistedDuplicateWorkItemRef,
  PreparedAutomationWorkItem,
} from './types.js';

export async function persistAutomationWorkItems(params: {
  sourceTaskId: string;
  automationKey: AutomationKey;
  backgroundAutomationRunId: string | null;
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
      .from(automationWorkItems)
      .where(eq(automationWorkItems.sourceTaskId, params.sourceTaskId))
      .orderBy(asc(automationWorkItems.sortOrder));

    if (existingWorkItems.length > 0) {
      return {
        created: false,
        duplicateCount: 0,
        duplicateWorkItemRefs: [],
        workItems: existingWorkItems,
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
              id: automationWorkItems.id,
              fingerprint: automationWorkItems.fingerprint,
            })
            .from(automationWorkItems)
            .where(
              and(
                eq(automationWorkItems.automationKey, params.automationKey),
                inArray(automationWorkItems.status, [
                  ...ACTIVE_AUTOMATION_WORK_ITEM_STATUSES,
                ]),
                inArray(automationWorkItems.fingerprint, fingerprints),
              ),
            );
    const duplicateWorkItemRefsByFingerprint = new Map<
      string,
      PersistedDuplicateWorkItemRef[]
    >();

    for (const workItemRef of unorderedDuplicateWorkItemRefs) {
      const existingRefs =
        duplicateWorkItemRefsByFingerprint.get(workItemRef.fingerprint) ?? [];

      existingRefs.push(workItemRef);
      duplicateWorkItemRefsByFingerprint.set(
        workItemRef.fingerprint,
        existingRefs,
      );
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
      .insert(automationWorkItems)
      .values(
        workItemsToInsert.map(
          (workItem, index): typeof automationWorkItems.$inferInsert => ({
            automationKey: params.automationKey,
            sourceTaskId: params.sourceTaskId,
            backgroundAutomationRunId: params.backgroundAutomationRunId,
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
      workItems: insertedWorkItems,
    };
  });
}
