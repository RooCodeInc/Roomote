import { createHash } from 'node:crypto';

import { createClient } from '@roomote/sdk/client';

import { buildApiHeaders } from './api-client.js';
import {
  errorResultWithArtifacts,
  normalizeOptionalSlackText,
  uniqueNonEmpty,
  uploadSlackImagePaths,
  validateSlackPostContent,
} from './slack-post-helpers.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { ArtifactConfig, ToolResult } from './types.js';

export async function handleReportToParentSession(
  input: {
    runId: number;
    taskId: string;
    purpose: 'ack' | 'progress' | 'closeout' | 'clarification';
    message: string;
    imagePaths?: string[];
    imageArtifactIds?: string[];
  },
  artifactConfig: ArtifactConfig,
): Promise<ToolResult> {
  if (!Number.isInteger(input.runId) || input.runId <= 0) {
    return errorResult('ROOMOTE_TASK_RUN_ID environment variable not set');
  }

  const message = normalizeOptionalSlackText(input.message);
  const imagePaths = uniqueNonEmpty(input.imagePaths);
  const imageArtifactIds = uniqueNonEmpty(input.imageArtifactIds);
  const deliverySignature = createHash('sha256')
    .update(
      JSON.stringify({
        runId: input.runId,
        taskId: input.taskId,
        purpose: input.purpose,
        message,
        imagePaths,
        imageArtifactIds,
      }),
    )
    .digest('hex');

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
    const allArtifactIds = [
      ...new Set([...imageArtifactIds, ...uploadedArtifactIds]),
    ];
    const contentValidation = validateSlackPostContent({
      text: message,
      imagePaths,
      imageArtifactIds,
      emptyContentError:
        'At least one of message, imagePaths, or imageArtifactIds is required',
    });
    if (contentValidation) {
      return contentValidation;
    }

    const client = createClient({
      url: artifactConfig.platformApiUrl,
      headers: () => buildApiHeaders(artifactConfig),
    });
    const result = await client.taskRuns.reportToParentSession.mutate({
      runId: input.runId,
      taskId: input.taskId,
      deliverySignature,
      purpose: input.purpose,
      message: message ?? '',
      ...(allArtifactIds.length ? { imageArtifactIds: allArtifactIds } : {}),
    });

    if (!result.relayed) {
      return errorResult('The parent Session could not receive this report.');
    }

    return successResult({
      relayed: true,
      relayId: deliverySignature,
      ...(uploadedArtifactIds.length ? { uploadedArtifactIds } : {}),
      ...(imageArtifactIds.length ? { imageArtifactIds } : {}),
    });
  } catch (error) {
    if (uploadedArtifactIds.length) {
      return errorResultWithArtifacts(
        error instanceof Error ? error.message : String(error),
        uploadedArtifactIds,
      );
    }

    return catchError(error);
  }
}
