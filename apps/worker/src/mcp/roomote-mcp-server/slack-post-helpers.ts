import { stripLlmCitationArtifacts } from '@roomote/types';

import {
  prepareLocalArtifactUpload,
  uploadPreparedArtifact,
} from './local-file-upload.js';
import { errorResult } from './tool-result.js';
import type { ArtifactConfig, ToolResult } from './types.js';

export function normalizeOptionalText(text?: string): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeOptionalSlackText(text?: string): string | undefined {
  const normalized = normalizeOptionalText(text);
  if (!normalized) {
    return undefined;
  }

  const stripped = stripLlmCitationArtifacts(normalized).trim();
  return stripped ? stripped : undefined;
}

export function uniqueNonEmpty(values?: string[]): string[] {
  if (!values) {
    return [];
  }

  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function errorResultWithArtifacts(
  message: string,
  uploadedArtifactIds: string[],
): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: message,
          ...(uploadedArtifactIds.length > 0 && { uploadedArtifactIds }),
        }),
      },
    ],
  };
}

export function validateSlackPostContent(params: {
  text?: string;
  imagePaths: string[];
  imageArtifactIds: string[];
  emptyContentError?: string;
}): ToolResult | null {
  if (
    !params.text &&
    params.imagePaths.length === 0 &&
    params.imageArtifactIds.length === 0
  ) {
    return errorResult(
      params.emptyContentError ??
        'At least one of text, imagePaths, or imageArtifactIds is required',
    );
  }

  return null;
}

export async function uploadSlackImagePaths(params: {
  taskId: string;
  imagePaths: string[];
  artifactConfig: ArtifactConfig;
}): Promise<{ uploadedArtifactIds: string[] }> {
  const uploadedArtifactIds: string[] = [];

  for (const imagePath of params.imagePaths) {
    const preparedArtifact = await prepareLocalArtifactUpload(
      imagePath,
      params.artifactConfig.workspacePath!,
    );

    if (!preparedArtifact.contentType.startsWith('image/')) {
      throw new Error(
        `Only image attachments are supported. ${imagePath} resolved to content type ${preparedArtifact.contentType}.`,
      );
    }

    const uploadedArtifact = await uploadPreparedArtifact(
      params.artifactConfig,
      {
        taskId: params.taskId,
        artifactType: 'general',
        preparedArtifact,
      },
    );

    uploadedArtifactIds.push(uploadedArtifact.artifactId);
  }

  return { uploadedArtifactIds };
}
