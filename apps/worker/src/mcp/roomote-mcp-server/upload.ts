import {
  parseArchitectureSnapshot,
  type TaskArtifactType,
} from '@roomote/types';

import {
  deletePreparedLocalArtifact,
  prepareLocalArtifactUpload,
  uploadPreparedArtifact,
} from './local-file-upload.js';
import { errorResult, successResult, catchError } from './tool-result.js';
import type { ArtifactConfig, ToolResult } from './types.js';

type ManageArtifactsUploadType = Extract<
  TaskArtifactType,
  'general' | 'visual-proof' | 'architecture-snapshot'
>;

export async function handleUpload(
  input: {
    path: string;
    taskId: string;
    artifactType: ManageArtifactsUploadType;
    deleteAfterUpload?: boolean;
  },
  config: ArtifactConfig,
): Promise<ToolResult> {
  try {
    if (!config.workspacePath) {
      return errorResult('ROOMOTE_WORKSPACE_PATH not set');
    }

    const preparedArtifact = await prepareLocalArtifactUpload(
      input.path,
      config.workspacePath,
    );
    if (input.artifactType === 'architecture-snapshot') {
      const snapshot = parseArchitectureSnapshot(
        preparedArtifact.content.toString('utf8'),
      );
      if (!snapshot.success) {
        return errorResult(
          `Invalid architecture snapshot: ${snapshot.error.issues[0]?.message ?? 'Invalid contract'}`,
        );
      }
    }
    const result = await uploadPreparedArtifact(config, {
      taskId: input.taskId,
      artifactType: input.artifactType,
      preparedArtifact,
    });
    // Delete the source file after successful upload if requested
    if (input.deleteAfterUpload) {
      await deletePreparedLocalArtifact(preparedArtifact);
    }

    return successResult({
      artifactId: result.artifactId,
      artifactType: result.artifactType,
      version: result.version,
      path: preparedArtifact.artifactPath,
      viewUrl: result.viewUrl,
      ...(result.rawUrl && { rawUrl: result.rawUrl }),
      ...(input.deleteAfterUpload && { deleted: true }),
    });
  } catch (error) {
    return catchError(error);
  }
}
