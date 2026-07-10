import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import {
  ARTIFACT_TRANSFER_TIMEOUT_MS,
  fetchArtifactMetadata,
  fetchWithTimeout,
  getDownloadUrl,
} from './api-client.js';
import { errorResult, successResult, catchError } from './tool-result.js';
import type { ArtifactConfig, ToolResult } from './types.js';

export async function handleDownload(
  input: { taskId: string; path: string; version?: number },
  config: ArtifactConfig,
): Promise<ToolResult> {
  try {
    const metadata = await fetchArtifactMetadata(config, {
      taskId: input.taskId,
      path: input.path,
      version: input.version,
    });

    if (!metadata.uploaded) {
      return errorResult('Artifact exists but has not been uploaded yet');
    }

    const urlData = await getDownloadUrl(config, metadata.id, metadata.taskId);

    const downloadResponse = await fetchWithTimeout(
      urlData.url,
      {},
      {
        label: 'Failed to download artifact',
        timeoutMs: ARTIFACT_TRANSFER_TIMEOUT_MS,
      },
    );
    if (!downloadResponse.ok) {
      return errorResult(
        `Failed to download from S3: ${downloadResponse.status} ${downloadResponse.statusText}`,
      );
    }

    const arrayBuffer = await downloadResponse.arrayBuffer();
    const contentBuffer = Buffer.from(arrayBuffer);

    const tempDir = await mkdtemp(join(tmpdir(), 'roomote-artifact-'));
    const filename = basename(urlData.path);
    const filePath = join(tempDir, filename);

    await writeFile(filePath, contentBuffer);

    return successResult({ filePath });
  } catch (error) {
    return catchError(error);
  }
}
