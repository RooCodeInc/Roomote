import { sendChatMessage } from './chat-api-client.js';
import {
  errorResultWithArtifacts,
  uniqueNonEmpty,
  uploadSlackImagePaths,
} from './slack-post-helpers.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { ArtifactConfig, RoomoteConfig, ToolResult } from './types.js';

export async function handleSendChatMessage(
  input: {
    taskId: string;
    destination: string;
    message: string;
    imagePaths?: string[];
    imageArtifactIds?: string[];
  },
  artifactConfig: ArtifactConfig,
  roomoteConfig: RoomoteConfig,
): Promise<ToolResult> {
  const imagePaths = uniqueNonEmpty(input.imagePaths);
  const existingArtifactIds = uniqueNonEmpty(input.imageArtifactIds);
  if (imagePaths.length > 0 && !artifactConfig.workspacePath) {
    return errorResult('ROOMOTE_WORKSPACE_PATH not set');
  }

  const uploadedArtifactIds: string[] = [];
  try {
    const uploads = await uploadSlackImagePaths({
      taskId: input.taskId,
      imagePaths,
      artifactConfig,
    });
    uploadedArtifactIds.push(...uploads.uploadedArtifactIds);
    const imageArtifactIds = [
      ...existingArtifactIds,
      ...uploads.uploadedArtifactIds,
    ];
    return successResult({
      ...(await sendChatMessage(roomoteConfig, {
        destination: input.destination,
        message: input.message,
        ...(imageArtifactIds.length > 0 ? { imageArtifactIds } : {}),
      })),
      ...(uploadedArtifactIds.length > 0 ? { uploadedArtifactIds } : {}),
      ...(existingArtifactIds.length > 0
        ? { imageArtifactIds: existingArtifactIds }
        : {}),
    });
  } catch (error) {
    if (uploadedArtifactIds.length > 0) {
      return errorResultWithArtifacts(
        error instanceof Error ? error.message : String(error),
        uploadedArtifactIds,
      );
    }
    return catchError(error);
  }
}
