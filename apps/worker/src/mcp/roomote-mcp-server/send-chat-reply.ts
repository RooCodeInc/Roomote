import { replyToChatThread } from './chat-api-client.js';
import { describeChatDeliveryFailure } from './chat-delivery-error.js';
import {
  errorResultWithArtifacts,
  normalizeOptionalSlackText,
  uniqueNonEmpty,
  uploadSlackImagePaths,
  validateSlackPostContent,
} from './slack-post-helpers.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import {
  submitTaskSuggestions,
  type TaskSuggestionInput,
} from './tasks-api-client.js';
import type { ArtifactConfig, RoomoteConfig, ToolResult } from './types.js';

type ChatReplySurface =
  | 'Slack'
  | 'Teams'
  | 'Telegram'
  | 'Discord'
  | 'email thread'
  | 'chat';

const SUGGESTION_START_INSTRUCTIONS: Record<ChatReplySurface, string> = {
  Slack:
    "Want me to take one of these on? React with a :thumbsup: on a suggested task below and I'll start it.",
  Discord:
    "Want me to take one of these on? React with a 👍 on a suggested task below and I'll start it.",
  Telegram:
    "Want me to take one of these on? React with a 👍 on a suggested task below and I'll start it.",
  Teams:
    "Want me to take one of these on? React with a 👍 on a suggested task below and I'll start it.",
  'email thread':
    "Want me to take one of these on? Reply to this email naming the suggested task and I'll start it.",
  chat: 'Want me to take one of these on? Use the Start action on a suggested task below.',
};

function appendSuggestionStartInstruction(
  summary: string | undefined,
  surface: ChatReplySurface,
  hasSuggestions: boolean,
): string | undefined {
  if (!summary || !hasSuggestions) {
    return summary;
  }

  const instruction = SUGGESTION_START_INSTRUCTIONS[surface];
  if (summary.includes(instruction)) {
    return summary;
  }

  return `${summary}\n\n${instruction}`;
}

export async function handleSendChatReply(
  input: {
    taskId: string;
    summary?: string;
    imagePaths?: string[];
    imageArtifactIds?: string[];
    suggestions?: TaskSuggestionInput[];
    chatReplySurface?: ChatReplySurface;
  },
  artifactConfig: ArtifactConfig,
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  const summary = appendSuggestionStartInstruction(
    normalizeOptionalSlackText(input.summary),
    input.chatReplySurface ?? 'chat',
    Boolean(input.suggestions?.length),
  );
  const imagePaths = uniqueNonEmpty(input.imagePaths);
  const imageArtifactIds = uniqueNonEmpty(input.imageArtifactIds);

  if (imagePaths.length > 0 && !artifactConfig.workspacePath) {
    return errorResult('ROOMOTE_WORKSPACE_PATH not set');
  }

  const uploadedArtifactIds: string[] = [];
  const allArtifactIds = [...imageArtifactIds];
  let reachedDeliveryCall = false;

  try {
    const uploads = await uploadSlackImagePaths({
      taskId: input.taskId,
      imagePaths,
      artifactConfig,
    });
    uploadedArtifactIds.push(...uploads.uploadedArtifactIds);
    allArtifactIds.push(...uploads.uploadedArtifactIds);

    const contentValidation = validateSlackPostContent({
      text: summary,
      imagePaths,
      imageArtifactIds,
      emptyContentError:
        'At least one of message, summary, imagePaths, or imageArtifactIds is required',
    });
    if (contentValidation) {
      return contentValidation;
    }

    reachedDeliveryCall = true;
    const reply = await replyToChatThread(roomoteConfig, {
      ...(summary && { text: summary }),
      ...(allArtifactIds.length > 0 && {
        images: allArtifactIds.map((artifactId) => ({ artifactId })),
      }),
    });

    let suggestionCount: number | undefined;
    let suggestionError: string | undefined;

    if (input.suggestions && input.suggestions.length > 0) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const suggestionResult = await submitTaskSuggestions(
            roomoteConfig,
            input.taskId,
            {
              suggestions: input.suggestions,
              delivery: 'current_thread',
              submissionKey: reply.messageTs,
            },
          );

          if (suggestionResult.success) {
            suggestionCount = suggestionResult.suggestionCount;
            suggestionError = undefined;
            break;
          }

          suggestionError =
            suggestionResult.error ?? 'Failed to post task suggestions.';
        } catch (error) {
          suggestionError =
            error instanceof Error ? error.message : String(error);
        }
      }
    }

    return successResult({
      messageTs: reply.messageTs,
      ...(summary && { summary }),
      ...(uploadedArtifactIds.length > 0 && { uploadedArtifactIds }),
      ...(imageArtifactIds.length > 0 && { imageArtifactIds }),
      ...(suggestionCount !== undefined && { suggestionCount }),
      ...(suggestionError && { suggestionError }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only the thread_reply call itself counts as a delivery attempt; image
    // upload or validation failures say nothing about channel deliverability.
    const deliveryFailureFields = reachedDeliveryCall
      ? { deliveryFailure: describeChatDeliveryFailure(error) }
      : undefined;

    if (uploadedArtifactIds.length > 0) {
      return errorResultWithArtifacts(
        message,
        uploadedArtifactIds,
        deliveryFailureFields,
      );
    }

    if (deliveryFailureFields) {
      return errorResult(message, deliveryFailureFields);
    }

    return catchError(error);
  }
}
