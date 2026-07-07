import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

import { VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES } from '@roomote/cloud-agents';
import mime from 'mime-types';

import { resolveWorkspaceOrTmpPath } from './local-file-upload.js';
import { describeVideo } from './tasks-api-client.js';
import { catchError, errorResult, textResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

function resolveMimeType(input: { path: string; mimeType?: string }): string {
  if (input.mimeType?.trim()) {
    return input.mimeType.trim();
  }

  const detectedMimeType = mime.lookup(input.path);
  if (!detectedMimeType) {
    throw new Error(
      'Could not determine mimeType from path. Provide mimeType explicitly.',
    );
  }

  return detectedMimeType;
}

export async function handleDescribeVideo(
  input: { path: string; userTextContext?: string; mimeType?: string },
  config: RoomoteConfig & { workspacePath?: string },
  taskId: string,
): Promise<ToolResult> {
  try {
    if (!config.workspacePath) {
      return errorResult('ROOMOTE_WORKSPACE_PATH not set');
    }

    const filePath = resolveWorkspaceOrTmpPath(
      input.path,
      config.workspacePath,
    );

    await access(filePath, constants.R_OK);

    const fileStats = await stat(filePath);
    if (fileStats.size > VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES) {
      return errorResult(
        `Video exceeds max size of ${VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES} bytes`,
      );
    }

    const mimeType = resolveMimeType(input);
    const videoBytes = await readFile(filePath);

    const result = await describeVideo(config, taskId, {
      videoBytes: videoBytes.toString('base64'),
      mimeType,
      ...(input.userTextContext?.trim()
        ? { userTextContext: input.userTextContext.trim() }
        : {}),
    });

    return textResult(result.description);
  } catch (error) {
    return catchError(error);
  }
}
