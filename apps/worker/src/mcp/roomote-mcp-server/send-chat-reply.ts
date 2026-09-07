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
import type { ArtifactConfig, RoomoteConfig, ToolResult } from './types.js';

export async function handleSendChatReply(
  input: {
    taskId: string;
    summary?: string;
    imagePaths?: string[];
    imageArtifactIds?: string[];
  },
  artifactConfig: ArtifactConfig,
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  const summary = normalizeOptionalSlackText(input.summary);
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

    return successResult({
      messageTs: reply.messageTs,
      ...(summary && { summary }),
      ...(uploadedArtifactIds.length > 0 && { uploadedArtifactIds }),
      ...(imageArtifactIds.length > 0 && { imageArtifactIds }),
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
