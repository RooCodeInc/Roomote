import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

import { uploadArtifact } from './api-client.js';
import { slugify } from './slugify.js';
import { successResult, catchError } from './tool-result.js';
import type { ArtifactConfig, ToolResult } from './types.js';

export async function handleCreatePlan(
  input: { title: string; content: string; taskId: string },
  config: ArtifactConfig,
): Promise<ToolResult> {
  try {
    const path = `plans/${slugify(input.title)}.md`;
    const contentBuffer = Buffer.from(input.content, 'utf-8');

    const result = await uploadArtifact(config, {
      taskId: input.taskId,
      path,
      artifactType: 'plan',
      contentType: 'text/markdown',
      content: contentBuffer,
    });

    // Best-effort local write
    try {
      if (config.workspacePath) {
        const fullPath = resolve(config.workspacePath, path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, input.content, 'utf-8');
      }
    } catch {
      // Non-fatal: local write failure doesn't affect the artifact
    }

    return successResult({
      artifactId: result.artifactId,
      artifactType: result.artifactType,
      version: result.version,
      path,
      viewUrl: result.viewUrl,
    });
  } catch (error) {
    return catchError(error);
  }
}
