import { submitAutomationWorkItems } from './tasks-api-client.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';
import type {
  AutomationWorkItemDisposition,
  SuggestionCategory,
  SuggestionPriority,
  WorkspaceReadiness,
} from '@roomote/types';

export async function handleSubmitAutomationWorkItems(
  params: {
    taskId: string;
    workItems: Array<{
      title: string;
      brief: string;
      category?: SuggestionCategory;
      priority?: SuggestionPriority;
      actionKind: string;
      disposition: AutomationWorkItemDisposition;
      investigationContext?: string;
      executionPrompt?: string;
      fingerprint?: string;
      targetRepositoryFullName?: string;
      targetEnvironmentId?: string;
      workspaceReadiness?: WorkspaceReadiness;
      readinessMessage?: string;
    }>;
  },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await submitAutomationWorkItems(config, params.taskId, {
      workItems: params.workItems,
    });

    if (!result.success) {
      return errorResult(
        result.error ?? 'Failed to submit automation work items.',
      );
    }

    return successResult({
      message: `Submitted ${result.workItemCount ?? params.workItems.length} automation work items.`,
      workItemCount: result.workItemCount ?? params.workItems.length,
      actedCount: result.actedCount ?? 0,
      launchedCount: result.launchedCount ?? 0,
      failedCount: result.failedCount ?? 0,
      duplicateCount: result.duplicateCount ?? 0,
    });
  } catch (error) {
    return catchError(error);
  }
}
