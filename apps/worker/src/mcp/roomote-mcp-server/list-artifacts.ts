import type { TaskArtifactType } from '@roomote/types';

import { listArtifacts } from './api-client.js';
import { successResult, catchError } from './tool-result.js';
import type { ArtifactConfig, ToolResult } from './types.js';

export async function handleListArtifacts(
  input: { taskId: string; artifactType?: TaskArtifactType },
  config: ArtifactConfig,
): Promise<ToolResult> {
  try {
    const result = await listArtifacts(config, {
      taskId: input.taskId,
      artifactType: input.artifactType,
    });

    return successResult({
      taskId: result.taskId,
      artifactCount: result.artifacts.length,
      artifacts: result.artifacts,
    });
  } catch (error) {
    return catchError(error);
  }
}
