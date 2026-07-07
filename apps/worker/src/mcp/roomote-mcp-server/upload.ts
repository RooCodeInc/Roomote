import type { TaskArtifactType } from '@roomote/types';

import {
  deletePreparedLocalArtifact,
  prepareLocalArtifactUpload,
  uploadPreparedArtifact,
} from './local-file-upload.js';
import { replyToChatWithVisualProof } from './chat-proof-auto-post.js';
import { errorResult, successResult, catchError } from './tool-result.js';
import type { ArtifactConfig, RoomoteConfig, ToolResult } from './types.js';

type ManageArtifactsUploadType = Extract<
  TaskArtifactType,
  'general' | 'visual-proof'
>;

export async function handleUpload(
  input: {
    path: string;
    taskId: string;
    artifactType: ManageArtifactsUploadType;
    deleteAfterUpload?: boolean;
  },
  config: ArtifactConfig,
  roomoteConfig?: RoomoteConfig | null,
): Promise<ToolResult> {
  try {
    if (!config.workspacePath) {
      return errorResult('ROOMOTE_WORKSPACE_PATH not set');
    }

    const preparedArtifact = await prepareLocalArtifactUpload(
      input.path,
      config.workspacePath,
    );
    const result = await uploadPreparedArtifact(config, {
      taskId: input.taskId,
      artifactType: input.artifactType,
      preparedArtifact,
    });
    const isImageArtifact = preparedArtifact.contentType.startsWith('image/');
    const slackProofText = isImageArtifact
      ? undefined
      : `[Open artifact](${result.viewUrl})`;
    const slackAutoPosted =
      result.artifactType === 'visual-proof'
        ? await replyToChatWithVisualProof({
            roomoteConfig,
            text: slackProofText,
            imageArtifactIds: isImageArtifact ? [result.artifactId] : [],
            logContext: 'manage_artifacts',
          })
        : undefined;

    // Delete the source file after successful upload if requested
    if (input.deleteAfterUpload) {
      await deletePreparedLocalArtifact(preparedArtifact);
    }

    return successResult({
      artifactId: result.artifactId,
      artifactType: result.artifactType,
      viewUrl: result.viewUrl,
      ...(result.rawUrl && { rawUrl: result.rawUrl }),
      ...(slackAutoPosted !== undefined && { slackAutoPosted }),
      ...(input.deleteAfterUpload && { deleted: true }),
    });
  } catch (error) {
    return catchError(error);
  }
}
