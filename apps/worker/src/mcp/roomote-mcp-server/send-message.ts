import { CloudTaskType, isLinkedReviewResultsMessage } from '@roomote/types';

import { sendMessageToTask, steerMessageToTask } from './tasks-api-client.js';
import { errorResult, successResult, catchError } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

const REVIEW_HANDOFF_TASK_TYPES = new Set<string>([
  CloudTaskType.GithubPrReview,
  CloudTaskType.GithubPrReviewSync,
]);

function isSkippedLinkedReviewHandoffResult(
  result: unknown,
): result is { skipped: true; reason?: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'skipped' in result &&
    (result as { skipped?: unknown }).skipped === true
  );
}

function isResumedTaskResult(
  result: unknown,
): result is { resumed: true; cloudJobId?: number; taskId?: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'resumed' in result &&
    (result as { resumed?: unknown }).resumed === true
  );
}

function resolveSenderMode(
  message: string,
): 'authenticated_user' | 'linked_review_handoff' | undefined {
  const taskType = process.env.ROOMOTE_TASK_TYPE;

  if (
    taskType &&
    REVIEW_HANDOFF_TASK_TYPES.has(taskType) &&
    isLinkedReviewResultsMessage(message)
  ) {
    return 'linked_review_handoff';
  }

  return undefined;
}

export async function handleSendMessage(
  params: { taskId: string; message: string; images?: string[] },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const senderMode = resolveSenderMode(params.message);
    const result =
      senderMode === 'linked_review_handoff'
        ? await sendMessageToTask(config, params.taskId, {
            message: params.message,
            images: params.images,
            senderMode,
          })
        : await steerMessageToTask(config, params.taskId, {
            message: params.message,
            images: params.images,
          });

    if (!result.success) {
      return errorResult(result.error || 'Failed to send message');
    }

    if (isSkippedLinkedReviewHandoffResult(result.result)) {
      return successResult({
        message:
          result.result.reason ||
          'Linked review handoff was skipped for this task.',
      });
    }

    if (isResumedTaskResult(result.result)) {
      return successResult({
        message: `Task ${result.result.taskId ?? params.taskId} is resuming from snapshot.`,
        ...result.result,
      });
    }

    return successResult({
      message: `Message sent to task ${params.taskId}.`,
    });
  } catch (error) {
    return catchError(error);
  }
}
