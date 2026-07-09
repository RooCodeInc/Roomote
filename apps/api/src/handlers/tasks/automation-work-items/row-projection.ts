import { workItems } from '@roomote/db/server';

import type { PersistedAutomationWorkItem } from './types.js';

export const persistedAutomationWorkItemProjection = {
  id: workItems.id,
  sourceTaskId: workItems.sourceTaskId,
  title: workItems.title,
  brief: workItems.brief,
  category: workItems.category,
  priority: workItems.priority,
  actionKind: workItems.actionKind,
  disposition: workItems.disposition,
  status: workItems.status,
  investigationContext: workItems.investigationContext,
  executionPrompt: workItems.executionPrompt,
  fingerprint: workItems.fingerprint,
  repositoryIds: workItems.repositoryIds,
  targetRepositoryFullName: workItems.targetRepositoryFullName,
  targetEnvironmentId: workItems.targetEnvironmentId,
  workspaceReadiness: workItems.workspaceReadiness,
  readinessMessage: workItems.readinessMessage,
  sortOrder: workItems.sortOrder,
  launchedTaskId: workItems.launchedTaskId,
  launchError: workItems.launchError,
};

/**
 * Raw shape returned by selecting `persistedAutomationWorkItemProjection` from
 * the merged `work_items` table. Several columns (brief, actionKind,
 * disposition, fingerprint) are schema-nullable because other work-item kinds
 * do not populate them, but auto_fix rows always set them on insert.
 */
type ProjectedAutomationWorkItemRow = {
  id: string;
  sourceTaskId: string | null;
  title: string;
  brief: string | null;
  category: PersistedAutomationWorkItem['category'];
  priority: PersistedAutomationWorkItem['priority'];
  actionKind: string | null;
  disposition: PersistedAutomationWorkItem['disposition'] | null;
  status: PersistedAutomationWorkItem['status'];
  investigationContext: string | null;
  executionPrompt: string | null;
  fingerprint: string | null;
  repositoryIds: string[];
  targetRepositoryFullName: string | null;
  targetEnvironmentId: string | null;
  workspaceReadiness: PersistedAutomationWorkItem['workspaceReadiness'];
  readinessMessage: string | null;
  sortOrder: number;
  launchedTaskId: string | null;
  launchError: string | null;
};

/**
 * Normalize a projected `work_items` row into a `PersistedAutomationWorkItem`.
 * auto_fix rows always carry brief/actionKind/disposition/fingerprint, so the
 * fallbacks below never fire in practice; they only reconcile the merged
 * table's nullable column types with the non-null auto_fix contract.
 */
export function toPersistedAutomationWorkItem(
  row: ProjectedAutomationWorkItemRow,
): PersistedAutomationWorkItem {
  return {
    id: row.id,
    sourceTaskId: row.sourceTaskId,
    title: row.title,
    brief: row.brief ?? '',
    category: row.category,
    priority: row.priority,
    actionKind: row.actionKind ?? '',
    disposition: row.disposition ?? 'act',
    status: row.status,
    investigationContext: row.investigationContext,
    executionPrompt: row.executionPrompt,
    fingerprint: row.fingerprint ?? '',
    repositoryIds: row.repositoryIds,
    targetRepositoryFullName: row.targetRepositoryFullName,
    targetEnvironmentId: row.targetEnvironmentId,
    workspaceReadiness: row.workspaceReadiness,
    readinessMessage: row.readinessMessage,
    sortOrder: row.sortOrder,
    launchedTaskId: row.launchedTaskId,
    launchError: row.launchError,
  };
}
