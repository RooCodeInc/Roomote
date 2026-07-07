import { automationWorkItems } from '@roomote/db/server';

export const persistedAutomationWorkItemProjection = {
  id: automationWorkItems.id,
  sourceTaskId: automationWorkItems.sourceTaskId,
  title: automationWorkItems.title,
  brief: automationWorkItems.brief,
  category: automationWorkItems.category,
  priority: automationWorkItems.priority,
  actionKind: automationWorkItems.actionKind,
  disposition: automationWorkItems.disposition,
  status: automationWorkItems.status,
  investigationContext: automationWorkItems.investigationContext,
  executionPrompt: automationWorkItems.executionPrompt,
  fingerprint: automationWorkItems.fingerprint,
  repositoryIds: automationWorkItems.repositoryIds,
  targetRepositoryFullName: automationWorkItems.targetRepositoryFullName,
  targetEnvironmentId: automationWorkItems.targetEnvironmentId,
  workspaceReadiness: automationWorkItems.workspaceReadiness,
  readinessMessage: automationWorkItems.readinessMessage,
  sortOrder: automationWorkItems.sortOrder,
  executionTaskId: automationWorkItems.executionTaskId,
  launchError: automationWorkItems.launchError,
};
