import { submitTaskSuggestions } from './tasks-api-client.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';
import type {
  SuggestionCategory,
  SuggestionPriority,
  WorkspaceReadiness,
} from '@roomote/types';

export async function handleSubmitTaskSuggestions(
  params: {
    taskId: string;
    suggestions: Array<{
      title: string;
      brief: string;
      category?: SuggestionCategory;
      priority?: SuggestionPriority;
      investigationContext?: string;
      targetRepositoryFullName?: string;
      targetEnvironmentId?: string;
      workspaceReadiness?: WorkspaceReadiness;
      readinessMessage?: string;
    }>;
  },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await submitTaskSuggestions(config, params.taskId, {
      suggestions: params.suggestions,
    });

    if (!result.success) {
      return errorResult(result.error ?? 'Failed to submit task suggestions.');
    }

    return successResult({
      message: `Submitted ${result.suggestionCount ?? params.suggestions.length} task suggestions.`,
      suggestionCount: result.suggestionCount ?? params.suggestions.length,
    });
  } catch (error) {
    return catchError(error);
  }
}
